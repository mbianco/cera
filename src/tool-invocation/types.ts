/**
 * Public types for the tool-invocation module (C1 — including CESM).
 *
 * CESM is a Model Tool subtype in C1, not a peer entity (R1, ADR-001).
 * The Case lifecycle (create → configure → build → submit → monitor →
 * post-process) is a specialized ToolInvocation lifecycle.
 *
 * Invariants enforced:
 * - INV-T1: Environment loaded and verified before invocation.
 * - INV-T2: Single exit outcome per invocation (exit code or signal).
 * - INV-T3: Output registration gated on success (R4 strict default).
 * - INV-T4: Input Datasets opened for reading only.
 * - INV-T5: Signal vs exit-code distinction preserved.
 * - INV-T6: Submit requires built Case.
 * - INV-T7: One running Job per Case.
 * - INV-T8: Run length bounded by Wall Time.
 * - INV-T9: Output tree location known before submission.
 *
 * Spec references: api-contracts.md §6; module-graph.md §6;
 * invariants.md INV-T1–T9; failure-modes.md FM-T1–T5, FM-M1–M5;
 * resolutions.md R1, R4, R5; ADR-001, ADR-008.
 */

import type {
  AsyncObservable,
  Case,
  CaseId,
  CaseState,
  Compset,
  Dataset,
  DatasetId,
  Duration,
  ExperimentId,
  Location,
  ProvenanceRecord,
  ResourceRequest,
  Tool,
  ToolId,
  ToolInvocation,
  ToolInvocationEvent,
  ToolInvocationId,
} from '../types';

// ============================================================================
// ToolInvocationRequest
// ============================================================================

/**
 * Input for creating and executing a ToolInvocation.
 *
 * The service coordinates the full lifecycle: validate → verify
 * Environment → validate Locations → start → monitor → complete/fail.
 *
 * `executionModel`: 'synchronous' for short CLI calls on login nodes,
 * 'parallel' for large operations submitted as SLURM Jobs.
 *
 * `permissiveExitCodes` (R4, ADR-008): empty by default. Non-zero exit
 * codes are errors unless the User explicitly lists them here as
 * permissive for this specific ToolInvocation.
 *
 * Spec: api-contracts.md §6 (ToolInvocationRequest).
 */
export interface ToolInvocationRequest {
  readonly toolId: ToolId;
  readonly parameters: Record<string, unknown>;
  readonly inputDatasetIds: readonly DatasetId[];
  readonly outputLocation: Location;
  readonly executionModel: 'synchronous' | 'parallel';
  /**
   * Required for 'parallel' execution. Passed to
   * scheduling.submitJob().
   */
  readonly resourceRequest?: ResourceRequest;
  /**
   * R4 (strict exit codes): empty by default. Non-zero exit codes
   * are errors unless the User explicitly lists them here as
   * permissive for this specific ToolInvocation.
   */
  readonly permissiveExitCodes?: readonly number[];
}

// ============================================================================
// ToolInvocationResult
// ============================================================================

/**
 * Result of a ToolInvocation. The `outputDatasets` array is empty if
 * the invocation failed (INV-T3 — output registration gated on
 * success).
 *
 * A ProvenanceRecord is always written (X4), regardless of success or
 * failure. For failed invocations, `outputDatasetId` is null in the
 * record.
 *
 * Spec: api-contracts.md §6 (ToolInvocationResult).
 */
export interface ToolInvocationResult {
  readonly invocation: ToolInvocation;
  readonly outputDatasets: readonly Dataset[];
  readonly provenanceRecord: ProvenanceRecord;
}

// ============================================================================
// CreateCaseInput
// ============================================================================

