/**
 * Value object types for cera.
 *
 * These are STUBS — type definitions only, no implementation.
 * The implementer will fill in constructors, factories, and
 * validation logic.
 *
 * Spec references: domain-model.md, ubiquitous-language.md,
 * resolutions.md (R1–R13), invariants.md.
 */

// ============================================================================
// Branded IDs
// ============================================================================

/**
 * Branded string type for entity identifiers. Prevents accidental
 * mixing of IDs from different entities (e.g., DatasetId vs JobId).
 */
declare const brand: unique symbol;
type Branded<T, B> = T & { readonly [brand]: B };

export type DatasetId = Branded<string, 'Dataset'>;
export type EnvironmentId = Branded<string, 'Environment'>;
export type JobId = Branded<number, 'Job'>;
export type ToolId = Branded<string, 'Tool'>;
export type ToolInvocationId = Branded<string, 'ToolInvocation'>;
export type CaseId = Branded<string, 'Case'>;
export type WorkflowId = Branded<string, 'Workflow'>;
export type WorkflowStepId = Branded<string, 'WorkflowStep'>;
export type ExperimentId = Branded<string, 'Experiment'>;
export type SessionId = Branded<string, 'Session'>;
export type UserId = Branded<string, 'User'>;
export type ActionId = Branded<string, 'Action'>;
export type ProvenanceRecordId = Branded<string, 'ProvenanceRecord'>;

// ============================================================================
// Format
// ============================================================================

/**
 * The on-disk encoding of a Dataset.
 * Spec: ubiquitous-language.md Format [CORE]; domain-model.md C3.
 */
export type Format = 'netcdf' | 'zarr' | 'grib2';

// ============================================================================
// Grid
// ============================================================================

/**
 * The spatial discretization of a Dataset.
 * Spec: ubiquitous-language.md Grid [CORE]; domain-model.md C3.
 */
export type Grid =
  | { readonly kind: 'lat-lon'; readonly nlat: number; readonly nlon: number }
  | { readonly kind: 'icon'; readonly refinementLevel: string }
  | { readonly kind: 'healpix'; readonly nside: number; readonly nest: boolean }
  | { readonly kind: 'grib2-native'; readonly spectral: string };

// ============================================================================
// Variable
// ============================================================================

/**
 * A named physical quantity within a Dataset.
 * Spec: ubiquitous-language.md Variable [CORE]; domain-model.md C3.
 */
export interface Variable {
  readonly name: string;
  readonly units: string;
  readonly dimensions: readonly string[];
}

// ============================================================================
// Location
// ============================================================================

/**
 * The filesystem path or URI where a Dataset resides.
 * Spec: domain-model.md C3; invariants.md INV-D4.
 */
export interface Location {
  readonly path: string;
  readonly filesystem: 'scratch' | 'store' | 'local';
}

// ============================================================================
// ExitOutcome
// ============================================================================

/**
 * The outcome of a terminated process: either an Exit Code or a
 * Signal, never both, never neither (INV-T2).
 *
 * Spec: invariants.md INV-T2, INV-T5; domain-model.md C1.
 */
export type ExitOutcome =
  | { readonly kind: 'exit_code'; readonly code: number }
  | { readonly kind: 'signal'; readonly name: string; readonly number: number };

// ============================================================================
// JobState
// ============================================================================

/**
 * The lifecycle status of a SLURM Job.
 * Includes UNKNOWN for when SLURM is unreachable (R13, FM-S2).
 *
 * Spec: ubiquitous-language.md State (Job State) [CORE];
 * invariants.md INV-S1, INV-S4; resolutions.md R13.
 */
export type JobState =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'OUT_OF_MEMORY'
  | 'NODE_FAIL'
  | 'UNKNOWN';

/** SLURM terminal states — once reached, no transition back (INV-S4). */
export const TERMINAL_JOB_STATES: readonly JobState[] = [
  'COMPLETED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
  'OUT_OF_MEMORY',
  'NODE_FAIL',
] as const;

