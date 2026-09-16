/**
 * Test helpers for the FirecREST adapter module.
 *
 * Provides mock factories for FirecrestClient, JwtTokenProvider,
 * and FirecrestConfig, plus helper factories for FirecREST-specific
 * types (FirecrestJob, FirecrestFileStatResponse, FirecrestDirEntry)
 * and cera types (ShellResult, Job).
 *
 * Spec: specs/firecrest/api-contracts.md; ADR-011;
 * build-phases.md (FirecREST adapter — Tier 1 unit tests).
 */

import { vi } from 'vitest';
import type {
  FirecrestConfig,
  FirecrestResponse,
  FirecrestClient,
  FirecrestJob,
  FirecrestFileStatResponse,
  FirecrestDirEntry,
  FirecrestJobSubmitResponse,
  FirecrestTransferResponse,
  JwtTokenProvider,
} from '../../src/firecrest-adapter/types';
import type { ShellResult } from '../../src/dsh-adapter/types';
import type { Job, JobId, UserId, ResourceRequest, ExitOutcome, JobState } from '../../src/types';

// ============================================================================
// Mock JwtTokenProvider
// ============================================================================

/**
 * Creates a mock JwtTokenProvider with a configurable token and
 * expiry state. After `refreshToken()` is called, `getToken()`
 * returns the refreshed token.
 *
 * Usage:
 *   const provider = createMockTokenProvider({ token: 'abc123' });
 *   provider.isExpired.mockReturnValue(true);
 */
export function createMockTokenProvider(overrides: {
  token?: string;
  expired?: boolean;
} = {}): JwtTokenProvider & {
  readonly getTokenMock: ReturnType<typeof vi.fn>;
  readonly refreshTokenMock: ReturnType<typeof vi.fn>;
  readonly isExpiredMock: ReturnType<typeof vi.fn>;
} {
  const token = overrides.token ?? 'mock-jwt-token';
  const expired = overrides.expired ?? false;
  let currentToken = token;
  const refreshedToken = `${token}-refreshed`;

  const getTokenMock = vi.fn(async (): Promise<string> => currentToken);
  const refreshTokenMock = vi.fn(async (): Promise<string> => {
    currentToken = refreshedToken;
    return refreshedToken;
  });
  const isExpiredMock = vi.fn((): boolean => expired);

  return {
    getToken: getTokenMock,
    refreshToken: refreshTokenMock,
    isExpired: isExpiredMock,
    getTokenMock,
    refreshTokenMock,
    isExpiredMock,
  };
}

// ============================================================================
// Mock FirecrestClient
// ============================================================================

/**
 * A response entry that maps a method + path pattern to a response
 * or a thrown error.
 */
export interface MockClientResponse {
  /** HTTP method: 'get' | 'post' | 'put' | 'delete' | 'download' | 'upload' */
  readonly method: string;
  /** Path pattern. If startsWith matches, this response is used. */
  readonly pathPattern: string;
  /** The status code and body to return. */
  readonly statusCode?: number;
  readonly body?: unknown;
  /** If provided, this error is thrown instead of returning a response. */
  readonly throwError?: Error;
  /** Response headers (for Retry-After, etc.). */
  readonly headers?: Record<string, string>;
}

/**
 * Creates a mock FirecrestClient with configurable responses. Each
 * method (get, post, put, delete, download, upload) is a vi.fn() with
 * a sensible default. Tests can override specific behaviors by
 * providing response entries or by directly mocking the methods.
 *
 * The mock tracks all calls in `calls` for assertion.
 *
 * Usage:
 *   const client = createMockFirecrestClient({
 *     responses: [
 *       { method: 'get', pathPattern: '/compute/daint/jobs/123', statusCode: 200, body: { jobId: 123, state: 'RUNNING' } },
 *     ],
 *   });
 *   const result = await client.get('/compute/daint/jobs/123');
 */