/**
 * Input for creating a new CESM Case. The output tree Location is
 * determined at creation time (R5, INV-T9) and does not change.
 *
 * `experimentId` is accepted WITHOUT synchronous validation (FINDING-02,
 * eventual consistency). The dependency graph (Phase 4) prohibits
 * tool-invocation from importing agent-interaction (Phase 5).
 * Validation happens asynchronously when agent-interaction.
 * addCaseToExperiment() is called.
 *
 * Spec: api-contracts.md §6 (CreateCaseInput); ADR-001.
 */
export interface CreateCaseInput {
  readonly name: string;
  readonly compset: Compset;
  readonly resolution: string;
  readonly machine: string;
  readonly runLength: Duration;
  /**
   * R2: Case belongs to exactly one Experiment. NOT validated
   * synchronously (FINDING-02, eventual consistency).
   */
  readonly experimentId: ExperimentId;
}

// ============================================================================
// CaseConfig
// ============================================================================

/**
 * Configuration for a CESM Case. Applied during `configureCase()`
 * (CESM's `case.setup` / XML configuration).
 *
 * Spec: api-contracts.md §6 (CaseConfig).
 */
export interface CaseConfig {
  readonly runLength?: Duration;
  readonly calendar?: string; // e.g., "noleap"
  readonly stopOption?: string; // e.g., "nyears"
  readonly customXml?: Record<string, string>;
}

// ============================================================================
// ToolCatalogService
// ============================================================================

/**
 * Simple registry of Tools (CLITool, PythonTool, ModelTool). Used by
 * agent-interaction (Phase 5) to validate LLM-generated Tool names
 * (R12: refuse and ask if not in catalog).
 *
 * Spec: api-contracts.md §6 (ToolCatalogService).
 */
export interface ToolCatalogService {
  /**
   * Returns all registered Tools. Used by agent-interaction to
   * validate LLM-generated Tool names (R12: refuse and ask if not
   * in catalog).
   */
  getToolCatalog(): Promise<readonly Tool[]>;

  /**
   * Registers a Tool in the catalog. If a Tool with the same id
   * already exists, it is replaced.
   */
  registerTool(tool: Tool): Promise<void>;

  /**
   * Queries a single Tool by identity. Returns null if the Tool
   * is not in the catalog.
   */
  getTool(toolId: ToolId): Promise<Tool | null>;
}

// ============================================================================
// ToolInvocationService
// ============================================================================

/**
 * The core service for creating and executing ToolInvocations.
 *
 * The full lifecycle of `invokeTool()`:
 * 1. Validate: Tool exists in catalog, parameters match Tool schema,
 *    input Datasets exist with Provenance (INV-W1, INV-D3).
 * 2. Verify Environment: load and verify the Tool's required
 *    Environment via environment-management (INV-T1, INV-E2).
 *    Re-verify immediately before execution.
 * 3. Validate Locations: input Locations resolve to readable paths,
 *    output Location resolves to writable path (INV-D4).
 * 4. Start: enter RUNNING state. If execution model is 'parallel',
 *    delegate to scheduling.submitJob() (X2). Otherwise, execute
 *    synchronously via dsh-adapter (ShellExecutor or SubprocessRunner).
 * 5. Monitor: if parallel, poll scheduling.queryJob() until terminal
 *    state (INV-S1). If synchronous, wait for process.
 * 6. Complete/Fail: record ExitOutcome (INV-T2, INV-T5). If success
 *    (exit code 0, or in permissiveExitCodes — R4): write
 *    ProvenanceRecord (X4), register output Dataset via
 *    data-management, mark consumable. If failure: write
 *    ProvenanceRecord with null output, do NOT register output
 *    Dataset (INV-T3).
 *
 * Spec: api-contracts.md §6 (ToolInvocationService);
 * invariants.md INV-T1–T5; failure-modes.md FM-T1–T5;
 * resolutions.md R4; ADR-008.
 */
