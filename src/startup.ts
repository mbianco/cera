/**
 * Startup wiring — factory that wires all 7 domain modules based
 * on the selected backend (ADR-012, R14).
 *
 * For `type: 'firecrest'` (default, production):
 * - Creates all FirecREST-backed interfaces from `FirecrestConfig`.
 * - `EnvironmentService` is NOT passed to `ToolInvocationService`
 *   (FP-INV-3). uenv is loaded in Job scripts (F-INV-5).
 * - `JobScriptConfig` provides uenv specs and default
 *   `ResourceRequest` (FP-INV-5).
 *
 * For `type: 'dev'` (development only):
 * - Creates all dsh-adapter-backed interfaces.
 * - `EnvironmentService` IS passed to `ToolInvocationService`
 *   (active in dev mode).
 *
 * Spec: ADR-012; resolutions-r14.md R14.7;
 * api-contracts-firecrest.md; invariants-firecrest-primary.md.
 */

import type {
  ShellExecutor,
  SubprocessRunner,
  FilesystemGateway,
} from './dsh-adapter/types';
import type { SchedulingService } from './scheduling/types';
import type { EnvironmentService } from './environment-management/types';
import type { ProvenanceService } from './provenance/types';
import type { DataManagementService } from './data-management/types';
import type {
  ToolInvocationService,
  ToolCatalogService,
} from './tool-invocation/types';
import type { ResourceRequest, Job, JobId, UserId } from './types';
import type { FirecrestConfig, FirecrestClient, FirecrestJob } from './firecrest-adapter/types';
import { isTerminalJobState } from './types/value-objects';
import { FirecrestClientImpl } from './firecrest-adapter/firecrest-client';
import { FirecrestShellExecutor } from './firecrest-adapter/shell-executor';
import { FirecrestSubprocessRunner } from './firecrest-adapter/subprocess-runner';
import { FirecrestFilesystemGateway } from './firecrest-adapter/filesystem-gateway';
import { buildJobScript } from './firecrest-adapter/job-script-builder';
import { parseSLURMStateString } from './scheduling/slurm-parser';
import { SchedulingServiceImpl } from './scheduling/scheduling-service';
import { DataManagementServiceImpl } from './data-management/data-management-service';
import { ProvenanceServiceImpl } from './provenance/provenance-service';
import { EnvironmentServiceImpl } from './environment-management/environment-service';
import { ToolCatalogServiceImpl } from './tool-invocation/tool-catalog';
import { ToolInvocationServiceImpl } from './tool-invocation/tool-invocation-service';
import { createDshAdapter } from './dsh-adapter/factory';
import type { DshContext } from './dsh-adapter/context';

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
// JobScriptConfig
// ============================================================================

/**
 * Configuration for building Job scripts with uenv prefixes (F-INV-5).
 *
 * Under R14, all ToolInvocations in production are submitted as SLURM
 * Jobs. The Job script must include `uenv start <spec> --` before the
 * Tool command. This configuration is passed to `ToolInvocationService`
 * so it can build Job scripts with the correct uenv prefix.
 *
 * In dev mode, this is absent — the `EnvironmentService` handles uenv
 * loading at runtime, and synchronous execution doesn't need a Job
 * script.
 *
 * Spec: invariants-firecrest-primary.md F-INV-5; resolutions-r14.md
 * R14.3; ADR-012.
 */
export interface JobScriptConfig {
  /**
   * uenv specs to embed in Job scripts (F-INV-5). Each spec is a
   * string like "cdo:2.0.5" or "python:3.11.6".
   */
  readonly uenvSpecs?: readonly string[];
  /**
   * Default ResourceRequest for formerly-synchronous ToolInvocations
   * (FP-INV-5). When a ToolInvocationRequest has `resourceRequest`
   * absent, this default is supplied.
   */
  readonly defaultResourceRequest?: ResourceRequest;
}

// ============================================================================
// BackendSelection
// ============================================================================

/**
 * Selects which backend to use at startup.
 *
 * Spec: resolutions-r14.md R14.7; ADR-012;
 * invariants-firecrest-primary.md FP-INV-1, FP-INV-2.
 */
