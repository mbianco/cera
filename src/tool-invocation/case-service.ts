/**
 * CaseService implementation (C1 — CESM lifecycle).
 *
 * CESM is a Model Tool (R1, ADR-001). The Case lifecycle
 * (create → configure → build → submit → monitor → post-process) is a
 * specialized ToolInvocation lifecycle.
 *
 * Invariants enforced:
 * - INV-T1: Environment loaded and verified before build (and
 *   re-verified before submit).
 * - INV-T2: Single exit outcome per step (exit code or signal).
 * - INV-T5: Signal vs exit-code distinction preserved.
 * - INV-T6: Submit requires built Case (submitCase rejects if not
 *   BUILT).
 * - INV-T7: One running Job per Case (submitCase rejects if a Job
 *   is already RUNNING or PENDING).
 * - INV-T8: Run length bounded by Wall Time (validated at
 *   submission, not at runtime).
 * - INV-T9: Output tree location known before submission (set at
 *   creation per R5, validated as writable at submission).
 *
 * Failure modes handled:
 * - FM-M1: Build failure (non-zero exit) → Case remains CONFIGURED,
 *   throws NonZeroExitCode. Build log captured.
 * - FM-M2: CESM runtime crash (Job state FAILED) → monitorCase
 *   emits FAILED.
 * - FM-M3: Wall time exceeded (Job state TIMEOUT) → monitorCase
 *   emits FAILED (Case state has no TIMEOUT; FAILED is the
 *   appropriate terminal mapping).
 * - FM-M4: Node failure (Job state NODE_FAIL) → monitorCase emits
 *   FAILED.
 * - FM-M5: Configure failure (non-zero exit) → Case remains
 *   CREATED, throws NonZeroExitCode.
 *
 * Dependencies:
 * - dsh-adapter ShellExecutor: executes case.setup, case.build
 * - dsh-adapter SubprocessRunner: available for case.submit
 * - environment-management (X1): verify CESM Environment before
 *   build and submit
 * - data-management (X3): register output Datasets after COMPLETED
 * - provenance (X4): write ProvenanceRecord for each Case step and
 *   output Dataset
 * - scheduling (X2): submit the SLURM Job via case.submit
 * - tool-invocation ToolCatalogService: look up the CESM ModelTool
 *
 * Spec: api-contracts.md §6 (CaseService); module-graph.md §6;
 * invariants.md INV-T6–T9; failure-modes.md FM-M1–M5;
 * resolutions.md R1, R4, R5, R8; ADR-001.
 */

import type {
  ShellExecutor,
  SubprocessRunner,
} from '../dsh-adapter/types';
import type { SchedulingService } from '../scheduling/types';
import type { EnvironmentService } from '../environment-management/types';
import type { ProvenanceService } from '../provenance/types';
import type { DataManagementService } from '../data-management/types';
import type {
  AsyncObservable,
  Case,
  CaseId,
  CaseState,
  Dataset,
  Duration,
  Environment,
  EnvironmentId,
  ExitOutcome,
  Format,
  Grid,
  JobId,
  JobState,
  Location,
  ResourceRequest,
  Tool,
  ToolId,
  Variable,
} from '../types';
import {
  CaseAlreadyRunning,
  CaseNotBuilt,
  EnvironmentNotLoaded,
  InvalidParameters,
  NonZeroExitCode,
  OutputLocationNotSet,
  RunLengthExceedsWallTime,
  SignalTerminated,
  ToolNotFound,
} from '../types/errors';
import { isTerminalJobState } from '../types/value-objects';
import type {
  CaseConfig,
  CaseService,
  CreateCaseInput,
  ToolCatalogService,
  ToolInvocationConfig,
} from './types';
import { DEFAULT_TOOL_INVOCATION_CONFIG } from './types';
import { createAsyncObservable } from './async-observable';

// ============================================================================
// OutputScanner
// ============================================================================

/**
 * A discovered output file in the Case's output tree.
 *
 * In production, the scanner inspects each file's metadata to
 * determine its Format, Grid, and Variables. In tests, a mock
 * scanner returns predefined files.
 *
 * Spec: api-contracts.md §6 (registerCaseOutput).
 */
export interface OutputFile {
  readonly filename: string;
  readonly format: Format;
  readonly grid: Grid;
  readonly variables: readonly Variable[];
}

/**
 * Scans the output tree at the given Location and returns discovered
 * output files. In production, this would use a FilesystemGateway to
 * list files and inspect their metadata (e.g., via `ncdump -h` or
 * `zarr info`). In tests, a mock scanner returns predefined files.
 *
 * Spec: api-contracts.md §6 (registerCaseOutput).
 */
export type OutputScanner = (location: Location) => Promise<readonly OutputFile[]>;

// ============================================================================
// CaseServiceImplProps
// ============================================================================

