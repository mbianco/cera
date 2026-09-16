/**
 * Type definitions for the FirecREST adapter module.
 *
 * These are STUBS — type definitions only, no implementation.
 * The implementer will fill in the HTTP client and adapter classes.
 *
 * Spec references: specs/firecrest/api-contracts.md;
 * specs/firecrest/invariants.md; specs/firecrest/failure-modes.md;
 * ADR-011.
 */

import type { ShellExecutor, SubprocessRunner, FilesystemGateway } from '../dsh-adapter/types';
import type { SchedulingService } from '../scheduling/types';

// ============================================================================
// JwtTokenProvider
// ============================================================================

/**
 * Abstracts JWT token acquisition and refresh (F-INV-2).
 *
 * The default implementation uses the OIDC client credentials grant.
 * On 401, cera calls `refreshToken()` and retries the request.
 *
 * Spec: specs/firecrest/invariants.md F-INV-2;
 * specs/firecrest/failure-modes.md FM-F-2.
 */
export interface JwtTokenProvider {
  /**
   * Returns the current JWT token. If the token is expired or
   * about to expire, this method may refresh it automatically.
   */
  getToken(): Promise<string>;

  /**
   * Forces a token refresh via the OIDC provider.
   * @throws {Error} if the refresh fails (OIDC provider
   *   unreachable, refresh token expired, credentials revoked).
   */
  refreshToken(): Promise<string>;

  /**
   * Returns true if the current token is expired or about to
   * expire (within a configurable margin).
   */
  isExpired(): boolean;
}

// ============================================================================
// FirecrestConfig
// ============================================================================

/**
 * Configuration for the FirecREST backend.
 *
 * Spec: specs/firecrest/api-contracts.md (FirecRESTConfig);
 * ADR-011.
 */
export interface FirecrestConfig {
  /** FirecREST server URL (e.g., "https://firecrest.cscs.ch"). */
  readonly firecrestUrl: string;
  /** Target HPC system name (e.g., "daint", "santis"). */
  readonly systemName: string;
  /** JWT token provider for authentication (F-INV-2). */
  readonly tokenProvider: JwtTokenProvider;
  /** Timeout for synchronous FirecREST calls (ms). Default: 6000 (5s + 1s margin, F-INV-3). */
  readonly requestTimeoutMs?: number;
  /** Maximum retries for failed requests. Default: 5. */
  readonly maxRetries?: number;
  /** Initial retry delay (ms). Default: 1000. */
  readonly retryInitialDelayMs?: number;
  /** Retry backoff multiplier. Default: 2. */
  readonly retryBackoffMultiplier?: number;
  /** Maximum file size for synchronous transfer (bytes). Default: 5_000_000 (F-INV-4). */
  readonly maxFileSynchronousBytes?: number;
  /** Transfer method for large files. Default: "streamer". */
  readonly transferMethod?: 's3' | 'streamer' | 'wormhole';
}

export const DEFAULT_FIRECREST_CONFIG: Required<FirecrestConfig> = {
  firecrestUrl: 'https://firecrest.cscs.ch',
  systemName: 'daint',
  tokenProvider: undefined as unknown as JwtTokenProvider,
  requestTimeoutMs: 6000,
  maxRetries: 5,
  retryInitialDelayMs: 1000,
  retryBackoffMultiplier: 2,
  maxFileSynchronousBytes: 5_000_000,
  transferMethod: 'streamer',
};

// ============================================================================
// FirecrestResponse
// ============================================================================

/**
 * Generic FirecREST API response wrapper.
 */
export interface FirecrestResponse<T = unknown> {
  readonly statusCode: number;
  readonly body: T;
}

// ============================================================================
// FirecrestClient
// ============================================================================

/**
 * Low-level HTTP client for FirecREST. All requests carry the JWT
 * Bearer token (F-INV-2). Handles 401 (refresh + retry), 429 (honor
 * Retry-After), 503 (backoff), 500 (SSH error classification), and
 * 5-second timeout (FM-F-1).
 *
 * Spec: specs/firecrest/api-contracts.md (FirecrestClient);
 * specs/firecrest/invariants.md F-INV-2, F-INV-3;
 * specs/firecrest/failure-modes.md FM-F-1 through FM-F-7.
 */
