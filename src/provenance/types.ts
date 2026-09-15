/**
 * Public types for the provenance module (C6).
 *
 * ProvenanceRecords are immutable (INV-P1), capture the full
 * reproducibility tuple (INV-P2), must exist before a Dataset is
 * consumed (INV-P3), and persist across Sessions (INV-P4).
 *
 * The WriteProvenanceInput extends the base contract from
 * api-contracts.md §4 with `toolName`, `toolVersion`, and
 * `environmentDescription`. These fields are required by INV-P2
 * (the full reproducibility tuple includes Tool identity as
 * name + version, and Environment identity as all modules with
 * versions). The caller (tool-invocation in Phase 4) has access
 * to the Tool and Environment entities and provides these values.
 * See specs/escalations/003-provenance-write-input-spec-gap.md.
 *
 * Spec references: api-contracts.md §4; module-graph.md §4;
 * invariants.md INV-P1–P4; resolutions.md R11; ADR-009.
 */

import type {
  CaseId,
  DatasetId,
  Environment,
  EnvironmentId,
  ExitOutcome,
  JobId,
  JobState,
  ProvenanceRecord,
  ProvenanceRecordId,
  ToolId,
} from '../types';

// ============================================================================
// WriteProvenanceInput
// ============================================================================

/**
 * Input for writing an immutable ProvenanceRecord.
 *
 * All fields in the reproducibility tuple must be non-null (INV-P2).
 * If any required field is null, `ProvenanceError.MissingField` is
 * thrown by the service.
 *
 * `outputDatasetId` is null for failed invocations (INV-T3: no output
 * registered, but a ProvenanceRecord is still written to record the
 * failure).
 *
 * Spec: api-contracts.md §4; invariants.md INV-P1, INV-P2.
 */
export interface WriteProvenanceInput {
  readonly toolId: ToolId;
  /** Tool name for the reproducibility tuple (INV-P2). */
  readonly toolName: string;
  /** Tool version for the reproducibility tuple (INV-P2). */
  readonly toolVersion: string;
  /** Exact parameters used for the invocation. */
  readonly parameters: Record<string, unknown>;
  readonly environmentId: EnvironmentId;
  /** Human-readable description of all Modules with versions (INV-P2). */
  readonly environmentDescription: string;
  readonly inputDatasetIds: readonly DatasetId[];
  /** null for failed invocations — no output Dataset is produced. */
  readonly outputDatasetId: DatasetId | null;
  readonly exitOutcome: ExitOutcome;
  /** ISO 8601 timestamp of the invocation. */
  readonly timestamp: Date;
  /** For Job-outcome records. */
  readonly jobId?: JobId;
  /** For Job-outcome records. */
  readonly jobState?: JobState;
  /** For CESM records. */
  readonly caseId?: CaseId;
}

// ============================================================================
// ReconstructInput
// ============================================================================

/**
 * Input for best-effort reconstruction of a corrupted or missing
 * ProvenanceRecord from available metadata.
 *
 * Spec: api-contracts.md §4; failure-modes.md FM-P2;
 * resolutions.md R11 (local, not systemic).
 */
export interface ReconstructInput {
  readonly datasetId: DatasetId;
  readonly availableMetadata: {
    readonly toolInvocationLogs?: string;
    readonly environmentState?: Environment;
    readonly partialRecord?: Partial<ProvenanceRecord>;
  };
}

// ============================================================================
// ProvenanceConfig
// ============================================================================

/**
 * Configuration for the provenance module.
 *
 * The store is a directory of JSON files (ADR-009): one file per
 * ProvenanceRecord at `<storePath>/<record-id>.json`. Quarantined
 * Datasets are tracked at `<storePath>/quarantine/<dataset-id>.json`.
 *
 * Write retries follow FM-P1: retry with exponential backoff up to
 * `maxRetries` times. If all retries fail, `WriteFailed` is thrown.
 *
 * Spec: ADR-009; failure-modes.md FM-P1; invariants.md INV-P4.
 */
