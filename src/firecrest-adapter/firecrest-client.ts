/**
 * Low-level HTTP client for FirecREST.
 *
 * Uses Node.js built-in `fetch` (available in Node 22, no external
 * dependency). All requests carry a JWT Bearer token from the
 * JwtTokenProvider (F-INV-2). Synchronous calls have a configurable
 * timeout via AbortController (F-INV-3, FM-F-1).
 *
 * Error handling:
 * - 401: refresh token via JwtTokenProvider.refreshToken(), retry
 *   once (FM-F-2). If refresh fails or 401 persists, throw
 *   FirecrestUnauthorized.
 * - 429: honor Retry-After header or apply exponential backoff
 *   (FM-F-3).
 * - 503: retry with exponential backoff (FM-F-4).
 * - 500: retry with backoff; classify as FirecrestSshError if the
 *   response body mentions "ssh" (FM-F-5).
 * - 404: throw FirecrestSystemNotFound if the response body mentions
 *   the configured system name (FM-F-7). Otherwise, return the
 *   response so callers can handle resource-level 404s.
 *
 * Spec: specs/firecrest/api-contracts.md (FirecrestClient);
 * specs/firecrest/invariants.md F-INV-2, F-INV-3;
 * specs/firecrest/failure-modes.md FM-F-1 through FM-F-7;
 * ADR-011.
 */

import type {
  FirecrestClient,
  FirecrestConfig,
  FirecrestResponse,
} from './types';
import {
  FirecrestTimeout,
  FirecrestUnauthorized,
  FirecrestRateLimited,
  FirecrestUnavailable,
  FirecrestSshError,
  FirecrestSystemNotFound,
} from './types';

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_REQUEST_TIMEOUT_MS = 6000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 1000;
const DEFAULT_RETRY_BACKOFF_MULTIPLIER = 2;
const DEFAULT_MAX_FILE_SYNCHRONOUS_BYTES = 5_000_000;
const DEFAULT_TRANSFER_METHOD = 'streamer' as const;

// ============================================================================
// FirecrestClientImpl
// ============================================================================

/**
 * Low-level HTTP client for FirecREST, implementing the FirecrestClient
 * interface with JWT authentication, timeout, and retry logic.
 *
 * Spec: specs/firecrest/api-contracts.md; ADR-011.
 */
export class FirecrestClientImpl implements FirecrestClient {
  #firecrestUrl: string;
  #systemName: string;
  #tokenProvider: FirecrestConfig['tokenProvider'];
  #requestTimeoutMs: number;
  #maxRetries: number;
  #retryInitialDelayMs: number;
  #retryBackoffMultiplier: number;
  #maxFileSynchronousBytes: number;
  #transferMethod: 's3' | 'streamer' | 'wormhole';

  constructor(config: FirecrestConfig) {
    this.#firecrestUrl = config.firecrestUrl.replace(/\/$/, '');
    this.#systemName = config.systemName;
    this.#tokenProvider = config.tokenProvider;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#retryInitialDelayMs = config.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
    this.#retryBackoffMultiplier = config.retryBackoffMultiplier ?? DEFAULT_RETRY_BACKOFF_MULTIPLIER;
    this.#maxFileSynchronousBytes = config.maxFileSynchronousBytes ?? DEFAULT_MAX_FILE_SYNCHRONOUS_BYTES;
    this.#transferMethod = config.transferMethod ?? DEFAULT_TRANSFER_METHOD;
  }

  // ========================================================================
  // Public properties (read-only, for use by adapters)
  // ========================================================================

  /** The configured system name (e.g., "daint"). */
  get systemName(): string {
    return this.#systemName;
  }

  /** The maximum file size for synchronous transfer (bytes). */
  get maxFileSynchronousBytes(): number {
    return this.#maxFileSynchronousBytes;
  }

  /** The transfer method for large files. */
  get transferMethod(): 's3' | 'streamer' | 'wormhole' {
    return this.#transferMethod;
  }

  /** The FirecREST server URL (without trailing slash). */
  get firecrestUrl(): string {
    return this.#firecrestUrl;
  }

  // ========================================================================
  // Public methods: get, post, put, delete
  // ========================================================================