/**
 * Constructor parameters for CaseServiceImpl.
 *
 * All dependencies are injected for testability. The service does
 * not import dsh, agent-interaction, or any Phase 5+ module
 * (FINDING-02: experimentId is accepted without synchronous
 * validation).
 *
 * `outputScanner` — scans the output tree for Datasets after the Job
 *   reaches COMPLETED. In tests, provide a mock that returns
 *   predefined OutputFiles. In production, this would wrap a
 *   FilesystemGateway + metadata inspector.
 *
 * `config` — optional partial override of the default tool-invocation
 *   configuration (caseOutputBasePath, pollIntervalMs,
 *   commandTimeoutMs).
 *
 * `cesmToolId` — the ToolId of the CESM ModelTool in the catalog.
 *   Defaults to 'cesm'.
 *
 * Spec: api-contracts.md §6; build-phases.md Phase 4.
 */
export interface CaseServiceImplProps {
  readonly catalog: ToolCatalogService;
  readonly environment: EnvironmentService;
  readonly dataManagement: DataManagementService;
  readonly provenance: ProvenanceService;
  readonly scheduling: SchedulingService;
  readonly shellExecutor: ShellExecutor;
  readonly subprocessRunner: SubprocessRunner;
  readonly outputScanner: OutputScanner;
  readonly config?: Partial<ToolInvocationConfig>;
  readonly cesmToolId?: ToolId;
}

// ============================================================================
// Internal Case tracking
// ============================================================================

/**
 * Internal mutable record tracking a Case's current state and its
 * monitoring observable.
 */
interface InternalCaseRecord {
  caseEntity: Case;
  monitorObservable: ReturnType<typeof createAsyncObservable<CaseState>>;
}

// ============================================================================
// Branded ID factory (private to this module)
// ============================================================================

/**
 * Generates a unique CaseId.
 * Format: `case-<timestamp>-<random>`.
 */
function generateCaseId(): CaseId {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  return `case-${timestamp}-${random}` as CaseId;
}

// ============================================================================
// Run length vs Wall Time comparison (INV-T8)
// ============================================================================

/**
 * Parses a Duration string (e.g., "5 years", "10 days", "100 hours")
 * into an approximate number of hours.
 *
 * Conversion factors:
 * - years → hours (× 8760)
 * - months → hours (× 730, approximate)
 * - days → hours (× 24)
 * - hours → hours (× 1)
 *
 * Returns null if the unit is unknown or the string is malformed
 * (caller defaults to allowing submission per INV-T8 caveat).
 *
 * Spec: invariants.md INV-T8; resolutions.md R4.
 */
function parseRunLengthHours(runLength: Duration): number | null {
  const match = runLength
    .trim()
    .match(/^(\d+)\s*(year|years|month|months|day|days|hour|hours)$/i);
  if (!match) return null;

  // match[1] and match[2] are guaranteed by the regex above
  const valueStr = match[1];
  const unitStr = match[2];
  if (valueStr === undefined || unitStr === undefined) return null;

  const value = parseInt(valueStr, 10);
  if (isNaN(value)) return null;

  const unit = unitStr.toLowerCase();
  if (unit.startsWith('year')) return value * 8760;
  if (unit.startsWith('month')) return value * 730;
  if (unit.startsWith('day')) return value * 24;
  if (unit.startsWith('hour')) return value;

  return null;
}

/**
 * Parses a SLURM wall time string ("HH:MM:SS" or "HH:MM") into
 * hours as a floating-point number.
 *
 * Returns null if the string is malformed.
 *
 * Spec: invariants.md INV-T8.
 */
function parseWallTimeHours(wallTime: string): number | null {
  const parts = wallTime.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  const hoursStr = parts[0];
  const minutesStr = parts[1];
  if (hoursStr === undefined || minutesStr === undefined) return null;

  const hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10);
  const secondsStr = parts.length === 3 ? parts[2] : '0';
  if (secondsStr === undefined) return null;
  const seconds = parseInt(secondsStr, 10);

  if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) return null;

  return hours + minutes / 60 + seconds / 3600;
}

/**
 * Checks whether the Case's run length exceeds the ResourceRequest's
 * wall time (INV-T8).
 *
 * Since run length and wall time use different units, the comparison
 * is approximate: both are converted to hours (1 year ≈ 8760 hours,
 * 1 day ≈ 24 hours) and compared numerically.
 *
 * If the comparison cannot be made (unknown unit or malformed
 * string), the function returns false — submission is allowed but
 * the caller should log a warning (INV-T8 caveat: the invariant
 * bounds the configuration defect, not the unit parsing).
 *
 * Spec: invariants.md INV-T8; resolutions.md R4.
 *
 * @param runLength The Case's run length (e.g., "5 years").
 * @param wallTime  The ResourceRequest's wall time (e.g., "168:00:00").
 * @returns true if the run length exceeds the wall time.
 */
export function runLengthExceedsWallTime(
  runLength: Duration,
  wallTime: string,
): boolean {
  const runHours = parseRunLengthHours(runLength);
  const wallHours = parseWallTimeHours(wallTime);

  if (runHours === null || wallHours === null) {
    // INV-T8 caveat: if the comparison cannot be made, default to
    // allowing submission. The caller should log a warning.
    return false;
  }

  return runHours > wallHours;
}

// ============================================================================
// Job state → Case state mapping
// ============================================================================