export interface FirecrestClient {
  get<T>(path: string): Promise<FirecrestResponse<T>>;
  post<T>(path: string, body?: unknown): Promise<FirecrestResponse<T>>;
  put<T>(path: string, body?: unknown): Promise<FirecrestResponse<T>>;
  delete<T>(path: string): Promise<FirecrestResponse<T>>;
  download(path: string): Promise<Buffer>;
  upload(path: string, data: Buffer): Promise<void>;
}

// ============================================================================
// FirecREST Error Types
// ============================================================================

/**
 * Base error for all FirecREST adapter errors.
 */
export abstract class FirecrestError extends Error {
  abstract readonly kind: string;
  abstract readonly statusCode: number;
  abstract readonly isRetryable: boolean;
  readonly userMessage: string;
  readonly internalDetails: string;
  readonly specRef: string;

  constructor(props: {
    userMessage: string;
    internalDetails: string;
    specRef: string;
    cause?: unknown;
  }) {
    super(props.userMessage, { cause: props.cause });
    this.name = this.constructor.name;
    this.userMessage = props.userMessage;
    this.internalDetails = props.internalDetails;
    this.specRef = props.specRef;
  }
}

/**
 * FM-F-1: FirecREST 5-second timeout on synchronous call.
 */
export class FirecrestTimeout extends FirecrestError {
  readonly kind = 'firecrest_timeout';
  readonly statusCode = 0; // client-side timeout, no HTTP status
  readonly isRetryable = true;

  constructor(props: { path: string; elapsed: number }) {
    super({
      userMessage: 'FirecREST did not respond within the timeout. Retrying with backoff.',
      internalDetails: `Timeout after ${props.elapsed}ms on ${props.path}`,
      specRef: 'specs/firecrest/failure-modes.md FM-F-1; specs/firecrest/invariants.md F-INV-3',
    });
  }
}

/**
 * FM-F-2: JWT token expired or invalid (401).
 */
export class FirecrestUnauthorized extends FirecrestError {
  readonly kind = 'firecrest_unauthorized';
  readonly statusCode = 401;
  readonly isRetryable = false; // Retry only after token refresh

  constructor(props: { message: string }) {
    super({
      userMessage: 'Authentication expired or invalid. Please re-authenticate with CSCS.',
      internalDetails: `401: ${props.message}`,
      specRef: 'specs/firecrest/failure-modes.md FM-F-2; specs/firecrest/invariants.md F-INV-2',
    });
  }
}

/**
 * FM-F-3: FirecREST rate limit exceeded (429).
 */
export class FirecrestRateLimited extends FirecrestError {
  readonly kind = 'firecrest_rate_limited';
  readonly statusCode = 429;
  readonly isRetryable = true;
  readonly retryAfterMs: number | null;

  constructor(props: { retryAfterMs?: number }) {
    super({
      userMessage: 'FirecREST is rate-limiting requests. Retrying with backoff.',
      internalDetails: `429: Retry-After ${props.retryAfterMs ?? 'not specified'}`,
      specRef: 'specs/firecrest/failure-modes.md FM-F-3',
    });
    this.retryAfterMs = props.retryAfterMs ?? null;
  }
}

/**
 * FM-F-4: FirecREST server unavailable (503).
 */
export class FirecrestUnavailable extends FirecrestError {
  readonly kind = 'firecrest_unavailable';
  readonly statusCode = 503;
  readonly isRetryable = true;

  constructor(props: { message: string }) {
    super({
      userMessage: 'FirecREST is currently unavailable. Running Jobs on the HPC are NOT affected. Retrying with backoff.',
      internalDetails: `503: ${props.message}`,
      specRef: 'specs/firecrest/failure-modes.md FM-F-4; specs/firecrest/invariants.md F-INV-1',
    });
  }
}