export function createMockFirecrestClient(overrides: {
  responses?: readonly MockClientResponse[];
  defaultStatusCode?: number;
  defaultBody?: unknown;
} = {}): FirecrestClient & {
  readonly calls: { method: string; path: string; body?: unknown }[];
  readonly getMock: ReturnType<typeof vi.fn>;
  readonly postMock: ReturnType<typeof vi.fn>;
  readonly putMock: ReturnType<typeof vi.fn>;
  readonly deleteMock: ReturnType<typeof vi.fn>;
  readonly downloadMock: ReturnType<typeof vi.fn>;
  readonly uploadMock: ReturnType<typeof vi.fn>;
} {
  const responses = overrides.responses ?? [];
  const defaultStatusCode = overrides.defaultStatusCode ?? 200;
  const defaultBody = overrides.defaultBody ?? {};
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const findResponse = (
    method: string,
    path: string,
  ): { statusCode: number; body: unknown; headers?: Record<string, string> } | Error => {
    for (const r of responses) {
      if (r.method === method && path.startsWith(r.pathPattern)) {
        if (r.throwError !== undefined) {
          return r.throwError;
        }
        return {
          statusCode: r.statusCode ?? defaultStatusCode,
          body: r.body ?? defaultBody,
          headers: r.headers,
        };
      }
    }
    return { statusCode: defaultStatusCode, body: defaultBody };
  };

  const getMock = vi.fn(async (path: string): Promise<FirecrestResponse> => {
    calls.push({ method: 'get', path });
    const result = findResponse('get', path);
    if (result instanceof Error) throw result;
    return { statusCode: result.statusCode, body: result.body };
  });

  const postMock = vi.fn(async (path: string, body?: unknown): Promise<FirecrestResponse> => {
    calls.push({ method: 'post', path, body });
    const result = findResponse('post', path);
    if (result instanceof Error) throw result;
    return { statusCode: result.statusCode, body: result.body };
  });

  const putMock = vi.fn(async (path: string, body?: unknown): Promise<FirecrestResponse> => {
    calls.push({ method: 'put', path, body });
    const result = findResponse('put', path);
    if (result instanceof Error) throw result;
    return { statusCode: result.statusCode, body: result.body };
  });

  const deleteMock = vi.fn(async (path: string): Promise<FirecrestResponse> => {
    calls.push({ method: 'delete', path });
    const result = findResponse('delete', path);
    if (result instanceof Error) throw result;
    return { statusCode: result.statusCode, body: result.body };
  });

  const downloadMock = vi.fn(async (path: string): Promise<Buffer> => {
    calls.push({ method: 'download', path });
    const result = findResponse('download', path);
    if (result instanceof Error) throw result;
    return Buffer.isBuffer(result.body) ? result.body : Buffer.from(String(result.body));
  });

  const uploadMock = vi.fn(async (path: string, _data: Buffer): Promise<void> => {
    calls.push({ method: 'upload', path });
    const result = findResponse('upload', path);
    if (result instanceof Error) throw result;
  });

  return {
    get: getMock as unknown as FirecrestClient['get'],
    post: postMock as unknown as FirecrestClient['post'],
    put: putMock as unknown as FirecrestClient['put'],
    delete: deleteMock as unknown as FirecrestClient['delete'],
    download: downloadMock,
    upload: uploadMock,
    calls,
    getMock,
    postMock,
    putMock,
    deleteMock,
    downloadMock,
    uploadMock,
  };
}

// ============================================================================
// Mock FirecrestConfig
// ============================================================================

/**
 * Creates a default FirecrestConfig with a mock client and token
 * provider. Tests can override specific fields.
 *
 * Usage:
 *   const config = createMockFirecrestConfig({ systemName: 'santis' });
 */
export function createMockFirecrestConfig(overrides: {
  firecrestUrl?: string;
  systemName?: string;
  tokenProvider?: JwtTokenProvider;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryInitialDelayMs?: number;
  retryBackoffMultiplier?: number;
  maxFileSynchronousBytes?: number;
  transferMethod?: 's3' | 'streamer' | 'wormhole';
} = {}): FirecrestConfig & {
  readonly _mockClient: ReturnType<typeof createMockFirecrestClient>;
  readonly _mockTokenProvider: ReturnType<typeof createMockTokenProvider>;
} {
  const mockClient = createMockFirecrestClient();
  const mockTokenProvider = createMockTokenProvider();

  return {
    firecrestUrl: overrides.firecrestUrl ?? 'https://firecrest.cscs.ch',
    systemName: overrides.systemName ?? 'daint',
    tokenProvider: overrides.tokenProvider ?? mockTokenProvider,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 6000,
    maxRetries: overrides.maxRetries ?? 5,
    retryInitialDelayMs: overrides.retryInitialDelayMs ?? 1000,
    retryBackoffMultiplier: overrides.retryBackoffMultiplier ?? 2,
    maxFileSynchronousBytes: overrides.maxFileSynchronousBytes ?? 5_000_000,
    transferMethod: overrides.transferMethod ?? 'streamer',
    _mockClient: mockClient,
    _mockTokenProvider: mockTokenProvider,
  } as FirecrestConfig & {
    readonly _mockClient: ReturnType<typeof createMockFirecrestClient>;
    readonly _mockTokenProvider: ReturnType<typeof createMockTokenProvider>;
  };
}

// ============================================================================
// FirecrestJob factory
// ============================================================================

/**
 * Creates a mock FirecrestJob with sensible defaults.
 */
export function createMockFirecrestJob(overrides: Partial<FirecrestJob> = {}): FirecrestJob {
  return {
    jobId: 4827365,
    state: 'RUNNING',
    exitCode: undefined,
    stderr: undefined,
    stdout: undefined,
    elapsed: undefined,
    resourceUsage: undefined,
    ...overrides,
  };
}