/**
 * Maps a SLURM Job state to the corresponding Case state.
 *
 * CESM's CaseState type does not include TIMEOUT, OUT_OF_MEMORY, or
 * NODE_FAIL (those are SLURM-specific). All non-COMPLETED terminal
 * Job states except CANCELLED map to FAILED:
 *
 * - PENDING    → SUBMITTED (waiting for resources)
 * - RUNNING    → RUNNING
 * - COMPLETED  → COMPLETED
 * - FAILED     → FAILED (FM-M2: runtime crash)
 * - TIMEOUT    → FAILED (FM-M3: wall time exceeded)
 * - OUT_OF_MEMORY → FAILED
 * - NODE_FAIL  → FAILED (FM-M4: node failure)
 * - CANCELLED  → CANCELLED
 * - UNKNOWN    → SUBMITTED (no state change; R13)
 *
 * Spec: invariants.md INV-S1, INV-S4; failure-modes.md FM-M2–M4;
 * resolutions.md R13.
 */
function jobStateToCaseState(jobState: JobState): CaseState {
  switch (jobState) {
    case 'PENDING':
      return 'SUBMITTED';
    case 'RUNNING':
      return 'RUNNING';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
    case 'TIMEOUT':
    case 'OUT_OF_MEMORY':
    case 'NODE_FAIL':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'UNKNOWN':
      // R13: UNKNOWN is acceptable. Do not promote or demote.
      return 'SUBMITTED';
    default:
      return 'SUBMITTED';
  }
}

// ============================================================================
// Environment matching (mirrors tool-invocation-service)
// ============================================================================

/**
 * Checks if the active Environment satisfies the Tool's environment
 * requirements. Compares uenvSpecs by name and version.
 *
 * Spec: invariants.md INV-T1; cross-context/interactions.md X1.
 */
function environmentMatchesTool(
  environment: Environment,
  tool: Tool,
): boolean {
  const requiredSpecs = tool.environmentRequirements.uenvSpecs;
  if (requiredSpecs.length === 0) {
    return true; // No requirements
  }

  const envSpecKeys = new Set(
    environment.uenvSpecs.map((s) => `${s.name}/${s.version}`),
  );

  for (const spec of requiredSpecs) {
    if (!envSpecKeys.has(`${spec.name}/${spec.version}`)) {
      return false;
    }
  }

  return true;
}

// ============================================================================
// CaseServiceImpl
// ============================================================================

/**
 * CaseService implementation — the CESM Case lifecycle.
 *
 * CESM is a Model Tool (R1, ADR-001). The Case lifecycle is a
 * specialized ToolInvocation lifecycle:
 *
 *   create → configure → build → submit → monitor → post-process
 *
 * Each step is executed via ShellExecutor (case.setup, case.build)
 * or SchedulingService (case.submit → sbatch). A ProvenanceRecord is
 * written for every step and for every output Dataset.
 *
 * Invariants enforced: INV-T1, INV-T2, INV-T5, INV-T6, INV-T7,
 * INV-T8, INV-T9.
 *
 * Failure modes handled: FM-M1 (build failure), FM-M2 (runtime
 * crash), FM-M3 (wall time exceeded), FM-M4 (node failure), FM-M5
 * (configure failure).
 *
 * Spec: api-contracts.md §6 (CaseService); invariants.md INV-T6–T9;
 * failure-modes.md FM-M1–M5; resolutions.md R1, R4, R5, R8;
 * ADR-001.
 */
export class CaseServiceImpl implements CaseService {
  #catalog: ToolCatalogService;
  #environment: EnvironmentService;
  #dataManagement: DataManagementService;
  #provenance: ProvenanceService;
  #scheduling: SchedulingService;
  #shellExecutor: ShellExecutor;
  #outputScanner: OutputScanner;
  #config: ToolInvocationConfig;
  #cesmToolId: ToolId;
  #cases: Map<string, InternalCaseRecord> = new Map();

