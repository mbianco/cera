/**
 * Domain entity types for cera.
 *
 * These are STUBS — type definitions only, no implementation.
 * The implementer will fill in constructors, factories, and
 * validation logic.
 *
 * Spec references: domain-model.md (updated per resolutions.md R1–R13),
 * ubiquitous-language.md, invariants.md.
 */

import type {
  DatasetId,
  EnvironmentId,
  JobId,
  ToolId,
  ToolInvocationId,
  CaseId,
  WorkflowId,
  WorkflowStepId,
  ExperimentId,
  SessionId,
  UserId,
  ActionId,
  ProvenanceRecordId,
  Format,
  Grid,
  Variable,
  Location,
  ExitOutcome,
  JobState,
  ResourceRequest,
  CaseState,
  WorkflowState,
  SessionState,
  Compset,
  UenvSpec,
  Module,
  CompilerStack,
  Duration,
  JSONSchema,
} from './value-objects';

// ============================================================================
// Tool (C1)
// ============================================================================

/**
 * A legacy scientific capability, wrapped so the Agent can invoke
 * it. Tools have an Environment requirement, an input/output
 * contract (formats, grids), and an execution model.
 *
 * Subtypes: CLITool, PythonTool, ModelTool (CESM).
 *
 * Spec: ubiquitous-language.md Tool [CORE]; domain-model.md C1;
 * resolutions.md R1 (CESM is Model Tool).
 */
export type Tool = CLITool | PythonTool | ModelTool;

export interface ToolBase {
  readonly id: ToolId;
  readonly name: string;
  readonly version: string;
  readonly environmentRequirements: EnvironmentRequirements;
  readonly inputFormats: readonly Format[];
  readonly outputFormats: readonly Format[];
  readonly executionModel: 'synchronous' | 'parallel';
  readonly description: string;
}

/**
 * A Tool invoked as a command-line binary via a shell or
 * subprocess. CDO, NCO, and opengrads (if approved) are CLI Tools.
 *
 * Spec: ubiquitous-language.md CLI Tool [CORE].
 */
export interface CLITool extends ToolBase {
  readonly kind: 'cli';
  readonly binary: string; // e.g., "cdo", "ncks"
  readonly chainable: boolean; // CDO chains, NCO does not
}

/**
 * A Tool invoked via a Python interpreter, using Python libraries
 * (healpy, zarr, ICON grid tools).
 *
 * Spec: ubiquitous-language.md Python Tool [CORE].
 */
export interface PythonTool extends ToolBase {
  readonly kind: 'python';
  readonly moduleName: string; // e.g., "healpy"
  readonly functionName?: string; // e.g., "angular_power_spectrum"
}

/**
 * A Tool with a multi-step lifecycle and parallel execution.
 * CESM is the only ModelTool in scope.
 *
 * The Case lifecycle (create -> configure -> build -> submit ->
 * monitor -> post-process) is a specialized ToolInvocation
 * lifecycle, not a separate bounded context (R1, ADR-001).
 *
 * Spec: resolutions.md R1; ADR-001; domain-model.md C1.
 */
export interface ModelTool extends ToolBase {
  readonly kind: 'model';
  readonly lifecycleSteps: readonly string[]; // ["configure", "build", "submit", "monitor", "post-process"]
}

/**
 * The Environment requirements for a Tool: which uenvs must be
 * mounted, and which binary paths must be available.
 *
 * Spec: invariants.md INV-T1; cross-context/interactions.md X1,
 * X14 (subsumed).
 */
export interface EnvironmentRequirements {
  readonly uenvSpecs: readonly UenvSpec[];
  readonly requiredBinaryPaths?: readonly string[];
  readonly compilerStack?: CompilerStack;
}

// ============================================================================
// ToolInvocation (C1)
// ============================================================================

/**
 * One execution of a Tool with specific parameters on specific input
 * Datasets, producing output Datasets. References a Tool, an
 * Environment, and input Datasets by identity.
 *
 * Spec: domain-model.md C1; invariants.md INV-T1–T5.
 */
