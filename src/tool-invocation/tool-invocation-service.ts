/**
 * ToolInvocationService implementation (C1).
 *
 * Creates and executes ToolInvocations with the full lifecycle:
 * create → verify Environment → validate Locations → start →
 * monitor → complete/fail.
 *
 * Invariants enforced:
 * - INV-T1: Environment loaded and verified before invocation.
 *   Calls environmentManagement.verifyEnvironment() immediately
 *   before entering RUNNING state.
 * - INV-T2: Single exit outcome per invocation. The ExitOutcome
 *   discriminated union ensures exactly one variant.
 * - INV-T3: Output registration gated on success. Non-zero exit
 *   codes block output registration by default (R4 strict).
 *   Permissive mode is opt-in via permissiveExitCodes.
 * - INV-T4: Input Datasets opened for reading only. The service
 *   validates input Locations in 'read' mode, never 'write'.
 * - INV-T5: Signal vs exit-code distinction preserved. Signals are
 *   reported as signals, never mapped to synthetic exit codes.
 *
 * Failure modes handled:
 * - FM-T1: Tool segfault (SIGSEGV, SIGBUS) → SignalTerminated
 * - FM-T2: Tool killed by OOM (SIGKILL) → SignalTerminated
 * - FM-T3: Non-zero exit code for warnings → NonZeroExitCode
 *   (strict default, permissive opt-in per ADR-008)
 * - FM-T4: Invalid operator chain → NonZeroExitCode with stderr
 * - FM-T5: Missing input file → InputNotFound (before execution)
 *
 * Dependencies:
 * - environment-management (X1): verify Environment before invocation
 * - data-management (X3): validate input Datasets, register output
 * - provenance (X4): write ProvenanceRecord for every invocation
 * - scheduling (X2): submit parallel Jobs, poll until terminal
 * - dsh-adapter: ShellExecutor (CLI), SubprocessRunner (Python)
 *
 * Spec: api-contracts.md §6; module-graph.md §6; invariants.md
 * INV-T1–T5; failure-modes.md FM-T1–T5; resolutions.md R4;
 * ADR-008.
 */

import type {
  ShellExecutor,
  SubprocessRunner,
  SandboxRunner,
  ShellResult,
} from '../dsh-adapter/types';
import type { SchedulingService } from '../scheduling/types';
import type { EnvironmentService } from '../environment-management/types';
import type { ProvenanceService } from '../provenance/types';
import type { DataManagementService } from '../data-management/types';
import { generateDatasetId } from '../data-management';
import type {
  AsyncObservable,
  CLITool,
  Dataset,
  Environment,
  EnvironmentId,
  ExitOutcome,
  JobId,
  JobState,
  Location,
  Tool,
  ToolInvocation,
  ToolInvocationEvent,
  ToolInvocationId,
  Variable,
} from '../types';
import {
  EnvironmentNotLoaded,
  InputNotFound,
  InputMissingProvenance,
  InvalidParameters,
  ToolNotFound,
  NonZeroExitCode,
  SignalTerminated,
} from '../types/errors';
import { isTerminalJobState } from '../types/value-objects';
import type {
  ToolCatalogService,
  ToolInvocationService,
  ToolInvocationRequest,
  ToolInvocationResult,
  ToolInvocationConfig,
} from './types';
import { DEFAULT_TOOL_INVOCATION_CONFIG } from './types';
import { CLIExecutorImpl } from './cli-executor';
import { PythonExecutorImpl } from './python-executor';
import { createAsyncObservable } from './async-observable';

// ============================================================================
// Internal invocation tracking
// ============================================================================

/**
 * Internal mutable record tracking a ToolInvocation and its event
 * subscribers.
 */
interface InternalInvocationRecord {
  invocation: ToolInvocation;
  observable: ReturnType<typeof createAsyncObservable<ToolInvocationEvent>>;
}

/**
 * Result of synchronous execution: exit outcome and stderr.
 */
interface SyncExecutionResult {
  readonly exitOutcome: ExitOutcome;
  readonly stderr: string;
}

// ============================================================================
// Branded ID factory (private to this module)
// ============================================================================

/**
 * Generates a unique ToolInvocationId.
 * Format: `ti-<timestamp>-<random>`.
 */