export interface BackendSelection {
  /** Backend type. Defaults to `'firecrest'` (FP-INV-1). */
  readonly type: BackendType;
  /** FirecREST configuration. Required when `type === 'firecrest'`. */
  readonly firecrestConfig?: FirecrestConfig;
  /** dsh configuration for dev mode. Required when `type === 'dev'`. */
  readonly dshConfig?: DshConfig;
}

/**
 * Configuration for connecting to a local dsh instance in dev mode.
 *
 * `context` is an optional pre-created `DshContext` (for testing or
 * when dsh is already connected). If `context` is not provided, the
 * factory expects `sessionUrl` to connect to a running dsh instance.
 *
 * Spec: ADR-005; ADR-012.
 */
export interface DshConfig {
  readonly sessionUrl?: string;
  readonly systemName?: string;
  /**
   * Pre-created DshContext (for testing or when dsh is already
   * connected). When provided, the factory uses this context to
   * create the dsh-adapter. When not provided, the factory expects
   * `sessionUrl` to connect to a running dsh instance.
   */
  readonly context?: DshContext;
}

// ============================================================================
// CeraSystemConfig
// ============================================================================

/**
 * Configuration for `createCeraSystem()`. The CLI builds this from
 * command-line arguments and environment variables.
 *
 * Spec: ADR-012; api-contracts-firecrest.md.
 */
export interface CeraSystemConfig {
  /** Backend selection. Defaults to `{ type: 'firecrest' }` (FP-INV-1). */
  readonly backend: BackendSelection;
  /**
   * Job script configuration for the FirecREST backend (F-INV-5,
   * FP-INV-5). Ignored when `backend.type === 'dev'`.
   */
  readonly jobScriptConfig?: JobScriptConfig;
  /**
   * Username for SLURM job queries (proactive reporting, R7).
   * In production, derived from the JWT token. In dev, the local
   * username.
   */
  readonly username?: string;
}

// ============================================================================
// CeraSystem
// ============================================================================

/**
 * A fully-wired cera system. All 7 domain modules are instantiated
 * with the appropriate backend implementations.
 *
 * In production (`backend.type === 'firecrest'`):
 * - `shellExecutor` is `FirecrestShellExecutor`
 * - `subprocessRunner` is `FirecrestSubprocessRunner`
 * - `filesystemGateway` is `FirecrestFilesystemGateway`
 * - `schedulingService` is `FirecrestSchedulingService`
 * - `toolInvocationService` has NO `EnvironmentService` (FP-INV-3)
 * - `dataManagementService` uses `FirecrestFilesystemGateway`
 * - `provenanceService` uses `FirecrestFilesystemGateway`
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
 * Spec: ADR-012; api-contracts-firecrest.md.
 */
export interface CeraSystem {
  readonly shellExecutor: ShellExecutor;
  readonly subprocessRunner: SubprocessRunner;
  readonly filesystemGateway: FilesystemGateway;
  readonly schedulingService: SchedulingService;
  readonly toolInvocationService: ToolInvocationService;
  readonly toolCatalogService: ToolCatalogService;
  readonly dataManagementService: DataManagementService;
  readonly provenanceService: ProvenanceService;
  readonly environmentService?: EnvironmentService;
  readonly backendType: BackendType;
}

// ============================================================================
// createCeraSystem — Factory
// ============================================================================

/**
 * Factory that wires all 7 domain modules based on the selected
 * backend.
 *
 * For `type: 'firecrest'` (default):
 * - Creates FirecREST-backed interfaces from `firecrestConfig`.
 * - `EnvironmentService` is NOT passed to `ToolInvocationService`
 *   (FP-INV-3). uenv is loaded in Job scripts (F-INV-5).
 * - `JobScriptConfig` provides uenv specs and default
 *   `ResourceRequest` (FP-INV-5).
 *
 * For `type: 'dev'`:
 * - Creates dsh-adapter-backed interfaces from `dshConfig`.
 * - `EnvironmentService` IS passed to `ToolInvocationService`.
 *
 * @throws {Error} if `type === 'firecrest'` and `firecrestConfig`
 *   is not provided.
 * @throws {Error} if `type === 'dev'` and `dshConfig` is not
 *   provided.
 *
 * Spec: ADR-012; resolutions-r14.md R14.7;
 * invariants-firecrest-primary.md FP-INV-1–5.
 */
export function createCeraSystem(config: CeraSystemConfig): CeraSystem {
  if (config.backend.type === 'firecrest') {
    return createFirecrestSystem(config);
  }
  return createDevSystem(config);
}

