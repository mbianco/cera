/**
 * Tests for the FirecREST low-level HTTP client.
 *
 * Verifies:
 * - GET, POST, PUT, DELETE with JWT in Authorization header (F-INV-2)
 * - 401 → refresh token + retry (FM-F-2)
 * - 429 → Retry-After header honored (FM-F-3)
 * - 503 → backoff (FM-F-4)
 * - 500 with SSH error → FirecrestSshError (FM-F-5)
 * - 404 for system → FirecrestSystemNotFound (FM-F-7)
 * - 404 (non-system) → returns response
 * - Timeout → FirecrestTimeout (FM-F-1, F-INV-3)
 * - Max retries exhausted
 * - download() returns Buffer
 * - upload() sends data
 *
 * Spec: specs/firecrest/invariants.md F-INV-2, F-INV-3;
 * specs/firecrest/failure-modes.md FM-F-1 through FM-F-7;
 * ADR-011.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FirecrestClientImpl,
} from '../../src/firecrest-adapter/firecrest-client';
import {
  FirecrestTimeout,
  FirecrestUnauthorized,
  FirecrestRateLimited,
  FirecrestUnavailable,
  FirecrestSshError,
  FirecrestSystemNotFound,
} from '../../src/firecrest-adapter/types';
import { createMockTokenProvider } from './helpers';

// ============================================================================
// Helpers for mocking fetch
// ============================================================================

/**
 * Creates a mock Response with a JSON body.
 */
function mockJsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Creates a mock Response with a text body.
 */
function mockTextResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain', ...headers },
  });
}

/**
 * Creates a mock fetch that returns different responses on sequential calls.
 * Useful for testing retry behavior.
 */
function createSequentialFetch(
  responses: Response[],
  errorOnExhaust: Error = new Error('No more mock responses'),
): ReturnType<typeof vi.fn> {
  let index = 0;
  return vi.fn(async () => {
    if (index >= responses.length) {
      throw errorOnExhaust;
    }
    const response = responses[index];
    index++;
    return response;
  });
}

// ============================================================================
// FirecrestClientImpl
// ============================================================================