function generateToolInvocationId(): ToolInvocationId {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  return `ti-${timestamp}-${random}` as ToolInvocationId;
}

// ============================================================================
// Exit outcome mapping for parallel Jobs
// ============================================================================

/**
 * Maps a SLURM Job's terminal state to an ExitOutcome (INV-T5).
 *
 * - COMPLETED → exit code 0
 * - FAILED → exit code 1 (non-zero)
 * - TIMEOUT → signal SIGTERM (SLURM sends SIGTERM then SIGKILL)
 * - OUT_OF_MEMORY → signal SIGKILL (OOM killer)
 * - NODE_FAIL → exit code 1 (hardware failure, non-zero)
 * - CANCELLED → signal SIGTERM (user or system cancellation)
 *
 * This preserves the signal vs exit-code distinction (INV-T5):
 * signals are reported as signals, never as synthetic exit codes.
 *
 * Spec: invariants.md INV-T5; failure-modes.md FM-T2, FM-M3, FM-S4.
 */
function jobStateToExitOutcome(state: JobState): ExitOutcome {
  switch (state) {
    case 'COMPLETED':
      return { kind: 'exit_code', code: 0 };
    case 'FAILED':
      return { kind: 'exit_code', code: 1 };
    case 'TIMEOUT':
      return { kind: 'signal', name: 'SIGTERM', number: 15 };
    case 'OUT_OF_MEMORY':
      return { kind: 'signal', name: 'SIGKILL', number: 9 };
    case 'NODE_FAIL':
      return { kind: 'exit_code', code: 1 };
    case 'CANCELLED':
      return { kind: 'signal', name: 'SIGTERM', number: 15 };
    default:
      // UNKNOWN or non-terminal — should not happen (caller should
      // poll until terminal). Default to non-zero exit.
      return { kind: 'exit_code', code: 1 };
  }
}

// ============================================================================
// Parameter validation
// ============================================================================

/**
 * Validates parameters for a Tool.
 *
 * For CLI Tools: checks that `operatorChain` is a non-empty string
 * (the main parameter for CLI invocation).
 *
 * For Python Tools: checks that either `script` (string) or `args`
 * (string[]) is present.
 *
 * For Model Tools (CESM): the parameters are validated by the
 * CaseService, not here. A non-empty parameters object is sufficient.
 *
 * @throws {InvalidParameters} if parameters do not match the Tool
 *   schema.
 */
function validateParameters(
  tool: Tool,
  parameters: Record<string, unknown>,
): void {
  if (parameters === null || typeof parameters !== 'object') {
    throw new InvalidParameters({
      toolId: tool.id,
      invalidParameters: ['parameters'],
      schema: { type: 'object' },
    });
  }

  if (Object.keys(parameters).length === 0) {
    throw new InvalidParameters({
      toolId: tool.id,
      invalidParameters: ['parameters'],
      schema: { type: 'object', description: 'parameters must be non-empty' },
    });
  }

  if (tool.kind === 'cli') {
    const operatorChain = parameters['operatorChain'];
    if (typeof operatorChain !== 'string' || operatorChain.trim() === '') {
      throw new InvalidParameters({
        toolId: tool.id,
        invalidParameters: ['operatorChain'],
        schema: { type: 'string', description: 'operatorChain must be a non-empty string for CLI Tools' },
      });
    }
  } else if (tool.kind === 'python') {
    const script = parameters['script'];
    const args = parameters['args'];
    const hasScript = typeof script === 'string' && script.trim() !== '';
    const hasArgs = Array.isArray(args) && args.length > 0;
    if (!hasScript && !hasArgs) {
      throw new InvalidParameters({
        toolId: tool.id,
        invalidParameters: ['script', 'args'],
        schema: { type: 'object', description: 'Python Tools require either "script" (string) or "args" (string[])' },
      });
    }
  }
}

/**
 * Validates that the request's execution model is compatible with
 * the Tool's execution model.
 */
function validateExecutionModel(
  tool: Tool,
  request: ToolInvocationRequest,
): void {
  if (request.executionModel === 'parallel' && tool.executionModel === 'synchronous') {
    throw new InvalidParameters({
      toolId: tool.id,
      invalidParameters: ['executionModel'],
      schema: { type: 'string', description: 'Tool does not support parallel execution' },
    });
  }
}