// ============================================================================
// Private: FirecREST system (production)
// ============================================================================

/**
 * Creates a FirecREST-backed cera system.
 *
 * All HPC operations go through FirecREST's REST API. No
 * `EnvironmentService` — uenv is loaded in Job scripts (F-INV-5).
 * All ToolInvocations are parallel (F-INV-6).
 *
 * Spec: ADR-012; api-contracts-firecrest.md.
 */
function createFirecrestSystem(config: CeraSystemConfig): CeraSystem {
  const firecrestConfig = config.backend.firecrestConfig;
  if (firecrestConfig === undefined) {
    throw new Error(
      'FirecrestConfig is required for the firecrest backend (FP-INV-1). ' +
      'Provide --firecrest-url, --system, --token-endpoint, ' +
      '--client-id, and --client-secret.',
    );
  }

  // Create the FirecREST HTTP client from the config.
  const client = new FirecrestClientImpl(firecrestConfig);
  const systemName = firecrestConfig.systemName;

  // Create FirecREST-backed adapter interfaces.
  const shellExecutor = new FirecrestShellExecutor(client, systemName);
  const subprocessRunner = new FirecrestSubprocessRunner(client, systemName);
  const filesystemGateway = new FirecrestFilesystemGateway(client, systemName);

  // Create the FirecREST-backed SchedulingService (FP-INV-4 —
  // SLURM CLI is NOT used in production).
  const schedulingService = new FirecrestSchedulingService(client, systemName);

  // Create the ToolCatalogService.
  const toolCatalogService = new ToolCatalogServiceImpl();

  // Create the ProvenanceService with the FirecREST FilesystemGateway
  // (F-INV-7 — Provenance written via FirecREST filesystem endpoints).
  const provenanceService = new ProvenanceServiceImpl({
    filesystem: filesystemGateway,
  });

  // Create the DataManagementService with the FirecREST
  // FilesystemGateway.
  const dataManagementService = new DataManagementServiceImpl({
    filesystem: filesystemGateway,
    provenance: provenanceService,
  });

  // Create the ToolInvocationService with NO EnvironmentService
  // (FP-INV-3) and the JobScriptConfig (F-INV-5, FP-INV-5).
  const toolInvocationService = new ToolInvocationServiceImpl({
    catalog: toolCatalogService,
    environment: undefined, // FP-INV-3 — no EnvironmentService in production
    dataManagement: dataManagementService,
    provenance: provenanceService,
    scheduling: schedulingService,
    shellExecutor,
    subprocessRunner,
    jobScriptConfig: config.jobScriptConfig, // F-INV-5, FP-INV-5
  });

  return {
    shellExecutor,
    subprocessRunner,
    filesystemGateway,
    schedulingService,
    toolInvocationService,
    toolCatalogService,
    dataManagementService,
    provenanceService,
    backendType: 'firecrest',
    // No environmentService — FP-INV-3
  };
}

// ============================================================================
// Private: Dev system (development only)
// ============================================================================

/**
 * Creates a dsh-adapter-backed cera system for development.
 *
 * Uses local subprocess for ShellExecutor, SubprocessRunner,
 * FilesystemGateway. EnvironmentService is active. Synchronous
 * execution is possible.
 *
 * Spec: ADR-012; api-contracts-firecrest.md.
 */