describe('FirecrestClientImpl', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ========================================================================
  // JWT in Authorization header (F-INV-2)
  // ========================================================================

  describe('JWT in Authorization header (F-INV-2)', () => {
    it('GET sends Authorization: Bearer <token>', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider({ token: 'jwt-abc123' }),
        maxRetries: 0,
      });

      await client.get('/status/daint/healthchecks');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('https://firecrest.cscs.ch/status/daint/healthchecks');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer jwt-abc123',
      });
    });

    it('POST sends Authorization header and JSON body', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ jobId: 123 }));
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider({ token: 'jwt-xyz' }),
        maxRetries: 0,
      });

      await client.post('/compute/daint/jobs', { jobScript: '#!/bin/bash\necho hi' });

      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('https://firecrest.cscs.ch/compute/daint/jobs');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer jwt-xyz',
      });
      expect(init?.body).toBe(JSON.stringify({ jobScript: '#!/bin/bash\necho hi' }));
    });

    it('PUT sends Authorization header and JSON body', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 0,
      });

      await client.put('/filesystem/daint/path/scratch/test');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [_url, init] = fetchMock.mock.calls[0] ?? [];
      expect(init?.method).toBe('PUT');
      expect(init?.headers).toHaveProperty('authorization');
    });

    it('DELETE sends Authorization header', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 0,
      });

      await client.delete('/compute/daint/jobs/123');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('https://firecrest.cscs.ch/compute/daint/jobs/123');
      expect(init?.method).toBe('DELETE');
      expect(init?.headers).toHaveProperty('authorization');
    });

    it('returns FirecrestResponse with statusCode and body', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ state: 'RUNNING' }));
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 0,
      });

      const result = await client.get('/compute/daint/jobs/123');

      expect(result.statusCode).toBe(200);
      expect(result.body).toEqual({ state: 'RUNNING' });
    });
  });

  // ========================================================================
  // 401 → refresh + retry (FM-F-2)
  // ========================================================================

  describe('401 → refresh + retry (FM-F-2)', () => {
    it('refreshes token and retries on 401', async () => {
      const fetchMock = createSequentialFetch([
        mockJsonResponse({ error: 'invalid token' }, 401),
        mockJsonResponse({ ok: true }, 200),
      ]);
      globalThis.fetch = fetchMock;

      const tokenProvider = createMockTokenProvider({ token: 'old-token' });
      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider,
        maxRetries: 0,
      });

      const result = await client.get('/status/daint/healthchecks');

      expect(result.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(tokenProvider.refreshTokenMock).toHaveBeenCalledTimes(1);

      // Second request should use the refreshed token
      const [, secondInit] = fetchMock.mock.calls[1] ?? [];
      const headers = secondInit?.headers as Record<string, string>;
      expect(headers.authorization).toContain('old-token-refreshed');
    });

    it('throws FirecrestUnauthorized when refresh fails', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockJsonResponse({ error: 'expired' }, 401),
      );
      globalThis.fetch = fetchMock;

      const tokenProvider = createMockTokenProvider({ token: 'old-token' });
      tokenProvider.refreshTokenMock.mockRejectedValue(new Error('refresh failed'));

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider,
        maxRetries: 0,
      });

      await expect(client.get('/status/daint/healthchecks'))
        .rejects.toThrow(FirecrestUnauthorized);
    });

    it('throws FirecrestUnauthorized when 401 persists after refresh', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockJsonResponse({ error: 'still invalid' }, 401),
      );
      globalThis.fetch = fetchMock;

      const tokenProvider = createMockTokenProvider({ token: 'old-token' });
      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider,
        maxRetries: 0,
      });

      await expect(client.get('/status/daint/healthchecks'))
        .rejects.toThrow(FirecrestUnauthorized);
      expect(fetchMock).toHaveBeenCalledTimes(2); // initial + retry after refresh
      expect(tokenProvider.refreshTokenMock).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // 429 → Retry-After (FM-F-3)
  // ========================================================================

  describe('429 → Retry-After honored (FM-F-3)', () => {
    it('honors Retry-After header in seconds', async () => {
      const fetchMock = createSequentialFetch([
        mockJsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '1' }),
        mockJsonResponse({ ok: true }, 200),
      ]);
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 3,
        retryInitialDelayMs: 5000, // high default — Retry-After should override
      });

      const start = Date.now();
      const result = await client.get('/compute/daint/jobs');
      const elapsed = Date.now() - start;

      expect(result.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Should have waited ~1 second (Retry-After), not 5 seconds (default)
      expect(elapsed).toBeLessThan(3000);
    });

    it('falls back to exponential backoff when no Retry-After', async () => {
      const fetchMock = createSequentialFetch([
        mockJsonResponse({ error: 'rate limited' }, 429),
        mockJsonResponse({ ok: true }, 200),
      ]);
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 3,
        retryInitialDelayMs: 10,
        retryBackoffMultiplier: 2,
      });

      const result = await client.get('/compute/daint/jobs');

      expect(result.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws FirecrestRateLimited when all retries exhausted', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockJsonResponse({ error: 'rate limited' }, 429),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 2,
        retryInitialDelayMs: 1,
      });

      await expect(client.get('/compute/daint/jobs'))
        .rejects.toThrow(FirecrestRateLimited);
      // 1 initial + 2 retries = 3 total
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not flood FirecREST with immediate retries (FM-F-3)', async () => {
      const fetchMock = createSequentialFetch([
        mockJsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '2' }),
        mockJsonResponse({ ok: true }, 200),
      ]);
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 3,
        retryInitialDelayMs: 10,
      });

      const start = Date.now();
      await client.get('/compute/daint/jobs');
      const elapsed = Date.now() - start;

      // Should have waited at least ~1.5 seconds (Retry-After: 2, with some margin)
      expect(elapsed).toBeGreaterThanOrEqual(1500);
    });
  });

  // ========================================================================
  // 503 → backoff (FM-F-4)
  // ========================================================================

  describe('503 → backoff (FM-F-4)', () => {
    it('retries on 503 with backoff', async () => {
      const fetchMock = createSequentialFetch([
        mockJsonResponse({ error: 'unavailable' }, 503),
        mockJsonResponse({ ok: true }, 200),
      ]);
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 3,
        retryInitialDelayMs: 10,
      });

      const result = await client.get('/compute/daint/jobs');

      expect(result.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws FirecrestUnavailable when all retries exhausted', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockJsonResponse({ error: 'unavailable' }, 503),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 2,
        retryInitialDelayMs: 1,
      });

      await expect(client.get('/compute/daint/jobs'))
        .rejects.toThrow(FirecrestUnavailable);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  // ========================================================================
  // 500 with SSH error → FirecrestSshError (FM-F-5)
  // ========================================================================

  describe('500 with SSH error (FM-F-5)', () => {
    it('throws FirecrestSshError when 500 body contains "ssh"', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockTextResponse('ssh: connection to host failed', 500),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 2,
        retryInitialDelayMs: 1,
      });

      await expect(client.get('/compute/daint/jobs/123'))
        .rejects.toThrow(FirecrestSshError);
    });

    it('throws generic Error when 500 body does not contain "ssh"', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockTextResponse('internal server error', 500),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 2,
        retryInitialDelayMs: 1,
      });

      await expect(client.get('/compute/daint/jobs/123'))
        .rejects.toThrow();
    });

    it('retries on 500 with SSH error before throwing', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockTextResponse('ssh: connection refused', 500),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 2,
        retryInitialDelayMs: 1,
      });

      await expect(client.get('/compute/daint/jobs/123'))
        .rejects.toThrow(FirecrestSshError);
      // 1 initial + 2 retries = 3 total
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  // ========================================================================
  // 404 for system → FirecrestSystemNotFound (FM-F-7)
  // ========================================================================

  describe('404 handling (FM-F-7)', () => {
    it('throws FirecrestSystemNotFound when 404 body mentions the system name', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockTextResponse('System "unknown_system" not found in FirecREST', 404),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'unknown_system',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 0,
      });

      await expect(client.get('/compute/unknown_system/jobs'))
        .rejects.toThrow(FirecrestSystemNotFound);
    });

    it('returns 404 response when body does not mention the system', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockJsonResponse({ error: 'Job 9999999 not found' }, 404),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 0,
      });

      const result = await client.get('/compute/daint/jobs/9999999');

      expect(result.statusCode).toBe(404);
      expect(result.body).toEqual({ error: 'Job 9999999 not found' });
    });

    it('does not retry on 404', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockJsonResponse({ error: 'Job not found' }, 404),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 3,
      });

      await client.get('/compute/daint/jobs/9999999');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // Timeout → FirecrestTimeout (FM-F-1, F-INV-3)
  // ========================================================================

  describe('timeout (FM-F-1, F-INV-3)', () => {
    it('throws FirecrestTimeout when request times out after all retries', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      const fetchMock = vi.fn().mockRejectedValue(abortError);
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 2,
        retryInitialDelayMs: 1,
      });

      await expect(client.get('/compute/daint/jobs/123'))
        .rejects.toThrow(FirecrestTimeout);
      // 1 initial + 2 retries = 3 total
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries on timeout before throwing', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      const responses: Array<Response | Error> = [
        abortError,
        mockJsonResponse({ ok: true }, 200),
      ];
      let index = 0;
      const fixedFetchMock = vi.fn(async () => {
        const item = responses[index];
        if (item === undefined) {
          throw new Error('No more mock responses');
        }
        index++;
        if (item instanceof Error) throw item;
        return item;
      });
      globalThis.fetch = fixedFetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 3,
        retryInitialDelayMs: 1,
      });

      const result = await client.get('/compute/daint/jobs/123');

      expect(result.statusCode).toBe(200);
      expect(fixedFetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ========================================================================
  // Max retries
  // ========================================================================

  describe('max retries', () => {
    it('retries at most maxRetries times', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockJsonResponse({ error: 'unavailable' }, 503),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 4,
        retryInitialDelayMs: 1,
      });

      await expect(client.get('/compute/daint/jobs'))
        .rejects.toThrow(FirecrestUnavailable);
      // 1 initial + 4 retries = 5 total
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('does not retry when maxRetries is 0', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockJsonResponse({ error: 'unavailable' }, 503),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 0,
        retryInitialDelayMs: 1,
      });

      await expect(client.get('/compute/daint/jobs'))
        .rejects.toThrow(FirecrestUnavailable);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // download
  // ========================================================================

  describe('download', () => {
    it('returns Buffer from response body', async () => {
      const fileContent = Buffer.from('file content here');
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(fileContent, { status: 200 }),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 0,
      });

      const result = await client.download('/filesystem/daint/ops/download?path=/scratch/test.txt');

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe('file content here');
    });

    it('sends Authorization header', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(Buffer.from('data'), { status: 200 }),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider({ token: 'dl-token' }),
        maxRetries: 0,
      });

      await client.download('/filesystem/daint/ops/download?path=/x');

      const [, init] = fetchMock.mock.calls[0] ?? [];
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer dl-token',
      });
    });
  });

  // ========================================================================
  // upload
  // ========================================================================

  describe('upload', () => {
    it('sends data via POST with Authorization header', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockJsonResponse({ ok: true }, 200),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider({ token: 'up-token' }),
        maxRetries: 0,
      });

      const data = Buffer.from('upload content');
      await client.upload('/filesystem/daint/ops/upload', data);

      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('https://firecrest.cscs.ch/filesystem/daint/ops/upload');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer up-token',
      });
    });

    it('resolves on 200', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockJsonResponse({ ok: true }, 200),
      );
      globalThis.fetch = fetchMock;

      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
        maxRetries: 0,
      });

      await expect(
        client.upload('/filesystem/daint/ops/upload', Buffer.from('x')),
      ).resolves.toBeUndefined();
    });
  });

  // ========================================================================
  // Interface stability
  // ========================================================================

  describe('interface stability', () => {
    it('implements the FirecrestClient interface', () => {
      const client = new FirecrestClientImpl({
        firecrestUrl: 'https://firecrest.cscs.ch',
        systemName: 'daint',
        tokenProvider: createMockTokenProvider(),
      });

      expect(typeof client.get).toBe('function');
      expect(typeof client.post).toBe('function');
      expect(typeof client.put).toBe('function');
      expect(typeof client.delete).toBe('function');
      expect(typeof client.download).toBe('function');
      expect(typeof client.upload).toBe('function');
    });
  });
});