/**
 * Validates that all input Dataset formats are accepted by the Tool.
 *
 * @throws {InvalidParameters} if any input Dataset's format is not
 *   in the Tool's inputFormats list.
 */
function validateInputFormats(
  tool: Tool,
  inputDatasets: readonly Dataset[],
): void {
  for (const ds of inputDatasets) {
    if (!(tool.inputFormats as readonly string[]).includes(ds.format)) {
      throw new InvalidParameters({
        toolId: tool.id,
        invalidParameters: [`inputFormat:${ds.format}`],
        schema: { type: 'string', description: `Tool accepts formats: ${tool.inputFormats.join(', ')}` },
      });
    }
  }
}

// ============================================================================
// Output dataset derivation
// ============================================================================

/**
 * Derives a Dataset name from an output Location path.
 * Example: `/scratch/.../tas_timmean.nc` → `tas_timmean`
 */
function deriveDatasetName(location: Location): string {
  const path = location.path;
  const lastSlash = path.lastIndexOf('/');
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

/**
 * Derives the output Dataset's grid from the first input Dataset
 * (most operations preserve the grid).
 */
function deriveOutputGrid(inputDatasets: readonly Dataset[]): import('../types').Grid {
  if (inputDatasets.length > 0) {
    const first = inputDatasets[0];
    if (first !== undefined) {
      return first.grid;
    }
  }
  return { kind: 'lat-lon', nlat: 90, nlon: 180 };
}

/**
 * Derives the output Dataset's variables from the first input
 * Dataset (most operations preserve variables).
 */
function deriveOutputVariables(inputDatasets: readonly Dataset[]): readonly Variable[] {
  if (inputDatasets.length > 0) {
    const first = inputDatasets[0];
    if (first !== undefined) {
      return first.variables;
    }
  }
  return [];
}

// ============================================================================
// Environment matching
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
// ToolInvocationServiceImpl
// ============================================================================

/**
 * Constructor parameters for ToolInvocationServiceImpl.
 *
 * `environment` is optional (FCREST-01). When absent (FirecREST
 * backend), the Environment verification step is skipped — uenv
 * is embedded in the Job script by FirecrestShellExecutor
 * (F-INV-5). A placeholder EnvironmentId is used for
 * ProvenanceRecord.
 */
export interface ToolInvocationServiceImplProps {
  readonly catalog: ToolCatalogService;
  readonly environment?: EnvironmentService;
  readonly dataManagement: DataManagementService;
  readonly provenance: ProvenanceService;
  readonly scheduling: SchedulingService;
  readonly shellExecutor: ShellExecutor;
  readonly subprocessRunner: SubprocessRunner;
  readonly sandboxRunner?: SandboxRunner;
  readonly config?: Partial<ToolInvocationConfig>;
  readonly onEvent?: (event: ToolInvocationEvent) => void;
}

/**
 * ToolInvocationService implementation.
 *
 * INV-T1: Environment loaded and verified before invocation.
 *   The service calls `environmentManagement.verifyEnvironment()`
 *   immediately before entering RUNNING state.
 * INV-T2: Single exit outcome per invocation. The ExitOutcome
 *   discriminated union ensures exactly one variant.
 * INV-T3: Output registration gated on success. Non-zero exit codes
 *   block output registration by default (R4 strict).
 * INV-T4: Input Datasets opened for reading only.
 * INV-T5: Signal vs exit-code distinction preserved.
 *
 * Spec: api-contracts.md §6; invariants.md INV-T1–T5;
 * failure-modes.md FM-T1–T5; resolutions.md R4; ADR-008.
 */
export class ToolInvocationServiceImpl implements ToolInvocationService {
  #catalog: ToolCatalogService;
  #environment: EnvironmentService | null;
  #dataManagement: DataManagementService;
  #provenance: ProvenanceService;
  #scheduling: SchedulingService;
  #cliExecutor: CLIExecutorImpl;
  #pythonExecutor: PythonExecutorImpl;
  #config: ToolInvocationConfig;
  #onEvent?: (event: ToolInvocationEvent) => void;
  #invocations: Map<string, InternalInvocationRecord> = new Map();

  constructor(props: ToolInvocationServiceImplProps) {
    this.#catalog = props.catalog;
    this.#environment = props.environment ?? null;
    this.#dataManagement = props.dataManagement;
    this.#dataManagement = props.dataManagement;
    this.#provenance = props.provenance;
    this.#scheduling = props.scheduling;
    this.#cliExecutor = new CLIExecutorImpl({
      shellExecutor: props.shellExecutor,
    });
    this.#pythonExecutor = new PythonExecutorImpl({
      subprocessRunner: props.subprocessRunner,
    });
    this.#config = {
      ...DEFAULT_TOOL_INVOCATION_CONFIG,
      ...props.config,
    };
    this.#onEvent = props.onEvent;
  }

  // ========================================================================
  // invokeTool (INV-T1, INV-T2, INV-T3, INV-T4, INV-T5)
  // ========================================================================

  /**
   * Creates and executes a ToolInvocation.
   *
   * The full lifecycle:
   * 1. Validate: Tool exists in catalog, parameters match Tool
   *    schema, input Datasets exist with Provenance (INV-W1, INV-D3).
   * 2. Verify Environment: load and verify the Tool's required
   *    Environment via environment-management (INV-T1, INV-E2).
   *    Re-verify immediately before execution.
   * 3. Validate Locations: input Locations resolve to readable paths,
   *    output Location resolves to writable path (INV-D4).
   * 4. Start: enter RUNNING state.
   * 5. Execute: synchronous via CLIExecutor/PythonExecutor, or
   *    parallel via SchedulingService.
   * 6. Complete/Fail: record ExitOutcome (INV-T2, INV-T5).
   *
   * @throws {ToolNotFound} if the Tool is not in the catalog (FM-A1).
   * @throws {InvalidParameters} if parameters do not match the Tool
   *   schema (FM-A2, FM-T4).
   * @throws {InputNotFound} if an input Dataset does not exist (FM-T5).
   * @throws {InputMissingProvenance} if an input Dataset has no
   *   ProvenanceRecord (INV-D3, INV-W1).
   * @throws {EnvironmentNotLoaded} if the required Environment is
   *   not loaded (INV-T1).
   * @throws {NonZeroExitCode} if the Tool exits with a non-zero code
   *   (strict default, R4).
   * @throws {SignalTerminated} if the Tool is terminated by a signal
   *   (INV-T5, FM-T1, FM-T2).
   */
  async invokeTool(
    request: ToolInvocationRequest,
  ): Promise<ToolInvocationResult> {
    // ================================================================
    // Step 1: Validate Tool exists in catalog
    // ================================================================
    const tool = await this.#catalog.getTool(request.toolId);
    if (tool === null) {
      throw new ToolNotFound({
        requestedTool: request.toolId as string,
        availableTools: (await this.#catalog.getToolCatalog()).map(
          (t) => t.id,
        ),
      });
    }

    // ================================================================
    // Step 2: Validate parameters and execution model
    // ================================================================
    validateParameters(tool, request.parameters);
    validateExecutionModel(tool, request);

    // Validate resourceRequest is present for parallel execution
    if (request.executionModel === 'parallel' && !request.resourceRequest) {
      throw new InvalidParameters({
        toolId: tool.id,
        invalidParameters: ['resourceRequest'],
        schema: { type: 'object', description: 'resourceRequest is required for parallel execution' },
      });
    }

    // ================================================================
    // Step 3: Validate input Datasets exist and have Provenance
    // (INV-W1, INV-D3)
    // ================================================================
    const inputDatasets: Dataset[] = [];
    for (const datasetId of request.inputDatasetIds) {
      const dataset = await this.#dataManagement.queryDataset(datasetId);
      if (dataset === null) {
        throw new InputNotFound({
          datasetId,
          location: request.outputLocation, // approximate
          cause: 'enoent',
        });
      }
      inputDatasets.push(dataset);
    }

    // Validate input formats are accepted by the Tool
    validateInputFormats(tool, inputDatasets);

    // Validate each input Dataset has Provenance (INV-D3, INV-W1)
    for (const dataset of inputDatasets) {
      const hasProvenance = await this.#provenance.verifyProvenance(
        dataset.id,
      );
      if (!hasProvenance) {
        throw new InputMissingProvenance({ datasetId: dataset.id });
      }
    }

    // ================================================================
    // Step 4: Validate Locations (INV-D4)
    // ================================================================
    // Input Locations: read mode (INV-T4 — never write)
    for (const dataset of inputDatasets) {
      try {
        await this.#dataManagement.validateLocation(dataset.location, 'read');
      } catch (error) {
        if (
          error instanceof
          (await import('../types/errors')).LocationNotReadable
        ) {
          throw new InputNotFound({
            datasetId: dataset.id,
            location: dataset.location,
            cause: 'enoent',
          });
        }
        throw error;
      }
    }

    // Output Location: write mode
    await this.#dataManagement.validateLocation(
      request.outputLocation,
      'write',
    );

    // ================================================================
    // Step 5: Verify Environment (INV-T1, INV-E2)
    //
    // FCREST-01: When EnvironmentService is absent (FirecREST
    // backend), the Environment verification step is skipped.
    // uenv is embedded in the Job script by FirecrestShellExecutor
    // (F-INV-5). A placeholder EnvironmentId is used for
    // ProvenanceRecord.
    // ================================================================
    let activeEnv: Environment | null = null;
    void activeEnv;
    let envIdForProvenance: EnvironmentId | undefined;
    let envDescriptionForProvenance: string | undefined;

    if (this.#environment !== null) {
      activeEnv = this.#environment.getActiveEnvironment();
      if (activeEnv === null) {
        throw new EnvironmentNotLoaded({
          toolId: tool.id,
          environmentId: undefined,
        });
      }

      if (!environmentMatchesTool(activeEnv, tool)) {
        throw new EnvironmentNotLoaded({
          toolId: tool.id,
          environmentId: envIdForProvenance,
        });
      }

      // Re-verify immediately before execution (X1 "out-of-order" case)
      try {
        const verified = await this.#environment.verifyEnvironment(
          activeEnv.id,
        );
        if (!verified) {
          throw new EnvironmentNotLoaded({
            toolId: tool.id,
      environmentId: envIdForProvenance,
          });
        }
      } catch (error) {
        if (error instanceof EnvironmentNotLoaded) {
          throw error;
        }
        throw new EnvironmentNotLoaded({
          toolId: tool.id,
          environmentId: envIdForProvenance,
          cause: error,
        });
      }

      envIdForProvenance = activeEnv.id;
      envDescriptionForProvenance = this.#buildEnvironmentDescription(activeEnv);
    } else {
      // FirecREST backend: no EnvironmentService. Use a placeholder
      // for the ProvenanceRecord. The actual uenv is loaded in the
      // Job script (F-INV-5).
      envIdForProvenance = 'firecrest-backend' as EnvironmentId;
      envDescriptionForProvenance = 'uenv loaded in Job script (F-INV-5)';
    }

    // ================================================================
    // Step 6: Create ToolInvocation (NOT_STARTED)
    // ================================================================
    const invocationId = generateToolInvocationId();
    const now = new Date();

    const invocation: ToolInvocation = Object.freeze({
      id: invocationId,
      toolId: tool.id,
      parameters: request.parameters,
      inputDatasetIds: request.inputDatasetIds,
      outputDatasetIds: [],
      environmentId: envIdForProvenance,
      state: 'NOT_STARTED',
      exitOutcome: null,
      permissiveExitCodes: request.permissiveExitCodes ?? [],
      executionModel: request.executionModel,
      resourceRequest: request.resourceRequest,
      createdAt: now,
      startedAt: null,
      completedAt: null,
    });

    const observable = createAsyncObservable<ToolInvocationEvent>();
    this.#invocations.set(invocationId as string, {
      invocation,
      observable,
    });

    this.#emitEvent({
      kind: 'tool_invocation_created',
      invocationId,
      toolId: tool.id,
      inputDatasetIds: request.inputDatasetIds,
      timestamp: new Date(),
    });

    // ================================================================
    // Step 7: Start execution (RUNNING)
    // ================================================================
    const startedInvocation: ToolInvocation = Object.freeze({
      ...invocation,
      state: 'RUNNING',
      startedAt: new Date(),
    });
    this.#updateInvocation(startedInvocation);

    this.#emitEvent({
      kind: 'tool_invocation_started',
      invocationId,
      environmentId: envIdForProvenance,
      executionModel: request.executionModel,
      timestamp: new Date(),
    });

    // ================================================================
    // Step 8: Execute
    // ================================================================
    let exitOutcome: ExitOutcome;
    let stderr = '';
    let jobId: JobId | undefined;
    let jobState: JobState | undefined;

    if (request.executionModel === 'parallel') {
      const result = await this.#executeParallel(
        tool,
        request,
        inputDatasets,
      );
      exitOutcome = result.exitOutcome;
      jobId = result.jobId;
      jobState = result.jobState;
    } else {
      const result = await this.#executeSynchronous(
        tool,
        request,
        inputDatasets,
      );
      exitOutcome = result.exitOutcome;
      stderr = result.stderr;
    }

    // ================================================================
    // Step 9: Record ExitOutcome (INV-T2)
    // ================================================================
    const completedInvocation: ToolInvocation = Object.freeze({
      ...startedInvocation,
      state: this.#isSuccess(exitOutcome, request.permissiveExitCodes)
        ? 'COMPLETED'
        : 'FAILED',
      exitOutcome,
      jobId,
      completedAt: new Date(),
    });
    this.#updateInvocation(completedInvocation);

    // ================================================================
    // Step 10: Complete or Fail
    // ================================================================
    const isSuccess = this.#isSuccess(exitOutcome, request.permissiveExitCodes);

    if (isSuccess) {
      // FINDING-I1 fix: ProvenanceRecord written BEFORE Dataset
      // registration. If the process crashes between the two, an
      // orphan ProvenanceRecord (pointing to nothing) is benign.
      // An orphan Dataset without Provenance would risk scientific
      // integrity (INV-D3).
      //
      // The DatasetId is pre-generated so that the ProvenanceRecord
      // can reference it before the Dataset is registered.
      const envDescription = envDescriptionForProvenance;
      const outputDatasetId = generateDatasetId();

      // Step 1: Write ProvenanceRecord (X4) — BEFORE Dataset
      const provenanceRecord = await this.#provenance.writeProvenanceRecord({
        toolId: tool.id,
        toolName: tool.name,
        toolVersion: tool.version,
        parameters: request.parameters,
        environmentId: envIdForProvenance,
        environmentDescription: envDescription,
        inputDatasetIds: request.inputDatasetIds,
        outputDatasetId,
        exitOutcome,
        timestamp: new Date(),
        jobId,
        jobState,
      });

      // Step 2: Register output Dataset (INV-T3 — only on success)
      const outputDataset = await this.#dataManagement.registerDataset({
        id: outputDatasetId,
        name: deriveDatasetName(request.outputLocation),
        location: request.outputLocation,
        format: tool.outputFormats[0] ?? 'netcdf',
        grid: deriveOutputGrid(inputDatasets),
        variables: deriveOutputVariables(inputDatasets),
        producerToolInvocationId: invocationId,
      });

      // Step 3: Mark output Dataset as consumable (INV-D3 / INV-P3)
      await this.#dataManagement.markConsumable(outputDataset.id);

      // Re-query the output Dataset — markConsumable() creates a
      // new frozen Dataset with consumable=true and replaces the
      // old one in the registry. We need the updated one.
      const consumableDataset = await this.#dataManagement.queryDataset(outputDataset.id);
      const finalOutputDataset = consumableDataset ?? outputDataset;

      // Update invocation with output dataset
      const finalInvocation: ToolInvocation = Object.freeze({
        ...completedInvocation,
        outputDatasetIds: [outputDataset.id],
      });
      this.#updateInvocation(finalInvocation);

      // Emit completed event
      this.#emitEvent({
        kind: 'tool_invocation_completed',
        invocationId,
        exitOutcome,
        outputDatasetIds: [outputDataset.id],
        provenanceRecordId: provenanceRecord.id,
        timestamp: new Date(),
      });

      return {
        invocation: finalInvocation,
        outputDatasets: [finalOutputDataset],
        provenanceRecord,
      };
    }

    // Failure: write ProvenanceRecord (with null output), do NOT
    // register output Dataset (INV-T3)
    const envDescription = envDescriptionForProvenance;

    await this.#provenance.writeProvenanceRecord({
      toolId: tool.id,
      toolName: tool.name,
      toolVersion: tool.version,
      parameters: request.parameters,
      environmentId: envIdForProvenance,
      environmentDescription: envDescription,
      inputDatasetIds: request.inputDatasetIds,
      outputDatasetId: null,
      exitOutcome,
      timestamp: new Date(),
      jobId,
      jobState,
    });

    // Emit the appropriate failure event
    if (exitOutcome.kind === 'signal') {
      this.#emitEvent({
        kind: 'tool_invocation_signal_terminated',
        invocationId,
        signalName: exitOutcome.name,
        signalNumber: exitOutcome.number,
        stderr,
        timestamp: new Date(),
      });

      throw new SignalTerminated({
        signalName: exitOutcome.name,
        signalNumber: exitOutcome.number,
        stderr,
        caseId: undefined,
        jobId,
      });
    }

    // Non-zero exit code
    const isPermissive =
      exitOutcome.kind === 'exit_code' &&
      (request.permissiveExitCodes ?? []).includes(exitOutcome.code);

    this.#emitEvent({
      kind: 'tool_invocation_failed',
      invocationId,
      exitOutcome,
      stderr,
      timestamp: new Date(),
    });

    throw new NonZeroExitCode({
      exitCode: exitOutcome.kind === 'exit_code' ? exitOutcome.code : 1,
      permissive: isPermissive,
      stderr,
    });
  }

  // ========================================================================
  // monitorInvocation
  // ========================================================================

  /**
   * Returns an AsyncObservable for monitoring a running
   * ToolInvocation. Emits ToolInvocationEvent as the invocation
   * progresses: created, started, completed, failed,
   * signal_terminated.
   *
   * For an unknown invocation, returns an empty observable.
   *
   * Spec: api-contracts.md §6 (monitorInvocation).
   */
  monitorInvocation(invocationId: ToolInvocationId): AsyncObservable<ToolInvocationEvent> {
    const record = this.#invocations.get(invocationId as string);
    if (record !== undefined) {
      return record.observable;
    }
    // Return an empty observable for unknown invocations
    return createAsyncObservable<ToolInvocationEvent>();
  }

  // ========================================================================
  // Private: execution
  // ========================================================================

  /**
   * Executes a Tool synchronously via CLIExecutor or PythonExecutor.
   *
   * Returns the ExitOutcome and stderr from the ShellResult. Does NOT
   * throw on non-zero exit codes or signals — the caller (invokeTool)
   * handles those.
   */
  async #executeSynchronous(
    tool: Tool,
    request: ToolInvocationRequest,
    inputDatasets: readonly Dataset[],
  ): Promise<SyncExecutionResult> {
    const inputPaths = inputDatasets.map((ds) => ds.location.path);
    const outputPath = request.outputLocation.path;
    const options = {
      timeout: this.#config.commandTimeoutMs,
    };

    let result: ShellResult;

    if (tool.kind === 'cli') {
      result = await this.#cliExecutor.execute({
        tool: tool as CLITool,
        parameters: request.parameters,
        inputPaths,
        outputPath,
        options,
      });
    } else if (tool.kind === 'python') {
      result = await this.#pythonExecutor.execute({
        tool: tool as import('../types').PythonTool,
        parameters: request.parameters,
        inputPaths,
        outputPath,
        options,
      });
    } else {
      // ModelTool (CESM) should not be executed synchronously
      // through invokeTool. The CaseService handles the CESM
      // lifecycle.
      return { exitOutcome: { kind: 'exit_code', code: 1 }, stderr: '' };
    }

    return { exitOutcome: result.exitOutcome, stderr: result.stderr };
  }

  /**
   * Executes a Tool in parallel via the SchedulingService.
   *
   * 1. Builds the command string from the Tool and parameters.
   * 2. Submits a Job via scheduling.submitJob().
   * 3. Polls scheduling.queryJob() until the Job reaches a terminal
   *    state (INV-S1).
   * 4. Maps the terminal Job state to an ExitOutcome (INV-T5).
   *
   * Returns the ExitOutcome, JobId, and JobState.
   */
  async #executeParallel(
    tool: Tool,
    request: ToolInvocationRequest,
    inputDatasets: readonly Dataset[],
  ): Promise<{
    readonly exitOutcome: ExitOutcome;
    readonly jobId: JobId;
    readonly jobState: JobState;
  }> {
    // Build the command for the Job
    const inputPaths = inputDatasets.map((ds) => ds.location.path);
    const outputPath = request.outputLocation.path;

    let command: string;
    if (tool.kind === 'cli') {
      // Build CLI command string
      const parts: string[] = [tool.binary];
      const operatorChain = request.parameters['operatorChain'];
      if (typeof operatorChain === 'string' && operatorChain.trim() !== '') {
        parts.push(operatorChain);
      }
      for (const p of inputPaths) {
        parts.push(p);
      }
      parts.push(outputPath);
      command = parts.join(' ');
    } else if (tool.kind === 'python') {
      const script = request.parameters['script'];
      if (typeof script === 'string') {
        command = `python3 -c '${script.replace(/'/g, "'\\''")}'`;
      } else {
        command = `python3 -m ${tool.moduleName}`;
        const args = request.parameters['args'];
        if (Array.isArray(args)) {
          for (const arg of args) {
            if (typeof arg === 'string') {
              command += ` ${arg}`;
            }
          }
        }
      }
    } else {
      // ModelTool (CESM) — the CaseService handles this
      command = tool.id as string;
    }

    // Submit the Job
    const resourceRequest = request.resourceRequest;
    if (!resourceRequest) {
      // This should never happen — invokeTool() validates this
      // earlier. The guard satisfies the type checker.
      throw new InvalidParameters({
        toolId: tool.id,
        invalidParameters: ['resourceRequest'],
        schema: { type: 'object', description: 'resourceRequest is required for parallel execution' },
      });
    }
    const job = await this.#scheduling.submitJob({
      resourceRequest,
      command,
      workingDirectory: undefined,
    });

    // Poll until terminal state (INV-S1)
    let currentJob = job;
    const maxIterations = 1000; // Safety limit
    for (let i = 0; i < maxIterations; i++) {
      currentJob = await this.#scheduling.queryJob(job.jobId);
      if (isTerminalJobState(currentJob.state)) {
        break;
      }
      // Wait before next poll
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.#config.pollIntervalMs),
      );
    }

    // Map terminal state to ExitOutcome (INV-T5)
    const exitOutcome = jobStateToExitOutcome(
      currentJob.terminalState ?? currentJob.state,
    );

    return {
      exitOutcome,
      jobId: job.jobId,
      jobState: currentJob.state,
    };
  }

  // ========================================================================
  // Private: helpers
  // ========================================================================

  /**
   * Determines if an ExitOutcome indicates success (INV-T3, R4).
   *
   * Success is:
   * - Exit code 0, OR
   * - Exit code in permissiveExitCodes (R4 opt-in)
   *
   * Signal termination is never success.
   */
  #isSuccess(
    exitOutcome: ExitOutcome,
    permissiveExitCodes?: readonly number[],
  ): boolean {
    if (exitOutcome.kind === 'exit_code') {
      if (exitOutcome.code === 0) {
        return true;
      }
      if (permissiveExitCodes !== undefined) {
        return (permissiveExitCodes as readonly number[]).includes(
          exitOutcome.code,
        );
      }
      return false;
    }
    // Signal termination is never success (INV-T5)
    return false;
  }

  /**
   * Builds a human-readable Environment description for the
   * ProvenanceRecord (INV-P2 — full reproducibility tuple includes
   * all modules with versions).
   */
  #buildEnvironmentDescription(env: Environment): string {
    return env.modules.map((m) => `${m.name}/${m.version}`).join(' ');
  }

  /**
   * Updates the internal invocation record and notifies subscribers.
   */
  #updateInvocation(invocation: ToolInvocation): void {
    const record = this.#invocations.get(invocation.id as string);
    if (record !== undefined) {
      record.invocation = invocation;
    }
  }

  /**
   * Emits an event to the global onEvent callback and the
   * invocation's observable subscribers.
   */
  #emitEvent(event: ToolInvocationEvent): void {
    // Emit to global callback
    this.#onEvent?.(event);

    // Emit to the invocation's observable
    const record = this.#invocations.get(event.invocationId as string);
    if (record !== undefined) {
      record.observable.emit(event);
    }
  }
}