export interface ToolInvocation {
  readonly id: ToolInvocationId;
  readonly toolId: ToolId;
  readonly parameters: Record<string, unknown>;
  readonly inputDatasetIds: readonly DatasetId[];
  readonly outputDatasetIds: readonly DatasetId[]; // empty until completed
  readonly environmentId: EnvironmentId; // set when Environment is loaded
  readonly state: ToolInvocationState;
  readonly exitOutcome: ExitOutcome | null; // null until terminated (INV-T2)
  /**
   * R4 (ADR-008): empty by default (strict). Non-zero exit codes
   * are errors unless the User explicitly lists them here as
   * permissive for this specific ToolInvocation.
   */
  readonly permissiveExitCodes: readonly number[];
  readonly executionModel: 'synchronous' | 'parallel';
  readonly resourceRequest?: ResourceRequest; // for parallel
  readonly jobId?: JobId; // for parallel (assigned by SLURM)
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

export type ToolInvocationState = 'NOT_STARTED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

// ============================================================================
// Case (C1 — CESM, formerly C2)
// ============================================================================

/**
 * One CESM experiment configuration. A Case has a name, Compset,
 * resolution, machine target, and run length.
 *
 * CESM is a Model Tool in C1 (R1, ADR-001). The Case aggregate
 * lives in C1, not in a separate C2 bounded context.
 *
 * The output tree Location is determined at Case creation time
 * (R5, INV-T9) and does not change.
 *
 * A Case belongs to exactly one Experiment (R2).
 *
 * Spec: domain-model.md C2 (collapsed into C1); resolutions.md R1,
 * R2, R5; invariants.md INV-T6–T9; features/cesm-submission.feature.
 */
export interface Case {
  readonly id: CaseId;
  readonly name: string;
  readonly compset: Compset;
  readonly resolution: string;
  readonly machine: string;
  readonly runLength: Duration;
  readonly state: CaseState;
  readonly outputTreeLocation: Location; // R5: determined at creation, does not change
  readonly jobId: JobId | null; // set when submitted
  readonly experimentId: ExperimentId; // R2: belongs to exactly one Experiment
  readonly createdAt: Date;
}

// ============================================================================
// Dataset (C3)
// ============================================================================

/**
 * A scientific data artifact consisting of one or more files (or
 * ZARR stores) holding N-dimensional arrays with associated
 * metadata (variables, dimensions, units, grid).
 *
 * A Dataset has exactly one Format, exactly one Grid, one or more
 * Variables, and one Location. Format and Grid are immutable
 * (INV-D1, INV-D2).
 *
 * Spec: ubiquitous-language.md Dataset [CORE]; domain-model.md C3;
 * invariants.md INV-D1–D4.
 */
export interface Dataset {
  readonly id: DatasetId;
  readonly name: string;
  readonly location: Location;
  readonly format: Format;
  readonly grid: Grid;
  readonly variables: readonly Variable[];
  readonly producerToolInvocationId: ToolInvocationId | null;
  readonly consumable: boolean; // false until markConsumable() is called (INV-D3)
  readonly quarantined: boolean;
  readonly quarantineReason?: string;
  readonly createdAt: Date;
}

// ============================================================================
// Job (C4)
// ============================================================================

/**
 * A unit of work submitted to SLURM for execution on compute nodes.
 * Has a JobID (assigned by the Scheduler, INV-S3), a
 * ResourceRequest (immutable after submission, INV-S2), and a
 * JobState (authoritative from the Scheduler, INV-S1).
 *
 * Spec: ubiquitous-language.md Job [CORE]; domain-model.md C4;
 * invariants.md INV-S1–S4; resolutions.md R8, R13.
 */
export interface Job {
  readonly jobId: JobId;
  readonly userId: UserId;
  readonly resourceRequest: ResourceRequest;
  readonly state: JobState;
  readonly terminalState: JobState | null; // set once a terminal state is observed (INV-S4)
  readonly caseId?: CaseId;
  readonly workflowId?: WorkflowId;
  readonly submittedAt: Date;
  readonly completedAt: Date | null;
}

// ============================================================================
// Environment (C5)
// ============================================================================

/**
 * A loaded software stack — a set of active uenv mount paths in
 * PATH and LD_LIBRARY_PATH. At most one Environment is active per
 * execution context (INV-E1).
 *
 * uenv, not Lmod (R9, ADR-003). Environments are squashfs mounts at
 * prescribed paths.
 *
 * Spec: ubiquitous-language.md Environment (Module Environment)
 * [CORE]; domain-model.md C5; invariants.md INV-E1–E3;
 * resolutions.md R9.
 */
export interface Environment {
  readonly id: EnvironmentId;
  readonly uenvSpecs: readonly UenvSpec[];
  readonly modules: readonly Module[];
  readonly compilerStack?: CompilerStack;
  readonly conflictFree: boolean; // verified at load time (INV-E2)
  readonly active: boolean;
  readonly loadedAt: Date;
}

// ============================================================================
// ProvenanceRecord (C6)
// ============================================================================

/**
 * Immutable record of one Dataset's origin or one Job's execution.
 * Contains the full reproducibility tuple (INV-P2).
 *
 * Spec: ubiquitous-language.md Provenance [CORE]; domain-model.md
 * C6; invariants.md INV-P1–P4; resolutions.md R11 (local
 * corruption); ADR-009.
 */
export interface ProvenanceRecord {
  readonly id: ProvenanceRecordId;
  readonly toolId: ToolId; // name + version (INV-P2)
  readonly toolName: string;
  readonly toolVersion: string;
  readonly parameters: Record<string, unknown>; // exact parameters
  readonly environmentId: EnvironmentId; // Environment identity
  readonly environmentDescription: string; // all modules with versions
  readonly inputDatasetIds: readonly DatasetId[]; // input Dataset identities
  readonly outputDatasetId: DatasetId | null; // null for failed invocations
  readonly exitOutcome: ExitOutcome;
  readonly timestamp: Date; // ISO 8601
  readonly jobId?: JobId; // for Job-outcome records
  readonly jobState?: JobState; // for Job-outcome records
  readonly caseId?: CaseId; // for CESM records
  readonly correctsRecordId?: ProvenanceRecordId; // link to prior record if correction
  readonly warningFlag?: boolean; // R4/ADR-008: permissive mode
  readonly defective?: boolean; // flagged if fields are missing or mismatched
}

// ============================================================================
// Workflow (C7)
// ============================================================================

/**
 * An ordered sequence of ToolInvocations and/or Case submissions,
 * with data dependencies. First-class with persisted state (R6,
 * ADR-006). Survives Session end.
 *
 * A Workflow belongs to exactly one Experiment (R2).
 *
 * Spec: ubiquitous-language.md Workflow [CORE]; domain-model.md C7;
 * invariants.md INV-W1–W3; resolutions.md R2, R6.
 */
export interface Workflow {
  readonly id: WorkflowId;
  readonly name: string;
  readonly experimentId: ExperimentId; // R2: belongs to exactly one
  readonly state: WorkflowState;
  readonly steps: readonly WorkflowStep[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * One Tool invocation or Case submission within a Workflow, with
 * explicit input Datasets (referenced) and output Datasets
 * (produced).
 *
 * Spec: domain-model.md C7; invariants.md INV-W1–W3.
 */
export interface WorkflowStep {
  readonly id: WorkflowStepId;
  readonly order: number;
  readonly name: string;
  readonly toolId: ToolId;
  readonly parameters: Record<string, unknown>;
  readonly inputDatasetIds: readonly DatasetId[];
  readonly outputDatasetId?: DatasetId;
  readonly executionModel: 'synchronous' | 'parallel';
  readonly resourceRequest?: ResourceRequest;
  readonly state: 'NOT_STARTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED';
  readonly toolInvocationId?: ToolInvocationId;
  readonly jobId?: JobId;
}

// ============================================================================
// Experiment (C7)
// ============================================================================

/**
 * A scientific investigation consisting of one or more Workflows
 * and CESM Cases, tied together by a research question. First-class
 * entity above Workflow (R2, ADR-002).
 *
 * A Workflow belongs to exactly one Experiment. A Case belongs to
 * exactly one Experiment.
 *
 * Spec: ubiquitous-language.md Experiment [CANDIDATE -> CORE];
 * domain-model.md C7; resolutions.md R2; ADR-002.
 */
export interface Experiment {
  readonly id: ExperimentId;
  readonly name: string;
  readonly researchQuestion: string;
  readonly workflowIds: readonly WorkflowId[];
  readonly caseIds: readonly CaseId[];
  readonly createdAt: Date;
}

// ============================================================================
// Session (C7)
// ============================================================================

/**
 * A single interaction context between a User and the Agent. Has a
 * bounded lifetime (may end before long-running Jobs complete).
 * Carries state about the current Workflow, loaded Environments,
 * and referenced Datasets.
 *
 * On start, proactively reports Job status (R7, ADR-007).
 *
 * Spec: ubiquitous-language.md Session [CORE]; domain-model.md C7;
 * invariants.md INV-W4; resolutions.md R7; ADR-007.
 */
export interface Session {
  readonly id: SessionId;
  readonly user: User;
  readonly state: SessionState;
  readonly currentWorkflowId: WorkflowId | null;
  readonly loadedEnvironmentId: EnvironmentId | null;
  readonly referencedDatasetIds: readonly DatasetId[];
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

// ============================================================================
// User (C7)
// ============================================================================

/**
 * A climate scientist with an HPC account, SLURM access, and a
 * scientific goal expressible as a Workflow.
 *
 * Spec: ubiquitous-language.md User [CORE]; domain-model.md C7.
 */
export interface User {
  readonly id: UserId;
  readonly username: string;
  readonly hpcAccount: string; // e.g., "s1234"
  readonly slurmUsername: string;
}

// ============================================================================
// Action (C7 — LLM-facing concept, R3)
// ============================================================================

/**
 * A domain-level operation exposed to the LLM (e.g., "select
 * variable", "compute time mean", "remap grid"). An Action may map
 * to one or more CLI operators or Python calls.
 *
 * Replaces "Operator (Agent)" which was overloaded with CDO/NCO
 * operators (R3).
 *
 * The Agent validates Action requests against the Tool catalog
 * before invocation. If the Tool name or parameters are not in the
 * catalog, the Agent refuses and asks the User (R12, ADR-010).
 *
 * Spec: resolutions.md R3, R12; ubiquitous-language.md Action
 * [CORE]; ADR-010.
 */
export interface Action {
  readonly id: ActionId;
  readonly name: string; // e.g., "select_variable", "compute_time_mean", "remap_grid"
  readonly description: string; // for the LLM
  readonly toolId: ToolId; // maps to a Tool
  readonly parameterSchema: JSONSchema; // for validation
  readonly inputRequirements: {
    readonly formats: readonly Format[];
    readonly grids: readonly Grid[];
    readonly variables?: readonly string[];
  };
  readonly outputDescription: {
    readonly format: Format;
    readonly grid?: Grid;
  };
}