export interface ProvenanceConfig {
  /** Filesystem path to the Provenance store directory. */
  readonly storePath: string;
  /** Maximum retry attempts for write failures (FM-P1). Default: 3. */
  readonly maxRetries: number;
  /** Initial delay before first retry (milliseconds). Default: 100. */
  readonly retryInitialDelayMs: number;
  /** Backoff multiplier applied after each retry. Default: 2. */
  readonly retryBackoffMultiplier: number;
}

/**
 * Default provenance configuration per ADR-009 and FM-P1.
 *
 * Store path: `~/.cera/provenance` (user-specific, HPC filesystem).
 * Retries: 3 attempts with 100ms initial delay, 2x backoff.
 */
export const DEFAULT_PROVENANCE_CONFIG: ProvenanceConfig = {
  storePath: '~/.cera/provenance',
  maxRetries: 3,
  retryInitialDelayMs: 100,
  retryBackoffMultiplier: 2,
};

// ============================================================================
// ProvenanceService interface
// ============================================================================

/**
 * Provenance recording and querying. ProvenanceRecords are immutable
 * (INV-P1) and persist across Sessions (INV-P4).
 *
 * A corrupted ProvenanceRecord is a LOCAL issue (R11, ADR-009): the
 * affected Dataset is quarantined, not the entire store. Other
 * Datasets with valid records remain available.
 *
 * Spec: api-contracts.md §4; module-graph.md §4; invariants.md
 * INV-P1–P4; failure-modes.md FM-P1–P3; resolutions.md R11; ADR-009.
 */
export interface ProvenanceService {
  /**
   * Writes an immutable ProvenanceRecord. All fields must be
   * non-null (INV-P2).
   *
   * @throws {import('../types').ProvenanceError & { kind: 'write_failed' }}
   *   if the store is unreachable or the write fails after all
   *   retries (FM-P1).
   * @throws {import('../types').ProvenanceError & { kind: 'missing_field' }}
   *   if any field in the reproducibility tuple is null (INV-P2).
   */
  writeProvenanceRecord(input: WriteProvenanceInput): Promise<ProvenanceRecord>;

  /**
   * Queries the ProvenanceRecord for a Dataset.
   * Returns null if no record exists.
   */
  queryProvenanceRecord(datasetId: DatasetId): Promise<ProvenanceRecord | null>;

  /**
   * Queries the ProvenanceRecord for a Job outcome.
   */
  queryProvenanceForJob(jobId: JobId): Promise<ProvenanceRecord | null>;

  /**
   * Queries the full lineage chain for a Dataset, tracing back
   * through input Datasets recursively.
   */
  queryLineage(datasetId: DatasetId): Promise<ProvenanceRecord[]>;

  /**
   * Verifies a ProvenanceRecord exists and is valid for a Dataset
   * (INV-P3). Returns false if no record exists or the record is
   * corrupted.
   *
   * @throws {import('../types').ProvenanceError & { kind: 'record_corrupted' }}
   *   if the record exists but is corrupted (FM-P2). The caller
   *   should quarantine the Dataset (R11: local, not systemic).
   */
  verifyProvenance(datasetId: DatasetId): Promise<boolean>;

  /**
   * Attempts to reconstruct a corrupted/missing ProvenanceRecord
   * from available metadata. Returns null if reconstruction fails
   * (FM-P2).
   */
  reconstructProvenanceRecord(input: ReconstructInput): Promise<ProvenanceRecord | null>;

  /**
   * Quarantines a Dataset whose ProvenanceRecord is corrupted or
   * missing. Only the affected Dataset is quarantined — not the
   * entire store (R11).
   */
  quarantineDataset(datasetId: DatasetId, reason: string): Promise<void>;
}

// ============================================================================
// Branded ID helpers (internal to this module)
// ============================================================================

/**
 * Creates a ProvenanceRecordId from a string. Uses a type assertion
 * because the brand symbol is private to value-objects.ts.
 */
export function createProvenanceRecordId(id: string): ProvenanceRecordId {
  return id as ProvenanceRecordId;
}