function createDevSystem(config: CeraSystemConfig): CeraSystem {
  const dshConfig = config.backend.dshConfig;
  if (dshConfig === undefined) {
    throw new Error(
      'DshConfig is required for the dev backend. ' +
      'Provide a dsh session URL or run on a machine with dsh available.',
    );
  }

  // Create the dsh-adapter from the provided DshContext.
  // If dshConfig.context is not provided, we cannot create the adapter
  // without connecting to a running dsh instance.
  if (dshConfig.context === undefined) {
    throw new Error(
      'DshConfig.context is required for the dev backend. ' +
      'Provide a pre-created DshContext (from a running dsh instance) ' +
      'via dshConfig.context.',
    );
  }

  const adapter = createDshAdapter(dshConfig.context);

  // Create the SLURM CLI SchedulingService (dev-only, FP-INV-4).
  const userId = (config.username ?? 'dev_user') as UserId;
  const schedulingService = new SchedulingServiceImpl({
    subprocessRunner: adapter.subprocessRunner,
    shellExecutor: adapter.shellExecutor,
    userId,
  });

  // Create the ToolCatalogService.
  const toolCatalogService = new ToolCatalogServiceImpl();

  // Create the ProvenanceService with the dsh-adapter
  // FilesystemGateway (local filesystem in dev mode).
  const provenanceService = new ProvenanceServiceImpl({
    filesystem: adapter.filesystemGateway,
  });

  // Create the DataManagementService with the dsh-adapter
  // FilesystemGateway.
  const dataManagementService = new DataManagementServiceImpl({
    filesystem: adapter.filesystemGateway,
    provenance: provenanceService,
  });

  // Create the EnvironmentService (active in dev mode, FP-INV-3).
  const environmentService = new EnvironmentServiceImpl({
    subprocessRunner: adapter.subprocessRunner,
    shellExecutor: adapter.shellExecutor,
    filesystem: adapter.filesystemGateway,
  });

  // Create the ToolInvocationService WITH EnvironmentService
  // (active in dev mode) and WITHOUT jobScriptConfig (dev mode
  // dispatches on request.executionModel).
  const toolInvocationService = new ToolInvocationServiceImpl({
    catalog: toolCatalogService,
    environment: environmentService, // active in dev mode
    dataManagement: dataManagementService,
    provenance: provenanceService,
    scheduling: schedulingService,
    shellExecutor: adapter.shellExecutor,
    subprocessRunner: adapter.subprocessRunner,
  });

  return {
    shellExecutor: adapter.shellExecutor,
    subprocessRunner: adapter.subprocessRunner,
    filesystemGateway: adapter.filesystemGateway,
    schedulingService,
    toolInvocationService,
    toolCatalogService,
    dataManagementService,
    provenanceService,
    environmentService, // present in dev mode
    backendType: 'dev',
  };
}

// ============================================================================
// FirecrestSchedulingService (production scheduling, FP-INV-4)
// ============================================================================

/**
 * SchedulingService implementation via FirecREST compute endpoints
 * (FP-INV-4 — SLURM CLI is NOT used in production).
 *
 * Submits Jobs via POST /compute/{system}/jobs, queries state via
 * GET /compute/{system}/jobs/{id}, cancels via DELETE
 * /compute/{system}/jobs/{id}, and lists Jobs via GET
 * /compute/{system}/jobs.
 *
 * The Job script is built using `buildJobScript` (from
 * firecrest-adapter/job-script-builder.ts) with optional uenv specs
 * (F-INV-5).
 *
 * Spec: resolutions-r14.md R14.6; ADR-012;
 * invariants-firecrest-primary.md FP-INV-4, F-INV-6.
 */
class FirecrestSchedulingService implements SchedulingService {
  #client: FirecrestClient;
  #systemName: string;
  #userId: UserId;
  #jobs: Map<number, Job> = new Map();

  constructor(client: FirecrestClient, systemName: string) {
    this.#client = client;
    this.#systemName = systemName;
    this.#userId = 'firecrest-user' as UserId;
  }

