# API Contracts — FirecREST-Only Primary (R14, ADR-012)

> TypeScript interface definitions for the R14 refactor. These
> contracts supplement `api-contracts.md` (which is NOT deleted —
> it remains the reference for the original interface definitions).
>
> **Key changes under R14:**
> - New `BackendType` = `'firecrest' | 'dev'` (was `'local' | 'firecrest'`)
> - New `BackendSelection` interface for selecting backend at startup
> - New `CeraSystemConfig` and `CeraSystem` interfaces for the
>   `createCeraSystem()` factory
> - New `JobScriptConfig` type for passing uenv specs and default
>   ResourceRequest to `ToolInvocationService`
> - Updated `FirecrestConfig` with `defaultResourceRequest` (already done)
> - Updated `ToolInvocationServiceImplProps` with optional
>   `EnvironmentService` (already done)
>
> **No existing module interface is changed.** Only implementations are
> selected at startup via `createCeraSystem()`.

---

## 0. Startup — Backend Selection and System Wiring (NEW)

```typescript
import type {
  ShellExecutor,
  SubprocessRunner,
  FilesystemGateway,
} from '../dsh-adapter/types';
import type { SchedulingService } from '../scheduling/types';
import type { EnvironmentService } from '../environment-management/types';
import type { ProvenanceService } from '../provenance/types';
import type { DataManagementService } from '../data-management/types';
import type {
  ToolInvocationService,
  ToolCatalogService,
} from '../tool-invocation/types';
import type { FirecrestConfig } from '../firecrest-adapter/types';
import type { ResourceRequest } from '../types';

// ============================================================================
// BackendType
// ============================================================================

/**
 * The backend to use for HPC operations.
 *
 * Under R14 (ADR-012):
 * - `'firecrest'` (default): FirecREST is the only production HPC
 *   transport. dsh runs on the laptop. All HPC operations go through
 *   FirecREST's REST API. All ToolInvocations are parallel (F-INV-6).
 *   uenv is loaded in Job scripts (F-INV-5).
 * - `'dev'` (was `'local'`): For development and testing only. The
 *   dsh-adapter wraps local subprocess for ShellExecutor,
 *   SubprocessRunner, FilesystemGateway. Synchronous execution is
 *   possible. EnvironmentService is active.
 *
 * Spec: resolutions-r14.md R14.7; invariants-firecrest-primary.md
 * FP-INV-1; ADR-012.
 */
export type BackendType = 'firecrest' | 'dev';

// ============================================================================
// BackendSelection
// ============================================================================

/**
 * Selects which backend to use at startup.
 *
 * For `type: 'firecrest'`, `firecrestConfig` must be provided. The
 * `createCeraSystem()` factory creates all FirecREST-backed
 * interfaces from this configuration.
 *
 * For `type: 'dev'`, `firecrestConfig` is ignored (not required). The
 * factory creates all dsh-adapter-backed interfaces. In dev mode, a
 * `dshConfig` may be needed to connect to the local dsh instance.
 *
 * Spec: resolutions-r14.md R14.7; ADR-012;
 * invariants-firecrest-primary.md FP-INV-1, FP-INV-2.
 */
export interface BackendSelection {
  /** Backend type. Defaults to `'firecrest'` (FP-INV-1). */
  readonly type: BackendType;
  /**
   * FirecREST configuration. Required when `type === 'firecrest'`.
   * Ignored when `type === 'dev'`.
   *
   * Spec: specs/firecrest/api-contracts.md (FirecrestConfig);
   * ADR-012.
   */
  readonly firecrestConfig?: FirecrestConfig;
  /**
   * dsh configuration for dev mode. Required when `type === 'dev'`.
   * Provides connection details for the local dsh instance (dsh
   * session URL, etc.).
   *
   * Spec: ADR-005 (dsh isolation layer); ADR-012.
   */
  readonly dshConfig?: DshConfig;
}

/**
 * Configuration for connecting to a local dsh instance in dev mode.
 *
 * In dev mode (`--backend dev`), cera connects to a running dsh
 * instance on the HPC login node (or local machine). The dsh session
 * provides `ctx.shell`, `ctx.subprocess`, `ctx.fs`, `ctx.jobs`,
 * `ctx.tools`, `ctx.commands` — which the dsh-adapter wraps.
 *
 * Spec: ADR-005; ADR-012.
 */
export interface DshConfig {
  /** dsh session URL or connection descriptor. */
  readonly sessionUrl?: string;
  /**
   * System name for local SLURM (dev mode). Used by the local
   * SchedulingService. Default: same as the user's local system.
   */
  readonly systemName?: string;
}

// ============================================================================
// JobScriptConfig
// ============================================================================

/**
 * Configuration for building Job scripts with uenv prefixes (F-INV-5).
 *
 * Under R14, all ToolInvocations in production are submitted as SLURM
 * Jobs. The Job script must include `uenv start <spec> --` before the
 * Tool command. This configuration is passed to
 * `ToolInvocationService` (via `ToolInvocationServiceImplProps`) so
 * it can build Job scripts with the correct uenv prefix.
 *
 * In dev mode, this is absent — the `EnvironmentService` handles
 * uenv loading at runtime, and synchronous execution doesn't need
 * a Job script.
 *
 * Spec: invariants-firecrest-primary.md F-INV-5 (elevated to primary);
 * resolutions-r14.md R14.3; ADR-012.
 */
export interface JobScriptConfig {
  /**
   * uenv specs to embed in Job scripts (F-INV-5). Each spec is a
   * string like "cdo:2.0.5" or "python:3.11.6". These are prepended
   * as `uenv start <spec> --` before the Tool command in the Job
   * script.
   *
   * May be overridden per-ToolInvocation via the
   * `--uenv-specs` CLI flag or `ToolInvocationRequest` (if extended
   * in the future).
   *
   * Spec: invariants-firecrest-primary.md F-INV-5;
   * resolutions-r14.md R14.3.
   */
  readonly uenvSpecs?: readonly string[];
  /**
   * Default ResourceRequest for formerly-synchronous ToolInvocations
   * (FP-INV-5, resolves FCREST-05). Under R14, formerly-synchronous
   * ToolInvocations (which have no `resourceRequest`) must be
   * submitted as SLURM Jobs. This default provides minimal resources
   * (1 node, 1 core, minimal memory, short wall time, default
   * partition/QoS).
   *
   * When a ToolInvocationRequest has `resourceRequest` absent, this
   * default is supplied. When the ToolInvocationRequest has an
   * explicit `resourceRequest`, that takes precedence.
   *
   * Spec: invariants-firecrest-primary.md FP-INV-5;
   * resolutions-r14.md R14.4; ADR-012.
   */
  readonly defaultResourceRequest?: ResourceRequest;
}

// ============================================================================
// CeraSystemConfig
// ============================================================================

/**
 * Configuration for `createCeraSystem()`. The CLI builds this from
 * command-line arguments and environment variables, then calls
 * `createCeraSystem()` to get a fully-wired `CeraSystem`.
 *
 * Spec: ADR-012; this document.
 */
export interface CeraSystemConfig {
  /** Backend selection. Defaults to `{ type: 'firecrest' }` (FP-INV-1). */
  readonly backend: BackendSelection;
  /**
   * Job script configuration for the FirecREST backend (F-INV-5,
   * FP-INV-5). Ignored when `backend.type === 'dev'`.
   *
   * When provided, this is passed to `ToolInvocationService` so it
   * can build Job scripts with uenv prefixes and supply the default
   * `ResourceRequest` for formerly-synchronous ToolInvocations.
   *
   * When absent, `ToolInvocationService` uses its own defaults
   * (no uenv specs, no default `ResourceRequest` — this is only
   * valid in dev mode).
   */
  readonly jobScriptConfig?: JobScriptConfig;
  /**
   * Username for SLURM job queries (proactive reporting, R7).
   * In production, this is derived from the JWT token's
   * `preferred_username` claim. In dev mode, this is the local
   * username.
   */
  readonly username?: string;
}

// ============================================================================
// CeraSystem
// ============================================================================

/**
 * A fully-wired cera system. All 7 domain modules are instantiated
 * with the appropriate backend implementations. The CLI (or caller)
 * uses this object to start Sessions, register Actions, and enter
 * the agent loop.
 *
 * In production (`backend.type === 'firecrest'`):
 * - `shellExecutor` is `FirecrestShellExecutor`
 * - `subprocessRunner` is a FirecREST-backed SubprocessRunner
 * - `filesystemGateway` is `FirecRESTFilesystemGateway`
 * - `schedulingService` is `FirecRESTSchedulingService`
 * - `toolInvocationService` has NO `EnvironmentService` (FP-INV-3)
 * - `dataManagementService` uses `FirecRESTFilesystemGateway`
 * - `provenanceService` uses `FirecRESTFilesystemGateway`
 *
 * In dev mode (`backend.type === 'dev'`):
 * - `shellExecutor` is `dsh-adapter.ShellExecutor`
 * - `subprocessRunner` is `dsh-adapter.SubprocessRunner`
 * - `filesystemGateway` is `dsh-adapter.FilesystemGateway`
 * - `schedulingService` is the SLURM CLI implementation
 * - `toolInvocationService` HAS `EnvironmentService`
 * - `dataManagementService` uses `dsh-adapter.FilesystemGateway`
 * - `provenanceService` uses `dsh-adapter.FilesystemGateway`
 *
 * Spec: ADR-012; this document.
 */
export interface CeraSystem {
  /** ShellExecutor for CLI tool execution. */
  readonly shellExecutor: ShellExecutor;
  /** SubprocessRunner for fine-grained process control. */
  readonly subprocessRunner: SubprocessRunner;
  /** FilesystemGateway for filesystem access. */
  readonly filesystemGateway: FilesystemGateway;
  /** SchedulingService for SLURM job management. */
  readonly schedulingService: SchedulingService;
  /** ToolInvocationService for tool execution (incl. CESM). */
  readonly toolInvocationService: ToolInvocationService;
  /** ToolCatalogService for tool registration and queries. */
  readonly toolCatalogService: ToolCatalogService;
  /** DataManagementService for dataset lifecycle. */
  readonly dataManagementService: DataManagementService;
  /** ProvenanceService for provenance recording. */
  readonly provenanceService: ProvenanceService;
  // agentInteractionService: AgentInteractionService;
  // ^ Not included in this stub. The agent loop (dsh) wires
  //   AgentInteractionService separately, as it requires the LLM
  //   adapter which is provided by dsh, not by createCeraSystem().
  //   The agent-interaction module receives ToolInvocationService,
  //   DataManagementService, ProvenanceService, SchedulingService
  //   from the CeraSystem.
  /** EnvironmentService, present only in dev mode (FP-INV-3). */
  readonly environmentService?: EnvironmentService;
  /** The backend that was selected. */
  readonly backendType: BackendType;
}

// ============================================================================
// createCeraSystem — Factory
// ============================================================================

/**
 * Factory that wires all 7 domain modules based on the selected
 * backend.
 *
 * For `config.backend.type === 'firecrest'` (default):
 * - Creates `FirecRESTBackend` from `config.backend.firecrestConfig`.
 * - Creates `FirecRESTSchedulingService` (or uses the one from
 *   `FirecRESTBackend`).
 * - Creates `ToolInvocationService` with:
 *   - `shellExecutor` from `FirecRESTBackend`
 *   - `subprocessRunner` from `FirecRESTBackend`
 *   - `scheduling` from `FirecRESTSchedulingService`
 *   - `environment` = `undefined` (FP-INV-3 — no EnvironmentService
 *     in production)
 *   - `filesystemGateway` from `FirecRESTBackend`
 * - Creates `DataManagementService` with `FirecRESTFilesystemGateway`.
 * - Creates `ProvenanceService` with `FirecRESTFilesystemGateway`.
 * - The `JobScriptConfig` (if provided) is passed through to
 *   `ToolInvocationService` for uenv prefix construction and default
 *   `ResourceRequest` supply.
 *
 * For `config.backend.type === 'dev'`:
 * - Creates `dsh-adapter` interfaces from `config.backend.dshConfig`.
 * - Creates `SchedulingService` (SLURM CLI implementation).
 * - Creates `ToolInvocationService` with:
 *   - `shellExecutor` from `dsh-adapter`
 *   - `subprocessRunner` from `dsh-adapter`
 *   - `scheduling` from SLURM CLI implementation
 *   - `environment` = `EnvironmentServiceImpl` (active in dev mode)
 *   - `filesystemGateway` from `dsh-adapter`
 * - Creates `DataManagementService` with `dsh-adapter.FilesystemGateway`.
 * - Creates `ProvenanceService` with `dsh-adapter.FilesystemGateway`.
 *
 * @throws {Error} if `config.backend.type === 'firecrest'` and
 *   `config.backend.firecrestConfig` is not provided.
 * @throws {Error} if `config.backend.type === 'dev'` and
 *   `config.backend.dshConfig` is not provided (or dsh is not
 *   available).
 *
 * Spec: ADR-012; resolutions-r14.md R14.7;
 * invariants-firecrest-primary.md FP-INV-1, FP-INV-2, FP-INV-3,
 * FP-INV-4, FP-INV-5.
 */
export function createCeraSystem(config: CeraSystemConfig): CeraSystem;

// ============================================================================
// Module-by-module wiring details
// ============================================================================

/**
 * Wiring for the FirecREST backend (production).
 *
 * All 7 domain modules receive FirecREST-backed implementations.
 * The `EnvironmentService` is NOT passed to `ToolInvocationService`
 * (FP-INV-3). The `JobScriptConfig` provides uenv specs (F-INV-5) and
 * the default `ResourceRequest` (FP-INV-5).
 *
 * | Module | Implementation | Source |
 * |--------|---------------|--------|
 * | ShellExecutor | FirecrestShellExecutor | firecrest-adapter |
 * | SubprocessRunner | FirecrestSubprocessRunner | firecrest-adapter |
 * | FilesystemGateway | FirecrestFilesystemGateway | firecrest-adapter |
 * | SchedulingService | FirecRESTSchedulingService | firecrest-adapter |
 * | ToolInvocationService | ToolInvocationServiceImpl | tool-invocation (env = undefined) |
 * | DataManagementService | DataManagementServiceImpl | data-management (fs = FirecREST) |
 * | ProvenanceService | ProvenanceServiceImpl | provenance (fs = FirecREST) |
 * | EnvironmentService | ABSENT | (FP-INV-3 — not used in production) |
 */

/**
 * Wiring for the dev backend.
 *
 * All 7 domain modules receive dsh-adapter-backed implementations.
 * The `EnvironmentService` IS passed to `ToolInvocationService`
 * (active in dev mode).
 *
 * | Module | Implementation | Source |
 * |--------|---------------|--------|
 * | ShellExecutor | DshShellExecutor | dsh-adapter |
 * | SubprocessRunner | DshSubprocessRunner | dsh-adapter |
 * | FilesystemGateway | DshFilesystemGateway | dsh-adapter |
 * | SchedulingService | SlurmCliSchedulingService | scheduling (via SubprocessRunner) |
 * | ToolInvocationService | ToolInvocationServiceImpl | tool-invocation (env = EnvironmentServiceImpl) |
 * | DataManagementService | DataManagementServiceImpl | data-management (fs = dsh-adapter) |
 * | ProvenanceService | ProvenanceServiceImpl | provenance (fs = dsh-adapter) |
 * | EnvironmentService | EnvironmentServiceImpl | environment-management (active) |
 */

// ============================================================================
// Updated ToolInvocationServiceImplProps
// (already done — FCREST-01 fix, verified)
// ============================================================================

/**
 * NOTE: The `environment` field is already optional in the existing
 * code (`tool-invocation/tool-invocation-service.ts` line 358). This
 * was the FCREST-01 fix. No further interface change is needed for
 * the optional `EnvironmentService`.
 *
 * Under R14, a new optional `jobScriptConfig` field should be added
 * to pass uenv specs (F-INV-5) and the default `ResourceRequest`
 * (FP-INV-5) to the service. This is a backward-compatible addition
 * (optional field).
 *
 * Updated interface (additive only):
 *
 * ```typescript
 * export interface ToolInvocationServiceImplProps {
 *   readonly catalog: ToolCatalogService;
 *   readonly environment?: EnvironmentService;          // already optional (FCREST-01)
 *   readonly dataManagement: DataManagementService;
 *   readonly provenance: ProvenanceService;
 *   readonly scheduling: SchedulingService;
 *   readonly shellExecutor: ShellExecutor;
 *   readonly subprocessRunner: SubprocessRunner;
 *   readonly sandboxRunner?: SandboxRunner;
 *   readonly config?: Partial<ToolInvocationConfig>;
 *   readonly onEvent?: (event: ToolInvocationEvent) => void;
 *   // NEW under R14:
 *   readonly jobScriptConfig?: JobScriptConfig;          // F-INV-5, FP-INV-5
 * }
 * ```
 *
 * When `jobScriptConfig` is provided (production), the service:
 * 1. Uses `jobScriptConfig.uenvSpecs` to build the `uenv start <spec> --`
 *    prefix in the Job script.
 * 2. Uses `jobScriptConfig.defaultResourceRequest` when
 *    `request.resourceRequest` is absent (FP-INV-5).
 * 3. Always takes the parallel path (regardless of
 *    `request.executionModel`).
 *
 * When `jobScriptConfig` is absent (dev mode), the service:
 * 1. Uses `EnvironmentService` to verify the Environment before
 *    invocation (INV-T1 original).
 * 2. Dispatches on `request.executionModel` (synchronous or
 *    parallel).
 * 3. Requires `resourceRequest` for parallel execution (original
 *    behavior).
 *
 * Spec: invariants-firecrest-primary.md F-INV-5, FP-INV-3, FP-INV-5;
 * resolutions-r14.md R14.3, R14.4; ADR-012.
 */

// ============================================================================
// FirecrestConfig (already done — FCREST-05 fix, verified)
// ============================================================================

/**
 * NOTE: `FirecrestConfig.defaultResourceRequest` already exists in
 * `firecrest-adapter/types.ts` (line 87). This was the FCREST-05 fix.
 * The default value is provided in `DEFAULT_FIRECREST_CONFIG`
 * (lines 103-110): 1 node, 1 core, 1GB, 10 min, normal partition,
 * default QoS.
 *
 * No further interface change is needed for `FirecrestConfig`.
 *
 * The `createCeraSystem()` factory extracts `defaultResourceRequest`
 * from `FirecrestConfig` and passes it to `ToolInvocationService`
 * via `JobScriptConfig.defaultResourceRequest`.
 *
 * Spec: invariants-firecrest-primary.md FP-INV-5;
 * resolutions-r14.md R14.4; ADR-012.
 */

// ============================================================================
// BackendType change (local → dev)
// ============================================================================

/**
 * Under R14, the `--backend local` flag is replaced by `--backend
 * dev`. The `BackendType` is `'firecrest' | 'dev'` (was `'local' |
 * 'firecrest'`).
 *
 * This is a naming change, not a behavioral change. The `dev` value
 * selects the same dsh-adapter-backed interfaces that `local`
 * previously selected. The name change reflects that the local
 * backend is for development only, not a production option
 * (FP-INV-2).
 *
 * Spec: resolutions-r14.md R14.7;
 * invariants-firecrest-primary.md FP-INV-1, FP-INV-2; ADR-012.
 */

// ============================================================================
// Error Propagation
// ============================================================================

The error propagation pattern is **unchanged** from
`api-contracts.md`. All service methods throw `CeraError` subclasses.
The only change is that FirecREST-specific errors (`FirecrestError`
subclasses) may propagate from modules that use the FirecREST backend
in production. These are caught at the same levels as before:

- `tool-invocation` catches `EnvironmentError` (dev only),
  `DataError`, and `SchedulingError`, wrapping them in
  `ToolInvocationError` with context.
- `agent-interaction` catches `ToolInvocationError` and
  `SchedulingError`, translating them into user-facing messages.

FirecREST errors (`FirecrestTimeout`, `FirecrestUnauthorized`,
`FirecrestRateLimited`, `FirecrestUnavailable`, `FirecrestSshError`,
etc.) propagate from the adapter interfaces (ShellExecutor,
FilesystemGateway, SchedulingService) and are caught by the domain
modules that use them. The domain modules do NOT import
FirecREST-specific error types — they catch the generic `Error` or
the adapter interface's documented error types.