  constructor(props: CaseServiceImplProps) {
    this.#catalog = props.catalog;
    this.#environment = props.environment;
    this.#dataManagement = props.dataManagement;
    this.#provenance = props.provenance;
    this.#scheduling = props.scheduling;
    this.#shellExecutor = props.shellExecutor;
    // SubprocessRunner is available via props.subprocessRunner for
    // fine-grained process control during case.submit. The current
    // implementation delegates to SchedulingService.submitJob()
    // which wraps sbatch. SubprocessRunner is kept in the
    // dependency contract for future use (e.g., streaming
    // case.submit output).
    this.#outputScanner = props.outputScanner;
    this.#config = {
      ...DEFAULT_TOOL_INVOCATION_CONFIG,
      ...props.config,
    };
    this.#cesmToolId = props.cesmToolId ?? ('cesm' as ToolId);
  }

  // ========================================================================
  // createCase (R5, INV-T9)
  // ========================================================================

  /**
   * Creates a new CESM Case. The output tree Location is determined
   * at creation time (R5, INV-T9) and does not change.
   *
   * The `experimentId` is accepted WITHOUT synchronous validation
   * (FINDING-02, eventual consistency). Validation happens
   * asynchronously in agent-interaction (Phase 5).
   *
   * @throws {InvalidParameters} if compset, resolution, or machine
   *   is an empty string.
   *
   * Spec: api-contracts.md §6; resolutions.md R5; invariants.md
   * INV-T9; ADR-001.
   */
  async createCase(input: CreateCaseInput): Promise<Case> {
    // Validate input — empty strings for compset, resolution, machine
    const invalidParams: string[] = [];
    if (!input.compset || input.compset.trim() === '') {
      invalidParams.push('compset');
    }
    if (!input.resolution || input.resolution.trim() === '') {
      invalidParams.push('resolution');
    }
    if (!input.machine || input.machine.trim() === '') {
      invalidParams.push('machine');
    }
    if (invalidParams.length > 0) {
      throw new InvalidParameters({
        toolId: this.#cesmToolId,
        invalidParameters: invalidParams,
        schema: {
          type: 'object',
          description:
            'compset, resolution, and machine must be non-empty strings',
        },
      });
    }

    // Output tree Location is determined at creation (R5, INV-T9)
    const basePath = this.#config.caseOutputBasePath.endsWith('/')
      ? this.#config.caseOutputBasePath
      : `${this.#config.caseOutputBasePath}/`;
    const outputTreeLocation: Location = {
      path: `${basePath}${input.name}/run/`,
      filesystem: 'scratch',
    };

    const caseId = generateCaseId();
    const now = new Date();

    const newCase: Case = Object.freeze({
      id: caseId,
      name: input.name,
      compset: input.compset,
      resolution: input.resolution,
      machine: input.machine,
      runLength: input.runLength,
      state: 'CREATED',
      outputTreeLocation,
      jobId: null,
      experimentId: input.experimentId,
      createdAt: now,
    });

    const monitorObservable = createAsyncObservable<CaseState>();
    this.#cases.set(caseId as string, {
      caseEntity: newCase,
      monitorObservable,
    });

    return newCase;
  }

  // ========================================================================
  // configureCase (FM-M5)
  // ========================================================================

  /**
   * Configures the Case (CESM's `case.setup` / XML configuration).
   * Case state: CREATED → CONFIGURED on success, remains CREATED on
   * failure (FM-M5).
   *
   * @throws {NonZeroExitCode} if case.setup fails (FM-M5). Case
   *   remains in CREATED state.
   * @throws {SignalTerminated} if case.setup is terminated by a
   *   signal (INV-T5). Case remains in CREATED state.
   * @throws {CaseNotBuilt} if Case is not in CREATED state.
   *
   * Spec: api-contracts.md §6; failure-modes.md FM-M5; ADR-001.
   */
  async configureCase(
    caseId: CaseId,
    config: CaseConfig,
  ): Promise<Case> {
    const record = this.#cases.get(caseId as string);
    if (record === undefined) {
      throw new Error(`Case '${caseId as string}' not found.`);
    }
    const existingCase = record.caseEntity;

    // State must be CREATED
    if (existingCase.state !== 'CREATED') {
      throw new CaseNotBuilt({
        caseId,
        currentState: existingCase.state,
      });
    }

    // Look up the CESM ModelTool from the catalog
    const cesmTool = await this.#catalog.getTool(this.#cesmToolId);
    if (cesmTool === null) {
      throw new ToolNotFound({
        requestedTool: this.#cesmToolId as string,
        availableTools: (await this.#catalog.getToolCatalog()).map(
          (t) => t.id,
        ),
      });
    }

    // Get the active Environment for the ProvenanceRecord.
    // configureCase does NOT throw EnvironmentNotLoaded (unlike
    // buildCase and submitCase), but the ProvenanceRecord requires
    // an environment ID. If no environment is active, use a
    // placeholder.
    const activeEnv = this.#environment.getActiveEnvironment();
    const envId = activeEnv !== null ? activeEnv.id : ('env-none' as EnvironmentId);
    const envDesc =
      activeEnv !== null
        ? activeEnv.modules.map((m) => `${m.name}/${m.version}`).join(' ')
        : 'none';

    // Execute case.setup via ShellExecutor
    const caseDir = this.#getCaseDirectory(existingCase);
    const result = await this.#shellExecutor.execute('./case.setup', {
      cwd: caseDir,
      timeout: this.#config.commandTimeoutMs,
    });

    // Build config parameters as a Record for ProvenanceRecord.
    // Object literals are assignable to Record<string, unknown>
    // (named interface types are not, due to missing index
    // signature).
    const configParams: Record<string, unknown> = {
      runLength: config.runLength,
      calendar: config.calendar,
      stopOption: config.stopOption,
      customXml: config.customXml,
    };

    // Non-zero exit → FM-M5, Case remains CREATED
    if (result.exitOutcome.kind === 'exit_code' && result.exitOutcome.code !== 0) {
      await this.#writeStepProvenance(
        existingCase,
        cesmTool,
        envId,
        envDesc,
        'configure',
        configParams,
        result.exitOutcome,
      );
      throw new NonZeroExitCode({
        exitCode: result.exitOutcome.code,
        permissive: false,
        stderr: result.stderr,
        caseId,
        phase: 'configure',
      });
    }

    // Signal terminated → INV-T5, Case remains CREATED
    if (result.exitOutcome.kind === 'signal') {
      await this.#writeStepProvenance(
        existingCase,
        cesmTool,
        envId,
        envDesc,
        'configure',
        configParams,
        result.exitOutcome,
      );
      throw new SignalTerminated({
        signalName: result.exitOutcome.name,
        signalNumber: result.exitOutcome.number,
        stderr: result.stderr,
        caseId,
      });
    }

    // Success: CREATED → CONFIGURED
    const configuredCase: Case = Object.freeze({
      ...existingCase,
      state: 'CONFIGURED',
    });
    this.#updateCase(configuredCase);

    // Write ProvenanceRecord for the configure step
    await this.#writeStepProvenance(
      configuredCase,
      cesmTool,
      envId,
      envDesc,
      'configure',
      configParams,
      result.exitOutcome,
    );

    return configuredCase;
  }

  // ========================================================================
  // buildCase (FM-M1, INV-T1)
  // ========================================================================

  /**
   * Builds the Case (CESM's `case.build`). Case state: CONFIGURED →
   * BUILT on success, remains CONFIGURED on failure (FM-M1).
   *
   * @throws {NonZeroExitCode} if build fails. The build log is
   *   captured. Case remains in CONFIGURED state.
   * @throws {SignalTerminated} if the build is terminated by a
   *   signal (INV-T5). Case remains in CONFIGURED state.
   * @throws {EnvironmentNotLoaded} if the CESM Environment (compiler
   *   + MPI) is not loaded (INV-T1).
   * @throws {Error} if Case is not in CONFIGURED state.
   *
   * Spec: api-contracts.md §6; failure-modes.md FM-M1; ADR-001.
   */
  async buildCase(caseId: CaseId): Promise<Case> {
    const record = this.#cases.get(caseId as string);
    if (record === undefined) {
      throw new Error(`Case '${caseId as string}' not found.`);
    }
    const existingCase = record.caseEntity;

    // State must be CONFIGURED
    if (existingCase.state !== 'CONFIGURED') {
      throw new Error(
        `Case '${caseId as string}' is in ${existingCase.state} state, not CONFIGURED.`,
      );
    }

    // Look up the CESM ModelTool from the catalog
    const cesmTool = await this.#catalog.getTool(this.#cesmToolId);
    if (cesmTool === null) {
      throw new ToolNotFound({
        requestedTool: this.#cesmToolId as string,
        availableTools: (await this.#catalog.getToolCatalog()).map(
          (t) => t.id,
        ),
      });
    }

    // Verify CESM Environment (compiler + MPI) is loaded (INV-T1)
    const activeEnv = this.#environment.getActiveEnvironment();
    if (activeEnv === null) {
      throw new EnvironmentNotLoaded({
        toolId: cesmTool.id,
        environmentId: undefined,
      });
    }

    if (!environmentMatchesTool(activeEnv, cesmTool)) {
      throw new EnvironmentNotLoaded({
        toolId: cesmTool.id,
        environmentId: activeEnv.id,
      });
    }

    // Re-verify immediately before build (X1 "out-of-order" case)
    try {
      const verified = await this.#environment.verifyEnvironment(
        activeEnv.id,
      );
      if (!verified) {
        throw new EnvironmentNotLoaded({
          toolId: cesmTool.id,
          environmentId: activeEnv.id,
        });
      }
    } catch (error) {
      if (error instanceof EnvironmentNotLoaded) {
        throw error;
      }
      throw new EnvironmentNotLoaded({
        toolId: cesmTool.id,
        environmentId: activeEnv.id,
        cause: error,
      });
    }

    const envDesc = activeEnv.modules.map(
      (m) => `${m.name}/${m.version}`,
    ).join(' ');

    // Execute case.build via ShellExecutor
    const caseDir = this.#getCaseDirectory(existingCase);
    const result = await this.#shellExecutor.execute('./case.build', {
      cwd: caseDir,
      timeout: this.#config.commandTimeoutMs,
    });

    // Non-zero exit → FM-M1, Case remains CONFIGURED
    if (result.exitOutcome.kind === 'exit_code' && result.exitOutcome.code !== 0) {
      await this.#writeStepProvenance(
        existingCase,
        cesmTool,
        activeEnv.id,
        envDesc,
        'build',
        {},
        result.exitOutcome,
      );
      throw new NonZeroExitCode({
        exitCode: result.exitOutcome.code,
        permissive: false,
        stderr: result.stderr,
        caseId,
        phase: 'build',
      });
    }

    // Signal terminated → INV-T5, Case remains CONFIGURED
    if (result.exitOutcome.kind === 'signal') {
      await this.#writeStepProvenance(
        existingCase,
        cesmTool,
        activeEnv.id,
        envDesc,
        'build',
        {},
        result.exitOutcome,
      );
      throw new SignalTerminated({
        signalName: result.exitOutcome.name,
        signalNumber: result.exitOutcome.number,
        stderr: result.stderr,
        caseId,
      });
    }

    // Success: CONFIGURED → BUILT
    const builtCase: Case = Object.freeze({
      ...existingCase,
      state: 'BUILT',
    });
    this.#updateCase(builtCase);

    // Write ProvenanceRecord for the build step
    await this.#writeStepProvenance(
      builtCase,
      cesmTool,
      activeEnv.id,
      envDesc,
      'build',
      {},
      result.exitOutcome,
    );

    return builtCase;
  }

  // ========================================================================
  // submitCase (INV-T6, INV-T7, INV-T8, INV-T9)
  // ========================================================================

  /**
   * Submits the Case via `case.submit`, which creates a SLURM Job
   * via scheduling.submitJob().
   *
   * Preconditions (validated before submission):
   * - Case must be in BUILT state (INV-T6).
   * - Run length must not exceed Wall Time (INV-T8).
   * - Output tree Location must be set and writable (INV-T9).
   * - No RUNNING or PENDING Job already exists for this Case (INV-T7).
   * - CESM Environment must be verified (re-verified before submit).
   *
   * Case state: BUILT → SUBMITTED. A ProvenanceRecord is created for
   * the Job. The Case's `jobId` is set to the SLURM-assigned JobID
   * (INV-S3).
   *
   * @throws {CaseNotBuilt} if Case is not in BUILT state (INV-T6).
   * @throws {RunLengthExceedsWallTime} if run length > wall time
   *   (INV-T8).
   * @throws {OutputLocationNotSet} if output tree Location is not
   *   set (INV-T9).
   * @throws {CaseAlreadyRunning} if a Job is already RUNNING for
   *   this Case (INV-T7).
   * @throws {EnvironmentNotLoaded} if the CESM Environment is not
   *   loaded (INV-T1).
   * @throws {RejectedByScheduler} if SLURM rejects the submission
   *   (FM-S1).
   *
   * Spec: api-contracts.md §6; invariants.md INV-T6–T9; ADR-001.
   */
  async submitCase(
    caseId: CaseId,
    resourceRequest: ResourceRequest,
  ): Promise<Case> {
    const record = this.#cases.get(caseId as string);
    if (record === undefined) {
      throw new Error(`Case '${caseId as string}' not found.`);
    }
    const existingCase = record.caseEntity;

    // INV-T6: Case must be in BUILT state, OR in SUBMITTED state
    // with a terminal Job (allows resubmission per INV-T7).
    if (existingCase.state !== 'BUILT' && existingCase.state !== 'SUBMITTED') {
      throw new CaseNotBuilt({
        caseId,
        currentState: existingCase.state,
      });
    }

    // INV-T7: If the Case is already SUBMITTED, check the existing Job.
    // If RUNNING or PENDING, reject. If terminal, allow resubmission.
    if (existingCase.state === 'SUBMITTED' && existingCase.jobId !== null) {
      const existingJob = await this.#scheduling.queryJob(
        existingCase.jobId,
      );
      if (
        existingJob.state === 'RUNNING' ||
        existingJob.state === 'PENDING'
      ) {
        throw new CaseAlreadyRunning({
          caseId,
          jobId: existingCase.jobId,
        });
      }
      // Job is terminal — allow resubmission.
      // The Case state will be updated to SUBMITTED below.
    } else if (existingCase.state === 'SUBMITTED' && existingCase.jobId === null) {
      // SUBMITTED with no jobId — unexpected but allow resubmission.
    }

    // Use the existing Case (whether BUILT or resubmitted) for the
    // remaining checks. If resubmitting, use the original Case's
    // run length and output tree Location.
    const caseForChecks = existingCase;

    // INV-T8: Run length must not exceed Wall Time
    if (runLengthExceedsWallTime(caseForChecks.runLength, resourceRequest.wallTime)) {
      throw new RunLengthExceedsWallTime({
        caseId,
        runLength: caseForChecks.runLength,
        wallTime: resourceRequest.wallTime,
      });
    }

    // INV-T9: Output tree Location must be set and writable
    if (
      !caseForChecks.outputTreeLocation ||
      caseForChecks.outputTreeLocation.path.trim() === ''
    ) {
      throw new OutputLocationNotSet({ caseId });
    }
    // Validate output tree Location is writable
    await this.#dataManagement.validateLocation(
      caseForChecks.outputTreeLocation,
      'write',
    );

    // Look up the CESM ModelTool from the catalog
    const cesmTool = await this.#catalog.getTool(this.#cesmToolId);
    if (cesmTool === null) {
      throw new ToolNotFound({
        requestedTool: this.#cesmToolId as string,
        availableTools: (await this.#catalog.getToolCatalog()).map(
          (t) => t.id,
        ),
      });
    }

    // Verify CESM Environment (re-verified before submit, INV-T1)
    const activeEnv = this.#environment.getActiveEnvironment();
    if (activeEnv === null) {
      throw new EnvironmentNotLoaded({
        toolId: cesmTool.id,
        environmentId: undefined,
      });
    }

    if (!environmentMatchesTool(activeEnv, cesmTool)) {
      throw new EnvironmentNotLoaded({
        toolId: cesmTool.id,
        environmentId: activeEnv.id,
      });
    }

    // Re-verify immediately before submit
    try {
      const verified = await this.#environment.verifyEnvironment(
        activeEnv.id,
      );
      if (!verified) {
        throw new EnvironmentNotLoaded({
          toolId: cesmTool.id,
          environmentId: activeEnv.id,
        });
      }
    } catch (error) {
      if (error instanceof EnvironmentNotLoaded) {
        throw error;
      }
      throw new EnvironmentNotLoaded({
        toolId: cesmTool.id,
        environmentId: activeEnv.id,
        cause: error,
      });
    }

    const envDesc = activeEnv.modules.map(
      (m) => `${m.name}/${m.version}`,
    ).join(' ');

    // Submit the Job via SchedulingService (INV-S3: JobID assigned
    // by SLURM)
    const caseDir = this.#getCaseDirectory(existingCase);
    const job = await this.#scheduling.submitJob({
      resourceRequest,
      command: './case.submit',
      workingDirectory: caseDir,
    });

    // Update Case: BUILT → SUBMITTED, set jobId (INV-S3)
    const submittedCase: Case = Object.freeze({
      ...existingCase,
      state: 'SUBMITTED',
      jobId: job.jobId,
    });
    this.#updateCase(submittedCase);

    // Write ProvenanceRecord for the submission
    await this.#provenance.writeProvenanceRecord({
      toolId: cesmTool.id,
      toolName: `${cesmTool.name} case.submit`,
      toolVersion: cesmTool.version,
      parameters: {
        resourceRequest,
        outputLocation: existingCase.outputTreeLocation,
      },
      environmentId: activeEnv.id,
      environmentDescription: envDesc,
      inputDatasetIds: [],
      outputDatasetId: null,
      exitOutcome: { kind: 'exit_code', code: 0 },
      timestamp: new Date(),
      jobId: job.jobId,
      caseId,
    });

    return submittedCase;
  }

  // ========================================================================
  // monitorCase (INV-S4)
  // ========================================================================

  /**
   * Monitors the Case's Job via scheduling.queryJob() until a
   * terminal state is reached. Case state transitions: SUBMITTED →
   * RUNNING → COMPLETED/FAILED/CANCELLED.
   *
   * Returns an AsyncObservable for streaming CaseState changes.
   * Stops emitting once a terminal state is reached (INV-S4).
   *
   * If the Case is unknown or has no Job, returns an empty
   * observable (completes immediately).
   *
   * Spec: api-contracts.md §6 (monitorCase); invariants.md INV-S1,
   * INV-S4; resolutions.md R13.
   */
  monitorCase(caseId: CaseId): AsyncObservable<CaseState> {
    const record = this.#cases.get(caseId as string);
    if (record === undefined) {
      // Unknown Case — return empty observable
      const empty = createAsyncObservable<CaseState>();
      empty.complete();
      return empty;
    }

    const existingCase = record.caseEntity;
    const observable = record.monitorObservable;

    if (existingCase.jobId === null) {
      // No Job — return empty observable
      return createAsyncObservable<CaseState>();
    }

    const jobId = existingCase.jobId;
    let lastCaseState: CaseState | null = null;
    let pollingStarted = false;

    // Start polling on next tick (only once)
    const startPolling = (): void => {
      if (pollingStarted || observable.isCancelled) return;
      pollingStarted = true;
      void this.#pollJob(caseId, jobId, observable, (state) => {
        lastCaseState = state;
      }, lastCaseState);
    };

    setTimeout(startPolling, 0);

    return observable;
  }

  // ========================================================================
  // registerCaseOutput (post-process)
  // ========================================================================

  /**
   * After the Job reaches COMPLETED, scans the output tree at the
   * recorded Location and registers Datasets via
   * data-management.registerDataset(). Each Dataset gets a
   * ProvenanceRecord referencing the Job.
   *
   * @throws {Error} if the Case is not in COMPLETED state.
   * @throws {Error} if the output tree is empty or inaccessible.
   *
   * Spec: api-contracts.md §6 (registerCaseOutput); ADR-001.
   */
  async registerCaseOutput(caseId: CaseId): Promise<readonly Dataset[]> {
    const record = this.#cases.get(caseId as string);
    if (record === undefined) {
      throw new Error(`Case '${caseId as string}' not found.`);
    }
    const existingCase = record.caseEntity;

    // Must be in COMPLETED state
    if (existingCase.state !== 'COMPLETED') {
      throw new Error(
        `Case '${caseId as string}' is in ${existingCase.state} state, not COMPLETED. Cannot register output.`,
      );
    }

    // Scan the output tree at the recorded Location
    let outputFiles: readonly OutputFile[];
    try {
      outputFiles = await this.#outputScanner(existingCase.outputTreeLocation);
    } catch (error) {
      throw new Error(
        `Output tree at '${existingCase.outputTreeLocation.path}' is inaccessible: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (outputFiles.length === 0) {
      throw new Error(
        `Output tree at '${existingCase.outputTreeLocation.path}' is empty.`,
      );
    }

    // Look up the CESM ModelTool for ProvenanceRecords
    const cesmTool = await this.#catalog.getTool(this.#cesmToolId);
    if (cesmTool === null) {
      throw new ToolNotFound({
        requestedTool: this.#cesmToolId as string,
        availableTools: (await this.#catalog.getToolCatalog()).map(
          (t) => t.id,
        ),
      });
    }

    // Get the active Environment for ProvenanceRecords
    const activeEnv = this.#environment.getActiveEnvironment();
    const envId = activeEnv !== null ? activeEnv.id : ('env-none' as EnvironmentId);
    const envDesc =
      activeEnv !== null
        ? activeEnv.modules.map((m) => `${m.name}/${m.version}`).join(' ')
        : 'none';

    // Register each output file as a Dataset
    const datasets: Dataset[] = [];
    for (const file of outputFiles) {
      // Derive Dataset name from filename (strip extension)
      const lastDot = file.filename.lastIndexOf('.');
      const dsName = lastDot > 0 ? file.filename.slice(0, lastDot) : file.filename;

      // Construct the full output path
      const basePath = existingCase.outputTreeLocation.path.endsWith('/')
        ? existingCase.outputTreeLocation.path
        : `${existingCase.outputTreeLocation.path}/`;
      const dsLocation: Location = {
        path: `${basePath}${file.filename}`,
        filesystem: existingCase.outputTreeLocation.filesystem,
      };

      const dataset = await this.#dataManagement.registerDataset({
        name: dsName,
        location: dsLocation,
        format: file.format,
        grid: file.grid,
        variables: file.variables,
      });

      // Write ProvenanceRecord for each Dataset, referencing the Job
      await this.#provenance.writeProvenanceRecord({
        toolId: cesmTool.id,
        toolName: `${cesmTool.name} post-process`,
        toolVersion: cesmTool.version,
        parameters: {
          caseName: existingCase.name,
          outputFilename: file.filename,
        },
        environmentId: envId,
        environmentDescription: envDesc,
        inputDatasetIds: [],
        outputDatasetId: dataset.id,
        exitOutcome: { kind: 'exit_code', code: 0 },
        timestamp: new Date(),
        jobId: existingCase.jobId ?? undefined,
        caseId,
      });

      // Mark the Dataset as consumable (INV-D3 / INV-P3)
      await this.#dataManagement.markConsumable(dataset.id);

      datasets.push(dataset);
    }

    return Object.freeze(datasets);
  }

  // ========================================================================
  // Private: helpers
  // ========================================================================

  /**
   * Derives the Case working directory from the output tree
   * Location. The output tree is at `<caseDir>/run/`, so the case
   * directory is the output tree path with `/run/` removed.
   */
  #getCaseDirectory(caseEntity: Case): string {
    const path = caseEntity.outputTreeLocation.path;
    if (path.endsWith('/run/')) {
      return path.slice(0, -5); // remove "/run/"
    }
    if (path.endsWith('/run')) {
      return path.slice(0, -4); // remove "/run"
    }
    // Fallback: use the parent directory
    const lastSlash = path.lastIndexOf('/');
    return lastSlash > 0 ? path.slice(0, lastSlash) : path;
  }

  /**
   * Updates the internal Case record with a new Case state.
   */
  #updateCase(updatedCase: Case): void {
    const record = this.#cases.get(updatedCase.id as string);
    if (record !== undefined) {
      record.caseEntity = updatedCase;
    }
  }

  /**
   * Writes a ProvenanceRecord for a Case lifecycle step
   * (configure, build).
   *
   * The record captures the Tool identity, the parameters used, the
   * Environment identity, the exit outcome, and the CaseId — the
   * full reproducibility tuple per INV-P2.
   */
  async #writeStepProvenance(
    caseEntity: Case,
    cesmTool: Tool,
    environmentId: EnvironmentId,
    environmentDescription: string,
    step: string,
    parameters: Record<string, unknown>,
    exitOutcome: ExitOutcome,
  ): Promise<void> {
    await this.#provenance.writeProvenanceRecord({
      toolId: cesmTool.id,
      toolName: `${cesmTool.name} ${step}`,
      toolVersion: cesmTool.version,
      parameters: {
        caseName: caseEntity.name,
        step,
        ...parameters,
      },
      environmentId,
      environmentDescription,
      inputDatasetIds: [],
      outputDatasetId: null,
      exitOutcome,
      timestamp: new Date(),
      caseId: caseEntity.id,
    });
  }

  /**
   * Polls the SchedulingService for the Job's state and emits
   * CaseState changes to the observable. Stops polling once a
   * terminal Job state is reached (INV-S4).
   *
   * R13: Polls with the configured interval. In production, backoff
   * would be applied; for simplicity in this implementation, the
   * fixed interval from the config is used.
   */
  async #pollJob(
    caseId: CaseId,
    jobId: JobId,
    observable: ReturnType<typeof createAsyncObservable<CaseState>>,
    setLastState: (state: CaseState) => void,
    lastCaseState: CaseState | null,
  ): Promise<void> {
    let currentState = lastCaseState;

    while (!observable.isCancelled) {
      let job;
      try {
        job = await this.#scheduling.queryJob(jobId);
      } catch {
        // On error (e.g., SchedulerUnavailable), wait and retry
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this.#config.pollIntervalMs),
        );
        continue;
      }

      const newCaseState = jobStateToCaseState(job.state);

      // Emit state change if this is the first poll or the state
      // changed
      if (currentState !== newCaseState) {
        currentState = newCaseState;
        setLastState(newCaseState);

        // Update the Case's state in the internal store
        const record = this.#cases.get(caseId as string);
        if (record !== undefined) {
          const updatedCase: Case = Object.freeze({
            ...record.caseEntity,
            state: newCaseState,
          });
          record.caseEntity = updatedCase;
        }

        observable.emit(newCaseState);
      }

      // INV-S4: stop polling once a terminal Job state is reached
      if (isTerminalJobState(job.state)) {
        observable.complete();
        return;
      }

      // Wait before next poll
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.#config.pollIntervalMs),
      );
    }
  }
}