// ============================================================================
// FirecrestFileStatResponse factory
// ============================================================================

/**
 * Creates a mock FirecrestFileStatResponse with sensible defaults.
 */
export function createMockFirecrestFileStat(
  overrides: Partial<FirecrestFileStatResponse> = {},
): FirecrestFileStatResponse {
  return {
    size: 1024,
    mode: 0o644,
    mtime: '2026-09-15T10:30:00Z',
    atime: '2026-09-15T10:30:00Z',
    ctime: '2026-09-15T10:30:00Z',
    isDir: false,
    ...overrides,
  };
}

// ============================================================================
// FirecrestDirEntry factory
// ============================================================================

/**
 * Creates a mock FirecrestDirEntry with sensible defaults.
 */
export function createMockDirEntry(overrides: Partial<FirecrestDirEntry> = {}): FirecrestDirEntry {
  return {
    name: 'file.nc',
    type: 'file',
    size: 1024,
    mtime: '2026-09-15T10:30:00Z',
    ...overrides,
  };
}

// ============================================================================
// FirecrestJobSubmitResponse factory
// ============================================================================

/**
 * Creates a mock FirecrestJobSubmitResponse with sensible defaults.
 */
export function createMockJobSubmitResponse(
  overrides: Partial<FirecrestJobSubmitResponse> = {},
): FirecrestJobSubmitResponse {
  return {
    jobId: 4827365,
    state: 'PENDING',
    ...overrides,
  };
}

// ============================================================================
// FirecrestTransferResponse factory
// ============================================================================

/**
 * Creates a mock FirecrestTransferResponse with sensible defaults.
 */
export function createMockTransferResponse(
  overrides: Partial<FirecrestTransferResponse> = {},
): FirecrestTransferResponse {
  return {
    transferJob: {
      jobId: 9999001,
      system: 'daint',
    },
    transferDirectives: {
      transfer_method: 'streamer',
      download_url: undefined,
      coordinates: undefined,
    },
    ...overrides,
  };
}

// ============================================================================
// ShellResult factory
// ============================================================================

/**
 * Creates a mock ShellResult with sensible defaults.
 */
export function createMockShellResult(overrides: Partial<ShellResult> = {}): ShellResult {
  return {
    stdout: '',
    stderr: '',
    exitOutcome: { kind: 'exit_code', code: 0 },
    ...overrides,
  };
}

// ============================================================================
// Job factory
// ============================================================================

/**
 * Creates a mock Job with sensible defaults. Uses branded ID
 * assertions — the brand symbol is private to value-objects.ts.
 */
export function createMockJob(overrides: {
  jobId?: JobId;
  userId?: UserId;
  resourceRequest?: ResourceRequest;
  state?: JobState;
  terminalState?: JobState | null;
  caseId?: unknown;
  workflowId?: unknown;
  submittedAt?: Date;
  completedAt?: Date | null;
}): Job {
  return {
    jobId: overrides.jobId ?? (4827365 as JobId),
    userId: overrides.userId ?? ('cera_user' as UserId),
    resourceRequest: overrides.resourceRequest ?? createMockResourceRequest(),
    state: overrides.state ?? 'RUNNING',
    terminalState: overrides.terminalState ?? null,
    caseId: overrides.caseId as Job['caseId'],
    workflowId: overrides.workflowId as Job['workflowId'],
    submittedAt: overrides.submittedAt ?? new Date('2026-09-15T00:00:00Z'),
    completedAt: overrides.completedAt ?? null,
  };
}

/**
 * Creates a mock ResourceRequest matching the SLURM feature file.
 */
export function createMockResourceRequest(overrides: Partial<ResourceRequest> = {}): ResourceRequest {
  return {
    nodes: 4,
    coresPerNode: 36,
    memory: '64GB',
    wallTime: '24:00:00',
    partition: 'normal',
    qos: 'default',
    ...overrides,
  };
}

// ============================================================================
// ExitOutcome factory
// ============================================================================

/**
 * Creates a mock ExitOutcome.
 */
export function createMockExitOutcome(overrides: Partial<ExitOutcome> = {}): ExitOutcome {
  return {
    kind: 'exit_code',
    code: 0,
    ...overrides,
  } as ExitOutcome;
}

// ============================================================================
// JobId factory (branded type assertion)
// ============================================================================

/**
 * Creates a JobId from a number. Uses a type assertion because the
 * brand symbol is private to value-objects.ts. This is standard
 * TypeScript practice for branded types — the assertion is
 * intentional and safe at runtime (the brand is compile-time only).
 */
export function createJobId(n: number): JobId {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`JobId must be a positive integer, got: ${n}`);
  }
  return n as JobId;
}

// ============================================================================
// UserId factory (branded type assertion)
// ============================================================================

/**
 * Creates a UserId from a string.
 */
export function createUserId(s: string): UserId {
  return s as UserId;
}
