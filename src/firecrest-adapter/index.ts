/**
 * firecrest-adapter module — FirecREST backend for cera.
 *
 * Implements the same cera-internal interfaces as dsh-adapter
 * (ShellExecutor, SubprocessRunner, FilesystemGateway) via
 * FirecREST's REST API. This allows cera to run on a laptop and
 * access Alps HPC resources without SSH or VPN (ADR-011).
 *
 * Key differences from dsh-adapter:
 * - All ToolInvocations are parallel (submitted as SLURM Jobs, F-INV-6)
 * - File operations are HTTP, not direct filesystem
 * - uenv is loaded in Job scripts, not by cera (F-INV-5)
 * - Authentication is OIDC (JWT Bearer token), not SSH keys (F-INV-2)
 *
 * Spec: ADR-011; specs/firecrest/ (invariants, failure modes,
 * assumptions, features, api-contracts).
 */

// Types
export type {
  JwtTokenProvider,
  FirecrestConfig,
  FirecrestResponse,
  FirecrestJob,
  FirecrestFileStatResponse,
  FirecrestDirEntry,
  FirecrestJobSubmitResponse,
  FirecrestTransferResponse,
  FirecRESTBackend,
} from './types';
export {
  DEFAULT_FIRECREST_CONFIG,
  FirecrestError,
  FirecrestTimeout,
  FirecrestUnauthorized,
  FirecrestRateLimited,
  FirecrestUnavailable,
  FirecrestSshError,
  FirecrestSystemNotFound,
  FirecrestFileTooLarge,
} from './types';

// FirecrestClient (low-level HTTP)
export { FirecrestClientImpl } from './firecrest-client';

// ShellExecutor
export { FirecrestShellExecutor } from './shell-executor';

// SubprocessRunner
export { FirecrestSubprocessRunner } from './subprocess-runner';

// FilesystemGateway
export { FirecrestFilesystemGateway } from './filesystem-gateway';

// Job script builder
export { buildJobScript } from './job-script-builder';

// Token providers
export { StaticTokenProvider, OidcTokenProvider } from './token-provider';