export interface ToolInvocationService {
  /**
   * Creates and executes a ToolInvocation.
   *
   * @throws {import('../types/errors').EnvironmentNotLoaded} if the
   *   required Environment is not loaded (INV-T1).
   * @throws {import('../types/errors').InputNotFound} if an input
   *   Dataset does not exist (FM-T5).
   * @throws {import('../types/errors').InputMissingProvenance} if an
   *   input Dataset has no ProvenanceRecord (INV-D3, INV-W1).
   * @throws {import('../types/errors').InvalidParameters} if
   *   parameters do not match the Tool schema (FM-A2, FM-T4).
   * @throws {import('../types/errors').ToolNotFound} if the Tool is
   *   not in the catalog (FM-A1).
   * @throws {import('../types/errors').NonZeroExitCode} if the Tool
   *   exits with a non-zero code (strict default, R4).
   * @throws {import('../types/errors').SignalTerminated} if the Tool
   *   is terminated by a signal (INV-T5, FM-T1, FM-T2).
   */
  invokeTool(request: ToolInvocationRequest): Promise<ToolInvocationResult>;

  /**
   * Returns an AsyncObservable for monitoring a running
   * ToolInvocation (especially long-running parallel Jobs). Emits
   * ToolInvocationEvent as the invocation progresses: created,
   * started, completed, failed, signal_terminated.
   */
  monitorInvocation(invocationId: ToolInvocationId): AsyncObservable<ToolInvocationEvent>;
}

// ============================================================================
// CaseService (CESM lifecycle)
// ============================================================================

/**
 * CESM Case lifecycle service. CESM is a Model Tool (R1, ADR-001).
 * The Case lifecycle is a specialized ToolInvocation lifecycle:
 * create → configure → build → submit → monitor → post-process.
 *
 * Invariants enforced:
 * - INV-T6: Submit requires built Case (submitCase rejects if not BUILT).
 * - INV-T7: One running Job per Case (submitCase rejects if a Job is
 *   already RUNNING).
 * - INV-T8: Run length bounded by Wall Time (submitCase validates at
 *   submission, not at runtime).
 * - INV-T9: Output tree location known before submission (set at
 *   creation per R5, validated as writable at submission).
 *
 * Spec: api-contracts.md §6 (CaseService); invariants.md INV-T6–T9;
 * failure-modes.md FM-M1–M5; resolutions.md R1, R5; ADR-001.
 */
export interface CaseService {
  /**
   * Creates a new CESM Case. The output tree Location is determined
   * at creation time (R5, INV-T9) and does not change. Case state is
   * CREATED.
   *
   * NOTE (FINDING-02): The `experimentId` is accepted WITHOUT
   * synchronous validation. Validation happens asynchronously when
   * agent-interaction.addCaseToExperiment() is called.
   *
   * @throws {import('../types/errors').InvalidParameters} if compset,
   *   resolution, or machine target is invalid.
   */
  createCase(input: CreateCaseInput): Promise<Case>;

  /**
   * Configures the Case (CESM's `case.setup` / XML configuration).
   * Case state: CREATED → CONFIGURED.
   *
   * This is a ToolInvocation (CESM is a Model Tool).
   *
   * @throws {import('../types/errors').NonZeroExitCode} if
   *   configuration fails (FM-M5). Case remains in CREATED state.
   */
  configureCase(caseId: CaseId, config: CaseConfig): Promise<Case>;

  /**
   * Builds the Case (CESM's `case.build`). Case state: CONFIGURED →
   * BUILT on success, remains CONFIGURED on failure (FM-M1).
   *
   * This is a ToolInvocation (CESM is a Model Tool).
   *
   * @throws {import('../types/errors').NonZeroExitCode} if build
   *   fails. The build log is captured.
   * @throws {import('../types/errors').EnvironmentNotLoaded} if the
   *   CESM Environment (compiler + MPI) is not loaded.
   */
  buildCase(caseId: CaseId): Promise<Case>;