  async get<T>(path: string): Promise<FirecrestResponse<T>> {
    const response = await this.#request('GET', path);
    const body = await this.#parseBody<T>(response);
    return { statusCode: response.status, body };
  }

  async post<T>(path: string, body?: unknown): Promise<FirecrestResponse<T>> {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const response = await this.#request('POST', path, bodyStr, 'application/json');
    const parsed = await this.#parseBody<T>(response);
    return { statusCode: response.status, body: parsed };
  }

  async put<T>(path: string, body?: unknown): Promise<FirecrestResponse<T>> {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const response = await this.#request('PUT', path, bodyStr, 'application/json');
    const parsed = await this.#parseBody<T>(response);
    return { statusCode: response.status, body: parsed };
  }

  async delete<T>(path: string): Promise<FirecrestResponse<T>> {
    const response = await this.#request('DELETE', path);
    const body = await this.#parseBody<T>(response);
    return { statusCode: response.status, body };
  }

  // ========================================================================
  // Public methods: download, upload
  // ========================================================================

  async download(path: string): Promise<Buffer> {
    const response = await this.#request('GET', path);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Download failed with status ${response.status}: ${text}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async upload(path: string, data: Buffer): Promise<void> {
    const response = await this.#request('POST', path, data, 'application/octet-stream');
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Upload failed with status ${response.status}: ${text}`);
    }
  }

  // ========================================================================
  // Private: request with retry logic
  // ========================================================================

  /**
   * Makes an HTTP request to FirecREST with JWT authentication,
   * timeout, and retry logic.
   *
   * - 200-299: returns the Response
   * - 401: refreshes token and retries once (FM-F-2)
   * - 404: checks if system not found (FM-F-7), otherwise returns
   *   the Response so callers can handle resource-level 404s
   * - 429: honors Retry-After or exponential backoff (FM-F-3)
   * - 503: retries with exponential backoff (FM-F-4)
   * - 500: retries with backoff, SSH error classification (FM-F-5)
   * - Timeout (AbortError): retries with backoff (FM-F-1)
   * - Other 4xx: returns the Response (not retryable)
   *
   * @throws {FirecrestUnauthorized} on 401 after refresh fails or persists
   * @throws {FirecrestSystemNotFound} on 404 for system
   * @throws {FirecrestRateLimited} on 429 after all retries
   * @throws {FirecrestUnavailable} on 503 after all retries
   * @throws {FirecrestSshError} on 500 with SSH error after all retries
   * @throws {FirecrestTimeout} on timeout after all retries
   */
  async #request(
    method: string,
    path: string,
    body?: Buffer | string,
    contentType?: string,
  ): Promise<Response> {
    let retryCount = 0;
    let refreshedToken = false;
    let lastStatusCode = 0;
    let lastBodyText = '';
    let lastSshError = false;
    let lastRetryAfterMs: number | null = null;

    while (true) {
      // Sleep before retry (except for the first attempt and 401 refresh)
      if (retryCount > 0 && lastStatusCode !== 401) {
        const delay = lastRetryAfterMs ?? this.#calculateBackoff(retryCount - 1);
        lastRetryAfterMs = null;
        await this.#sleep(delay);
      }

      const token = await this.#tokenProvider.getToken();
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), this.#requestTimeoutMs);

      let response: Response;
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${token}`,
        };
        if (contentType !== undefined) {
          headers['content-type'] = contentType;
        }