  async submitJob(request: import('./scheduling/types').SubmitJobInput): Promise<Job> {
    // Build the Job script with optional uenv specs (F-INV-5).
    // Extract uenv specs from the UENV_SPECS_KEY environment variable.
    const uenvSpecsStr = request.environmentVars?.['__CERA_UENV_SPECS__'];
    const uenvSpecs = uenvSpecsStr !== undefined && uenvSpecsStr.length > 0
      ? uenvSpecsStr.split(',').filter((s) => s.length > 0)
      : undefined;

    // Build regular env vars (excluding UENV_SPECS_KEY).
    const regularEnv: Record<string, string> = {};
    if (request.environmentVars !== undefined) {
      for (const [key, value] of Object.entries(request.environmentVars)) {
        if (key !== '__CERA_UENV_SPECS__') {
          regularEnv[key] = value;
        }
      }
    }

    const jobScript = buildJobScript(request.command, {
      uenvSpecs,
      env: Object.keys(regularEnv).length > 0 ? regularEnv : undefined,
    });

    // Submit the Job via POST /compute/{system}/jobs (F-INV-6).
    const response = await this.#client.post<{ jobId: number; state: string }>(
      `/compute/${this.#systemName}/jobs`,
      { jobScript },
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Job submission failed with status ${response.statusCode}: ` +
        `${JSON.stringify(response.body)}`,
      );
    }

    const body = response.body;
    if (body === undefined || body === null || typeof body !== 'object') {
      throw new Error('Job submission response is missing job data');
    }

    const jobId = body.jobId;
    if (typeof jobId !== 'number' || !Number.isFinite(jobId)) {
      throw new Error(`Job submission response has invalid jobId: ${String(jobId)}`);
    }

    const state = parseSLURMStateString(body.state);
    const job: Job = {
      jobId: jobId as JobId,
      userId: this.#userId,
      resourceRequest: request.resourceRequest,
      state,
      terminalState: isTerminalJobState(state) ? state : null,
      submittedAt: new Date(),
      completedAt: isTerminalJobState(state) ? new Date() : null,
    };

    this.#jobs.set(jobId, job);
    return job;
  }

  async queryJob(jobId: JobId): Promise<Job> {
    const jobIdNumber = jobId as number;
    const response = await this.#client.get<FirecrestJob>(
      `/compute/${this.#systemName}/jobs/${jobIdNumber}`,
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Job query failed with status ${response.statusCode}: ` +
        `${JSON.stringify(response.body)}`,
      );
    }

    const fj = response.body;
    if (fj === undefined || fj === null || typeof fj !== 'object') {
      throw new Error('Job query response is missing job data');
    }

    return this.#mapFirecrestJob(fj, jobId);
  }

  async queryJobsByUser(username: string): Promise<Job[]> {
    const response = await this.#client.get<FirecrestJob[]>(
      `/compute/${this.#systemName}/jobs?user=${encodeURIComponent(username)}`,
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Job query by user failed with status ${response.statusCode}: ` +
        `${JSON.stringify(response.body)}`,
      );
    }

    const jobs = response.body;
    if (!Array.isArray(jobs)) {
      return [];
    }

    return jobs.map((fj) => {
      const jobId = fj.jobId as JobId;
      return this.#mapFirecrestJob(fj, jobId);
    });
  }

  async cancelJob(jobId: JobId): Promise<void> {
    const jobIdNumber = jobId as number;
    const response = await this.#client.delete<unknown>(
      `/compute/${this.#systemName}/jobs/${jobIdNumber}`,
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Job cancellation failed with status ${response.statusCode}: ` +
        `${JSON.stringify(response.body)}`,
      );
    }

    // Update the cached Job to CANCELLED (INV-S4).
    const cached = this.#jobs.get(jobIdNumber);
    if (cached !== undefined) {
      this.#jobs.set(jobIdNumber, {
        ...cached,
        state: 'CANCELLED',
        terminalState: 'CANCELLED',
        completedAt: new Date(),
      });
    }
  }

  async reconcileViaSacct(jobIds: JobId[]): Promise<Job[]> {
    // In production, reconcileViaSacct maps to a fresh FirecREST
    // job query (GET /compute/{system}/jobs with state filter)
    // instead of the sacct CLI.
    if (jobIds.length === 0) {
      return [];
    }

    const results: Job[] = [];
    for (const jobId of jobIds) {
      try {
        const job = await this.queryJob(jobId);
        results.push(job);
      } catch {
        // Skip Jobs that can't be queried (e.g., already purged).
      }
    }
    return results;
  }

  /**
   * Maps a FirecrestJob to a cera Job. Uses the cached
   * ResourceRequest if available (the FirecREST job query response
   * does not include the original ResourceRequest).
   */
  #mapFirecrestJob(fj: FirecrestJob, jobId: JobId): Job {
    const state = parseSLURMStateString(fj.state);
    const cached = this.#jobs.get(fj.jobId);
    const job: Job = {
      jobId,
      userId: this.#userId,
      resourceRequest: cached?.resourceRequest ?? {
        nodes: 0,
        coresPerNode: 0,
        memory: '0',
        wallTime: '00:00:00',
        partition: 'unknown',
        qos: 'unknown',
      },
      state,
      terminalState: isTerminalJobState(state) ? state : null,
      submittedAt: cached?.submittedAt ?? new Date(),
      completedAt: isTerminalJobState(state) ? new Date() : null,
    };

    if (cached !== undefined) {
      this.#jobs.set(fj.jobId, job);
    }

    return job;
  }
}