export function isTerminalJobState(state: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

// ============================================================================
// ResourceRequest
// ============================================================================

/**
 * The compute resources a SLURM Job asks for.
 * Immutable after submission (INV-S2).
 *
 * Spec: ubiquitous-language.md Resource Request [CORE];
 * domain-model.md C4; invariants.md INV-S2.
 */
export interface ResourceRequest {
  readonly nodes: number;
  readonly coresPerNode: number;
  readonly memory: string; // e.g., "128GB"
  readonly wallTime: string; // SLURM format: "HH:MM:SS"
  readonly partition: string; // e.g., "normal", "priority", "gpu"
  readonly qos: string; // e.g., "default"
}

// ============================================================================
// CaseState
// ============================================================================

/**
 * The lifecycle status of a CESM Case.
 * CESM is a Model Tool in C1 (R1, ADR-001).
 *
 * Spec: domain-model.md C2 (collapsed into C1);
 * resolutions.md R1; features/cesm-submission.feature.
 */
export type CaseState =
  | 'CREATED'
  | 'CONFIGURED'
  | 'BUILT'
  | 'SUBMITTED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/** CESM terminal states. */
export const TERMINAL_CASE_STATES: readonly CaseState[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

// ============================================================================
// WorkflowState
// ============================================================================

/**
 * The lifecycle status of a Workflow. First-class, persisted (R6,
 * ADR-006).
 *
 * Spec: domain-model.md C7; resolutions.md R6;
 * ubiquitous-language.md State (Workflow State) [CANDIDATE →
 * VALIDATED].
 */
export type WorkflowState =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'COMPLETE'
  | 'FAILED';

// ============================================================================
// SessionState
// ============================================================================

/**
 * The lifecycle status of a Session.
 *
 * Spec: domain-model.md C7 (Session aggregate); resolutions.md R7
 * (proactive Job reporting on start).
 */
export type SessionState = 'ACTIVE' | 'ENDED';

// ============================================================================
// Compset (CESM)
// ============================================================================

/**
 * A predefined combination of model components for a CESM Case.
 * Spec: ubiquitous-language.md Compset (CESM) [LEGACY].
 */
export type Compset = string; // e.g., "BHIST", "B1850"

// ============================================================================
// UenvSpec (Environment Management)
// ============================================================================

/**
 * A uenv (user environment) specification: squashfs mount at a
 * prescribed path.
 *
 * Spec: resolutions.md R9; ADR-003.
 */
export interface UenvSpec {
  readonly name: string;
  readonly version: string;
  readonly mountPath: string;
}

// ============================================================================
// Module (uenv component, not Lmod)
// ============================================================================

/**
 * A component within a uenv mount (e.g., a compiler, an MPI
 * runtime). Identified by its mount path and version.
 *
 * Note: This is a uenv component, not a Lmod module (R9, ADR-003).
 * The term "Module" in ubiquitous language is qualified: it refers
 * to a uenv component, not a `module load` operation.
 *
 * Spec: ubiquitous-language.md Module (Software Module) [CORE —
 * reinterpreted for uenv]; resolutions.md R9.
 */
export interface Module {
  readonly name: string;
  readonly version: string;
  readonly prefix: string; // mount path within the uenv
}

// ============================================================================
// CompilerStack
// ============================================================================

/**
 * A specific compiler and its associated runtime libraries.
 * Spec: ubiquitous-language.md Compiler Stack [CORE].
 */
export interface CompilerStack {
  readonly compiler: Module;
  readonly mpiRuntime?: Module;
  readonly libraries: readonly Module[];
}

// ============================================================================
// Duration
// ============================================================================

/**
 * A time duration (e.g., "5 years", "168:00:00").
 * Used for CESM run lengths and SLURM wall times.
 */
export type Duration = string;

// ============================================================================
// JSONSchema
// ============================================================================

/**
 * A JSON Schema for validating Tool parameters.
 * Used by the Action service (R3) and the LLM hallucination
 * policy (R12, ADR-010).
 */
export type JSONSchema = {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
};

// ============================================================================
// Conflict (Environment)
// ============================================================================

/**
 * A conflict between two uenvs at the filesystem path level.
 * Spec: resolutions.md R9; invariants.md INV-E2 (updated for uenv);
 * ADR-003.
 */
export interface Conflict {
  readonly uenvA: UenvSpec;
  readonly uenvB: UenvSpec;
  readonly conflictPath: string;
  readonly conflictType: 'path' | 'library' | 'compiler';
  readonly description: string;
}

// ============================================================================
// AsyncObservable<T>
// ============================================================================

/**
 * A streaming type for long-running operations. A subset of
 * `AsyncIterable<T>` with additional lifecycle management.
 *
 * Used by scheduling (Job monitoring), tool-invocation (process
 * monitoring), and agent-interaction (Case state monitoring).
 *
 * Spec: api-contracts.md (AsyncObservable Type section).
 */
export interface AsyncObservable<T> {
  /** Async iteration over events. */
  [Symbol.asyncIterator](): AsyncIterator<T>;

  /** Subscribe to events with a callback. Returns an unsubscribe fn. */
  subscribe(callback: (event: T) => void): () => void;

  /** Cancel the observable (e.g., stop polling a Job). */
  cancel(): void;
}