/**
 * FM-F-5: SSH connection from FirecREST to HPC failed (500).
 */
export class FirecrestSshError extends FirecrestError {
  readonly kind = 'firecrest_ssh_error';
  readonly statusCode = 500;
  readonly isRetryable = true;

  constructor(props: { message: string }) {
    super({
      userMessage: 'FirecREST cannot reach the HPC system. Retrying with backoff.',
      internalDetails: `500: ${props.message}`,
      specRef: 'specs/firecrest/failure-modes.md FM-F-5',
    });
  }
}

/**
 * FM-F-7: FirecREST not configured for the target system (404).
 */
export class FirecrestSystemNotFound extends FirecrestError {
  readonly kind = 'firecrest_system_not_found';
  readonly statusCode = 404;
  readonly isRetryable = false;

  constructor(props: { systemName: string; availableSystems?: string[] }) {
    super({
      userMessage: `System "${props.systemName}" is not configured in FirecREST${props.availableSystems ? `. Available: ${props.availableSystems.join(', ')}` : '.'}`,
      internalDetails: `404: system "${props.systemName}" not found`,
      specRef: 'specs/firecrest/failure-modes.md FM-F-7',
    });
  }
}

/**
 * FM-F-8: File too large for synchronous download (>5MB).
 */
export class FirecrestFileTooLarge extends FirecrestError {
  readonly kind = 'firecrest_file_too_large';
  readonly statusCode = 413;
  readonly isRetryable = false; // Use async transfer instead

  constructor(props: { path: string; size: number; limit: number }) {
    super({
      userMessage: `File "${props.path}" (${props.size} bytes) exceeds the synchronous transfer limit (${props.limit} bytes). Use async transfer.`,
      internalDetails: `413: ${props.size} > ${props.limit} for ${props.path}`,
      specRef: 'specs/firecrest/failure-modes.md FM-F-8; specs/firecrest/invariants.md F-INV-4',
    });
  }
}

// ============================================================================
// FirecREST Job Types
// ============================================================================

/**
 * FirecREST job representation (from GET /compute/{system}/jobs/{id}).
 */
export interface FirecrestJob {
  readonly jobId: number;
  readonly state: string; // SLURM state string
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly stdout?: string;
  readonly elapsed?: string;
  readonly resourceUsage?: Record<string, unknown>;
}

/**
 * FirecREST file stat (from GET /filesystem/{system}/stat/{path}).
 */
export interface FirecrestFileStatResponse {
  readonly size: number;
  readonly mode: number;
  readonly mtime: string; // ISO 8601
  readonly atime?: string;
  readonly ctime?: string;
  readonly isDir: boolean;
}

/**
 * FirecREST directory listing entry (from GET /filesystem/{system}/path/{path}).
 */
export interface FirecrestDirEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symlink';
  readonly size?: number;
  readonly mtime?: string;
}

/**
 * FirecREST job submission response (from POST /compute/{system}/jobs).
 */
export interface FirecrestJobSubmitResponse {
  readonly jobId: number;
  readonly state: string;
}

/**
 * FirecREST transfer response (from POST /filesystem/{system}/transfer/...).
 */
export interface FirecrestTransferResponse {
  readonly transferJob: {
    readonly jobId: number;
    readonly system: string;
  };
  readonly transferDirectives: {
    readonly transfer_method: string;
    readonly download_url?: string;
    readonly coordinates?: string;
  };
}

// ============================================================================
// FirecRESTBackend (aggregate)
// ============================================================================

/**
 * Aggregate of all FirecREST adapter interfaces. Domain modules
 * receive this aggregate (or individual interfaces) and never see
 * the FirecREST HTTP client or JWT token.
 *
 * Spec: ADR-011; specs/firecrest/api-contracts.md.
 */
export interface FirecRESTBackend {
  readonly shellExecutor: ShellExecutor;
  readonly subprocessRunner: SubprocessRunner;
  readonly filesystemGateway: FilesystemGateway;
  readonly schedulingService: SchedulingService;
}