        response = await fetch(this.#firecrestUrl + path, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeoutHandle);

        // Re-throw FirecrestErrors (shouldn't happen here, but safe)
        if (error instanceof FirecrestTimeout ||
            error instanceof FirecrestUnauthorized ||
            error instanceof FirecrestRateLimited ||
            error instanceof FirecrestUnavailable ||
            error instanceof FirecrestSshError ||
            error instanceof FirecrestSystemNotFound) {
          throw error;
        }

        // Timeout (AbortError) or network error
        lastStatusCode = 0;
        if (retryCount >= this.#maxRetries) {
          throw new FirecrestTimeout({ path, elapsed: this.#requestTimeoutMs });
        }
        retryCount++;
        continue;
      }

      clearTimeout(timeoutHandle);

      // Success (200-299)
      if (response.status >= 200 && response.status < 300) {
        return response;
      }

      // 401 — refresh token and retry once (FM-F-2)
      if (response.status === 401) {
        if (refreshedToken) {
          throw new FirecrestUnauthorized({
            message: await response.text().catch(() => '401 Unauthorized'),
          });
        }
        try {
          await this.#tokenProvider.refreshToken();
        } catch {
          throw new FirecrestUnauthorized({
            message: 'Token refresh failed — credentials may be revoked',
          });
        }
        refreshedToken = true;
        lastStatusCode = 401;
        // Don't increment retryCount, don't sleep — retry immediately
        continue;
      }

      // 404 — check if system not found (FM-F-7)
      if (response.status === 404) {
        const cloned = response.clone();
        const text = await cloned.text().catch(() => '');
        if (this.#isSystemNotFound(text)) {
          throw new FirecrestSystemNotFound({ systemName: this.#systemName });
        }
        // Not a system-level 404 — return the response
        return response;
      }

      // 429 — honor Retry-After or exponential backoff (FM-F-3)
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter !== null) {
          lastRetryAfterMs = this.#parseRetryAfter(retryAfter);
        }
        lastBodyText = await response.text().catch(() => '');
        lastStatusCode = 429;
        if (retryCount >= this.#maxRetries) {
          throw new FirecrestRateLimited({
            retryAfterMs: lastRetryAfterMs ?? undefined,
          });
        }
        retryCount++;
        continue;
      }

      // 503 — exponential backoff (FM-F-4)
      if (response.status === 503) {
        lastBodyText = await response.text().catch(() => '');
        lastStatusCode = 503;
        if (retryCount >= this.#maxRetries) {
          throw new FirecrestUnavailable({ message: lastBodyText });
        }
        retryCount++;
        continue;
      }

      // 500 — backoff, SSH error classification (FM-F-5)
      if (response.status === 500) {
        lastBodyText = await response.text().catch(() => '');
        if (lastBodyText.toLowerCase().includes('ssh')) {
          lastSshError = true;
        }
        lastStatusCode = 500;
        if (retryCount >= this.#maxRetries) {
          if (lastSshError) {
            throw new FirecrestSshError({ message: lastBodyText });
          }
          throw new Error(
            `FirecREST returned 500 after ${this.#maxRetries} retries: ${lastBodyText}`,
          );
        }
        retryCount++;
        continue;
      }

      // Other 4xx — return response (not retryable)
      return response;
    }
  }

  // ========================================================================
  // Private: helpers
  // ========================================================================

  /**
   * Parses the response body as JSON, falling back to text or empty
   * object for non-JSON or empty responses.
   */
  async #parseBody<T>(response: Response): Promise<T> {
    const text = await response.text().catch(() => '');
    if (text.length === 0) {
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /**
   * Checks if a 404 response body indicates the system is not found
   * (FM-F-7). The heuristic: if the body text contains the configured
   * system name, it is likely a system-level 404.
   */
  #isSystemNotFound(bodyText: string): boolean {
    return bodyText
      .toLowerCase()
      .includes(this.#systemName.toLowerCase());
  }

  /**
   * Parses the Retry-After header value. The header can be:
   * - A number of seconds (e.g., "120")
   * - An HTTP date (e.g., "Wed, 21 Oct 2026 07:28:00 GMT")
   *
   * Returns the delay in milliseconds, or null if parsing fails.
   */
  #parseRetryAfter(value: string): number | null {
    // Try parsing as seconds
    const seconds = Number.parseInt(value, 10);
    if (!Number.isNaN(seconds)) {
      return seconds * 1000;
    }
    // Try parsing as HTTP date
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - Date.now());
    }
    return null;
  }

  /**
   * Calculates the exponential backoff delay for a given attempt
   * (0-indexed).
   */
  #calculateBackoff(attempt: number): number {
    return this.#retryInitialDelayMs *
      Math.pow(this.#retryBackoffMultiplier, attempt);
  }

  /**
   * Returns a Promise that resolves after the given delay (ms).
   */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
