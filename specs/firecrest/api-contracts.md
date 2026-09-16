# FirecREST Adapter — API Contracts

> TypeScript interface definitions for the FirecREST backend.
> These are contracts, not implementations. Stubs live in
> `src/firecrest-adapter/types.ts`.

## FirecRESTConfig

```typescript
interface FirecrestConfig {
  readonly firecrestUrl: string;       // e.g., "https://firecrest.cscs.ch"
  readonly systemName: string;         // e.g., "daint"
  readonly tokenProvider: JwtTokenProvider;
  readonly requestTimeoutMs: number;   // default: 6000 (5s FirecREST + 1s margin)
  readonly maxRetries: number;         // default: 5
  readonly retryInitialDelayMs: number; // default: 1000
  readonly retryBackoffMultiplier: number; // default: 2
  readonly maxFileSynchronousBytes: number; // default: 5_000_000 (5MB)
  readonly transferMethod: 's3' | 'streamer' | 'wormhole';
}
```

## JwtTokenProvider

```typescript
interface JwtTokenProvider {
  getToken(): Promise<string>;
  refreshToken(): Promise<string>;
  isExpired(): boolean;
}
```

## FirecrestClient

Low-level HTTP client. All requests carry the JWT Bearer token.
Handles 401 (refresh + retry), 429 (honor Retry-After), 503
(backoff), and 5-second timeout (FM-F-1).

```typescript
interface FirecrestClient {
  get<T>(path: string): Promise<FirecrestResponse<T>>;
  post<T>(path: string, body?: unknown): Promise<FirecrestResponse<T>>;
  put<T>(path: string, body?: unknown): Promise<FirecrestResponse<T>>;
  delete<T>(path: string): Promise<FirecrestResponse<T>>;
  download(path: string): Promise<Buffer>;
  upload(path: string, data: Buffer): Promise<void>;
}

interface FirecrestResponse<T> {
  readonly statusCode: number;
  readonly body: T;
}

interface FirecrestError {
  readonly statusCode: number;
  readonly message: string;
  readonly isRetryable: boolean;
}
```

## FirecRESTShellExecutor

Implements `ShellExecutor` by submitting the command as a SLURM
Job via FirecREST. All operations are parallel (F-INV-6).

```typescript
interface FirecRESTShellExecutor extends ShellExecutor {
  execute(command: string, options?: ShellExecuteOptions): Promise<ShellResult>;
}
```

The `execute` method:
1. Wraps the command in a Job script (with optional `uenv start`
   prefix for F-INV-5)
2. Submits via `POST /compute/{system}/jobs`
3. Polls `GET /compute/{system}/jobs/{jobId}` until terminal state
4. Returns `ShellResult` with `stdout`, `stderr`, and `ExitOutcome`
   derived from the Job's terminal state and exit code

## FirecRESTSubprocessRunner

Implements `SubprocessRunner` by submitting Jobs (same as
ShellExecutor, since FirecREST has no direct command execution).

```typescript
interface FirecRESTSubprocessRunner extends SubprocessRunner {
  execute(command: string, args: string[], options?: SubprocessOptions): Promise<ShellResult>;
  spawn(command: string, args: string[], options?: SubprocessOptions): SubprocessHandle;
}
```

The `spawn` method returns a `SubprocessHandle` that wraps the
FirecREST Job. The `wait()` method polls until terminal state.
The `stdout` and `stderr` async iterables emit the Job's output
when the Job reaches a terminal state.

## FirecRESTFilesystemGateway

Implements `FilesystemGateway` via FirecREST filesystem endpoints.

```typescript
interface FirecRESTFilesystemGateway extends FilesystemGateway {
  exists(path: string): Promise<boolean>;
  isReadable(path: string): Promise<boolean>;
  isWritable(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  readDir(path: string): Promise<string[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
}
```

Mapping to FirecREST endpoints:

| Method | FirecREST endpoint | Notes |
|--------|-------------------|-------|
| `exists` | `GET /filesystem/{system}/stat/{path}` | Returns true if 200, false if 404 |
| `isReadable` | `GET /filesystem/{system}/stat/{path}` | Returns true if 200 |
| `isWritable` | `GET /filesystem/{system}/stat/{path}` (parent dir) | Best-effort: checks parent exists and is directory |
| `stat` | `GET /filesystem/{system}/stat/{path}` | Maps FirecREST stat to `FileStat` |
| `readFile` | `GET /filesystem/{system}/ops/download` (≤5MB) or `POST /filesystem/{system}/transfer/download` (>5MB) | F-INV-4 |
| `writeFile` | `POST /filesystem/{system}/ops/upload` (≤5MB) or `POST /filesystem/{system}/transfer/upload` (>5MB) | F-INV-4 |
| `readDir` | `GET /filesystem/{system}/path/{path}` | Maps FirecREST listing to `string[]` |
| `mkdir` | `PUT /filesystem/{system}/path/{path}` | FirecREST creates the directory |

## FirecRESTSchedulingService

Implements `SchedulingService` via FirecREST compute endpoints.

```typescript
interface FirecRESTSchedulingService extends SchedulingService {
  submitJob(request: SubmitJobInput): Promise<Job>;
  queryJob(jobId: JobId): Promise<Job>;
  queryJobsByUser(username: string): Promise<Job[]>;
  cancelJob(jobId: JobId): Promise<void>;
  reconcileViaSacct(jobIds: JobId[]): Promise<Job[]>;
}
```

Mapping to FirecREST endpoints:

| Method | FirecREST endpoint | Notes |
|--------|-------------------|-------|
| `submitJob` | `POST /compute/{system}/jobs` | Takes `jobScript` (string) |
| `queryJob` | `GET /compute/{system}/jobs/{jobId}` | Maps FirecREST job to `Job` |
| `queryJobsByUser` | `GET /compute/{system}/jobs?user={username}` | Maps FirecREST job list to `Job[]` |
| `cancelJob` | `DELETE /compute/{system}/jobs/{jobId}` | Returns 200 on success |
| `reconcileViaSacct` | `GET /compute/{system}/jobs` (with state filter) | Polls completed Jobs during outage |

## FirecRESTBackend (aggregate)

```typescript
interface FirecRESTBackend {
  readonly shellExecutor: ShellExecutor;
  readonly subprocessRunner: SubprocessRunner;
  readonly filesystemGateway: FilesystemGateway;
  readonly schedulingService: SchedulingService;
}

function createFirecrestBackend(config: FirecrestConfig): FirecRESTBackend;
```

This is the FirecREST analog of `createDshAdapter(context)` from
Phase 1. It creates all four adapter interfaces from a single
configuration. Domain modules receive these interfaces and never
see the FirecREST HTTP client or JWT token.