  /**
   * Submits the Case via `case.submit`, which creates a SLURM Job
   * via scheduling.submitJob().
   *
   * Preconditions (validated before submission):
   * - Case must be in BUILT state (INV-T6).
   * - Run length must not exceed Wall Time (INV-T8).
   * - Output tree Location must be set and writable (INV-T9).
   * - No RUNNING Job already exists for this Case (INV-T7).
   * - CESM Environment must be verified (re-verified before submit).
   *
   * Case state: BUILT → SUBMITTED. A ProvenanceRecord is created
   * for the Job.
   *
   * @throws {import('../types/errors').CaseNotBuilt} if Case is not
   *   in BUILT state (INV-T6).
   * @throws {import('../types/errors').RunLengthExceedsWallTime} if
   *   run length > wall time (INV-T8).
   * @throws {import('../types/errors').OutputLocationNotSet} if
   *   output tree Location is not set (INV-T9).
   * @throws {import('../types/errors').CaseAlreadyRunning} if a Job
   *   is already RUNNING for this Case (INV-T7).
   */
  submitCase(caseId: CaseId, resourceRequest: ResourceRequest): Promise<Case>;

  /**
   * Monitors the Case's Job via scheduling.queryJob() until a
   * terminal state is reached. Case state transitions: SUBMITTED →
   * RUNNING → COMPLETED/FAILED/TIMEOUT/CANCELLED.
   *
   * Returns an AsyncObservable for streaming state changes.
   */
  monitorCase(caseId: CaseId): AsyncObservable<CaseState>;

  /**
   * After the Job reaches COMPLETED, scans the output tree at the
   * recorded Location and registers Datasets via
   * data-management.registerDataset(). Each Dataset gets a
   * ProvenanceRecord referencing the Job.
   *
   * This is the "post-process" phase of the Case lifecycle.
   */
  registerCaseOutput(caseId: CaseId): Promise<readonly Dataset[]>;
}

// ============================================================================
// Branded ID helpers (internal to this module)
// ============================================================================

/**
 * Creates a ToolInvocationId from a string. Uses a type assertion
 * because the brand symbol is private to value-objects.ts.
 */
export function createToolInvocationId(id: string): ToolInvocationId {
  return id as ToolInvocationId;
}

/**
 * Creates a CaseId from a string. Uses a type assertion because
 * the brand symbol is private to value-objects.ts.
 */
export function createCaseId(id: string): CaseId {
  return id as CaseId;
}

// ============================================================================
// ToolInvocationConfig
// ============================================================================

/**
 * Configuration for the ToolInvocationService.
 *
 * `caseOutputBasePath` — the base filesystem path under which CESM
 * Case output trees are created (R5). Each Case's output tree is at
 * `<caseOutputBasePath>/<caseName>/run/`.
 *
 * `pollIntervalMs` — polling interval for parallel Job monitoring
 * (milliseconds). Default: 30_000 (matches R13).
 *
 * `commandTimeoutMs` — timeout for synchronous CLI/Python execution
 * (milliseconds). Default: 600_000 (10 minutes — generous for HPC
 * tools).
 *
 * Spec: resolutions.md R5; build-phases.md Phase 4.
 */
export interface ToolInvocationConfig {
  readonly caseOutputBasePath: string;
  readonly pollIntervalMs: number;
  readonly commandTimeoutMs: number;
}

/**
 * Default tool-invocation configuration per R5 and R13.
 *
 * Case output base path: `/scratch/snx3000/cera_user/cases/` (Alps
 * standard — the user's scratch directory). Each Case's output tree
 * is at `<caseOutputBasePath>/<caseName>/run/`.
 *
 * Poll interval: 30s (matches R13 initial poll).
 * Command timeout: 10 minutes (generous for HPC tools).
 */
export const DEFAULT_TOOL_INVOCATION_CONFIG: ToolInvocationConfig = {
  caseOutputBasePath: '/scratch/snx3000/cera_user/cases/',
  pollIntervalMs: 30_000,
  commandTimeoutMs: 600_000,
};
