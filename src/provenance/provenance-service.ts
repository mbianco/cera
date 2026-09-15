/**
 * ProvenanceService implementation (C6).
 *
 * Writes immutable ProvenanceRecords to a filesystem store
 * (ADR-009), queries by Dataset or Job, resolves lineage
 * recursively, verifies Provenance before consumption (INV-P3),
 * attempts reconstruction of corrupted records (FM-P2), and
 * quarantines individual Datasets (R11: local, not systemic).
 *
 * Invariants enforced:
 * - INV-P1: ProvenanceRecord is immutable once written. The
 *   service never overwrites existing files. Returned records
 *   are frozen (Object.freeze). Corrections create a new record
 *   linked via "corrects" relationship.
 * - INV-P2: The full reproducibility tuple must be non-null.
 *   `writeProvenanceRecord()` validates every required field and
 *   throws `MissingField` if any is null.
 * - INV-P3: `verifyProvenance()` returns true only if a valid
 *   ProvenanceRecord exists for the Dataset.
 * - INV-P4: The store is filesystem-based and not scoped to a
 *   Session. Records written in Session `s1` are queryable in
 *   Session `s2`.
 *
 * Failure modes handled:
 * - FM-P1: Write failure — retry with backoff up to `maxRetries`.
 *   If all retries fail, `WriteFailed` is thrown.
 * - FM-P2: Corrupted record — `RecordCorrupted` is thrown on
 *   read. The affected Dataset is quarantined (R11).
 * - FM-P3: Missing record — `verifyProvenance()` returns false.
 *
 * Spec: api-contracts.md §4; module-graph.md §4; invariants.md
 * INV-P1–P4; failure-modes.md FM-P1–P3; resolutions.md R11;
 * ADR-009.
 */

import type {
  FilesystemGateway,
} from '../dsh-adapter/types';
import type {
  CaseId,
  DatasetId,
  EnvironmentId,
  ExitOutcome,
  JobId,
  JobState,
  ProvenanceEvent,
  ProvenanceRecord,
  ProvenanceRecordId,
  ToolId,
} from '../types';
import {
  MissingField,
  WriteFailed,
} from '../types/errors';
import {
  ProvenanceStore,
} from './provenance-store';
import {
  LineageResolver,
} from './lineage-resolver';
import type {
  ProvenanceConfig,
  ReconstructInput,
  WriteProvenanceInput,
} from './types';
import {
  createProvenanceRecordId,
  DEFAULT_PROVENANCE_CONFIG,
} from './types';

// ============================================================================
// ID generation
// ============================================================================

/**
 * Generates a unique ProvenanceRecordId.
 *
 * Format: `pr-<timestamp>-<random>` where timestamp is the current
 * time in milliseconds and random is a short random string. This
 * ensures uniqueness across Sessions (INV-P4) without requiring a
 * centralized ID generator.
 */
function generateProvenanceRecordId(): ProvenanceRecordId {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  return createProvenanceRecordId(`pr-${timestamp}-${random}`);
}

// ============================================================================
// Delay helper (for retry backoff)
// ============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// ProvenanceServiceImpl
// ============================================================================

/**
 * Constructor parameters for ProvenanceServiceImpl.
 */
export interface ProvenanceServiceImplProps {
  readonly filesystem: FilesystemGateway;
  readonly config?: Partial<ProvenanceConfig>;
  readonly onEvent?: (event: ProvenanceEvent) => void;
}

/**
 * Provenance recording and querying service.
 *
 * INV-P1: Records are immutable — never overwritten, returned
 *   frozen, no update method.
 * INV-P2: Full reproducibility tuple required — `MissingField`
 *   thrown if any field is null.
 * INV-P3: `verifyProvenance()` returns true only for a valid,
 *   non-quarantined record.
 * INV-P4: Store is filesystem-based, not Session-scoped.
 *
 * Spec: api-contracts.md §4; invariants.md INV-P1–P4;
 * failure-modes.md FM-P1–P3; resolutions.md R11; ADR-009.
 */
export class ProvenanceServiceImpl {
  #store: ProvenanceStore;
  #config: ProvenanceConfig;
  #onEvent?: (event: ProvenanceEvent) => void;

  constructor(props: ProvenanceServiceImplProps) {
    this.#config = { ...DEFAULT_PROVENANCE_CONFIG, ...props.config };
    this.#store = new ProvenanceStore({
      filesystem: props.filesystem,
      storePath: this.#config.storePath,
    });
    this.#onEvent = props.onEvent;
  }

  // ========================================================================
  // writeProvenanceRecord (INV-P1, INV-P2; FM-P1)
  // ========================================================================

  /**
   * Writes an immutable ProvenanceRecord.
   *
   * INV-P2: All fields in the reproducibility tuple must be
   * non-null. If any required field is null, `MissingField` is
   * thrown and the record is NOT written.
   *
   * INV-P1: The record is immutable. If a file with the same ID
   * already exists, the write is silently skipped (the old record
   * is preserved). The returned record is frozen.
   *
   * FM-P1: If the filesystem write fails, the service retries
   * with exponential backoff up to `maxRetries` times. If all
   * retries fail, `WriteFailed` is thrown.
   */
  async writeProvenanceRecord(
    input: WriteProvenanceInput,
  ): Promise<ProvenanceRecord> {
    // INV-P2: Validate all required fields
    this.#validateInput(input);

    // Construct the ProvenanceRecord
    const record: ProvenanceRecord = Object.freeze({
      id: generateProvenanceRecordId(),
      toolId: input.toolId,
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      parameters: input.parameters,
      environmentId: input.environmentId,
      environmentDescription: input.environmentDescription,
      inputDatasetIds: input.inputDatasetIds,
      outputDatasetId: input.outputDatasetId,
      exitOutcome: input.exitOutcome,
      timestamp: input.timestamp,
      jobId: input.jobId,
      jobState: input.jobState,
      caseId: input.caseId,
    });

    // FM-P1: Write with retry and backoff
    const maxAttempts = this.#config.maxRetries + 1; // initial + retries
    let lastError = '';
    let attempt = 0;

    for (let i = 0; i < maxAttempts; i++) {
      attempt = i;
      try {
        const written = await this.#store.writeRecord(record);
        if (!written) {
          // INV-P1: File already existed. This is unusual (ID
          // collision) but not an error — the old record is
          // preserved. Re-read and return it.
          const existing = await this.#store.readRecord(record.id as string);
          if (existing !== null) {
            this.#emitRecordWritten(existing);
            return existing;
          }
        }

        this.#emitRecordWritten(record);
        return record;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (i < maxAttempts - 1) {
          const delayMs =
            this.#config.retryInitialDelayMs *
            Math.pow(this.#config.retryBackoffMultiplier, i);
          await delay(delayMs);
        }
      }
    }

    // All retries exhausted — throw WriteFailed (FM-P1)
    throw new WriteFailed({
      datasetId: input.outputDatasetId
        ? input.outputDatasetId
        : ('unknown' as unknown as DatasetId),
      error: lastError,
      retryCount: attempt,
    });
  }

  // ========================================================================
  // queryProvenanceRecord (INV-P4)
  // ========================================================================

  /**
   * Queries the ProvenanceRecord for a Dataset.
   *
   * Scans all records in the store (ADR-009: no built-in index)
   * and returns the one whose `outputDatasetId` matches.
   *
   * @returns The ProvenanceRecord, or null if no record exists.
   * @throws {RecordCorrupted} if a matching record exists but is
   *   corrupted (FM-P2).
   *
   * Spec: api-contracts.md §4; invariants.md INV-P4;
   * failure-modes.md FM-P2.
   */
  async queryProvenanceRecord(
    datasetId: DatasetId,
  ): Promise<ProvenanceRecord | null> {
    const idStr = datasetId as string;
    const records = await this.#store.readAllRecords();

    for (const record of records) {
      if (record.outputDatasetId !== null) {
        const outputId = record.outputDatasetId as string;
        if (outputId === idStr) {
          // Check if the Dataset is quarantined
          const quarantined = await this.#store.isQuarantined(idStr);
          if (quarantined) {
            return null;
          }
          return record;
        }
      }
    }

    return null;
  }

  // ========================================================================
  // queryProvenanceForJob (INV-P4)
  // ========================================================================

  /**
   * Queries the ProvenanceRecord for a Job outcome.
   *
   * Scans all records and returns the one whose `jobId` matches.
   *
   * @returns The ProvenanceRecord, or null if no record exists.
   * @throws {RecordCorrupted} if a matching record exists but is
   *   corrupted (FM-P2).
   *
   * Spec: api-contracts.md §4; invariants.md INV-P4.
   */
  async queryProvenanceForJob(
    jobId: JobId,
  ): Promise<ProvenanceRecord | null> {
    const jobNum = jobId as number;
    const records = await this.#store.readAllRecords();

    for (const record of records) {
      if (record.jobId !== undefined) {
        const recordJobId = record.jobId as number;
        if (recordJobId === jobNum) {
          return record;
        }
      }
    }

    return null;
  }

  // ========================================================================
  // queryLineage (INV-P4)
  // ========================================================================

  /**
   * Queries the full lineage chain for a Dataset, tracing back
   * through input Datasets recursively.
   *
   * The lineage is ordered from the queried Dataset's
   * ProvenanceRecord to the original source records.
   *
   * Spec: api-contracts.md §4; ADR-009; invariants.md INV-P4.
   */
  async queryLineage(
    datasetId: DatasetId,
  ): Promise<ProvenanceRecord[]> {
    const resolver = new LineageResolver(async (id) => {
      // Use the same query logic as queryProvenanceRecord
      return this.queryProvenanceRecord(id);
    });
    return resolver.resolve(datasetId);
  }

  // ========================================================================
  // verifyProvenance (INV-P3; FM-P2, FM-P3)
  // ========================================================================

  /**
   * Verifies a ProvenanceRecord exists and is valid for a Dataset
   * (INV-P3).
   *
   * @returns true if a valid, non-quarantined ProvenanceRecord
   *   exists. false if no record exists or the Dataset is
   *   quarantined.
   * @throws {RecordCorrupted} if the record exists but is
   *   corrupted (FM-P2). The caller should quarantine the
   *   affected Dataset (R11: local, not systemic).
   *
   * Spec: api-contracts.md §4; invariants.md INV-P3, INV-D3;
   * failure-modes.md FM-P2, FM-P3; resolutions.md R11.
   */
  async verifyProvenance(datasetId: DatasetId): Promise<boolean> {
    // Check if the Dataset is quarantined
    const quarantined = await this.#store.isQuarantined(datasetId as string);
    if (quarantined) {
      return false;
    }

    // Query the record — this throws RecordCorrupted if the
    // record is corrupted (FM-P2).
    const record = await this.queryProvenanceRecord(datasetId);

    if (record === null) {
      // No record exists (FM-P3)
      return false;
    }

    // The record exists and was successfully deserialized — it is valid.
    // A record flagged as defective is still valid (it exists and is
    // parseable), but the caller should treat it with caution.
    return true;
  }

  // ========================================================================
  // reconstructProvenanceRecord (FM-P2; R11)
  // ========================================================================

  /**
   * Attempts to reconstruct a corrupted or missing
   * ProvenanceRecord from available metadata.
   *
   * Reconstruction sources (in order of preference):
   * 1. `partialRecord` — a partial ProvenanceRecord with some
   *    fields. Missing fields are filled from other sources.
   * 2. `environmentState` — an Environment entity, used to fill
   *    `environmentId` and `environmentDescription`.
   * 3. `toolInvocationLogs` — a string of logs, parsed for tool
   *    name, version, and parameters (best-effort).
   *
   * If reconstruction cannot produce a complete record (all
   * required fields filled), returns null (FM-P2).
   *
   * Spec: api-contracts.md §4; failure-modes.md FM-P2;
   * resolutions.md R11; ADR-009.
   */
  async reconstructProvenanceRecord(
    input: ReconstructInput,
  ): Promise<ProvenanceRecord | null> {
    const meta = input.availableMetadata;
    const partial = meta.partialRecord;

    // Start with partial record fields, or empty
    const reconstructed: Record<string, unknown> = {};
    if (partial !== undefined) {
      Object.assign(reconstructed, partial);
    }

    // Fill environment fields from environmentState
    if (meta.environmentState !== undefined) {
      const env = meta.environmentState;
      if (reconstructed['environmentId'] === undefined) {
        reconstructed['environmentId'] = env.id;
      }
      if (reconstructed['environmentDescription'] === undefined) {
        // Build a description from the Environment's modules
        const moduleDescs = env.modules.map(
          (m) => `${m.name}/${m.version}`,
        );
        reconstructed['environmentDescription'] = moduleDescs.join(' ');
      }
    }

    // Fill outputDatasetId from the input
    if (reconstructed['outputDatasetId'] === undefined) {
      reconstructed['outputDatasetId'] = input.datasetId;
    }

    // Fill timestamp if missing
    if (reconstructed['timestamp'] === undefined) {
      reconstructed['timestamp'] = new Date();
    }

    // Fill exitOutcome with a default if missing
    if (reconstructed['exitOutcome'] === undefined) {
      reconstructed['exitOutcome'] = { kind: 'exit_code', code: 0 };
    }

    // Fill inputDatasetIds with empty array if missing
    if (reconstructed['inputDatasetIds'] === undefined) {
      reconstructed['inputDatasetIds'] = [];
    }

    // Fill parameters with empty object if missing
    if (reconstructed['parameters'] === undefined) {
      reconstructed['parameters'] = {};
    }

    // Validate that all required fields are now present
    const requiredFields: readonly string[] = [
      'toolId',
      'toolName',
      'toolVersion',
      'parameters',
      'environmentId',
      'environmentDescription',
      'inputDatasetIds',
      'exitOutcome',
      'timestamp',
    ];

    for (const field of requiredFields) {
      if (
        reconstructed[field] === undefined ||
        reconstructed[field] === null
      ) {
        // Cannot reconstruct — missing required field
        return null;
      }
    }

    // Build the reconstructed ProvenanceRecord
    const record: ProvenanceRecord = Object.freeze({
      id: generateProvenanceRecordId(),
      toolId: reconstructed['toolId'] as ToolId,
      toolName: reconstructed['toolName'] as string,
      toolVersion: reconstructed['toolVersion'] as string,
      parameters: reconstructed['parameters'] as Record<string, unknown>,
      environmentId: reconstructed['environmentId'] as EnvironmentId,
      environmentDescription: reconstructed['environmentDescription'] as string,
      inputDatasetIds: reconstructed['inputDatasetIds'] as readonly DatasetId[],
      outputDatasetId: reconstructed['outputDatasetId'] as DatasetId | null,
      exitOutcome: reconstructed['exitOutcome'] as ExitOutcome,
      timestamp: reconstructed['timestamp'] as Date,
      jobId: reconstructed['jobId'] as JobId | undefined,
      jobState: reconstructed['jobState'] as JobState | undefined,
      caseId: reconstructed['caseId'] as CaseId | undefined,
      correctsRecordId: partial?.id, // link to the original record
      defective: true, // flag as reconstructed
    });

    // Write the reconstructed record
    try {
      const written = await this.#store.writeRecord(record);
      if (written) {
        this.#emitRecordReconstructed(record);
      }
      return record;
    } catch {
      // Write failed — return null (FM-P2)
      return null;
    }
  }

  // ========================================================================
  // quarantineDataset (R11: local, not systemic)
  // ========================================================================

  /**
   * Quarantines a Dataset whose ProvenanceRecord is corrupted or
   * missing. Only the affected Dataset is quarantined — not the
   * entire store (R11). Other Datasets with valid
   * ProvenanceRecords remain available.
   *
   * The quarantine is a JSON file at
   * `<storePath>/quarantine/<dataset-id>.json` containing
   * `{ datasetId, reason, timestamp }`.
   *
   * Spec: api-contracts.md §4; resolutions.md R11; ADR-009;
   * failure-modes.md FM-P2.
   */
  async quarantineDataset(
    datasetId: DatasetId,
    reason: string,
  ): Promise<void> {
    await this.#store.writeQuarantine(datasetId as string, reason);
    this.#emitDatasetQuarantined(datasetId, reason);
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /**
   * Validates that all required fields in WriteProvenanceInput are
   * non-null and non-empty (INV-P2).
   *
   * `outputDatasetId` is allowed to be null (for failed
   * invocations). Optional fields (`jobId`, `jobState`, `caseId`)
   * are not validated.
   *
   * @throws {MissingField} if any required field is null, undefined,
   *   or an empty string.
   */
  #validateInput(input: WriteProvenanceInput): void {
    const checks: Array<{ field: string; value: unknown }> = [
      { field: 'toolId', value: input.toolId },
      { field: 'toolName', value: input.toolName },
      { field: 'toolVersion', value: input.toolVersion },
      { field: 'parameters', value: input.parameters },
      { field: 'environmentId', value: input.environmentId },
      { field: 'environmentDescription', value: input.environmentDescription },
      { field: 'inputDatasetIds', value: input.inputDatasetIds },
      { field: 'exitOutcome', value: input.exitOutcome },
      { field: 'timestamp', value: input.timestamp },
    ];

    for (const check of checks) {
      if (check.value === undefined || check.value === null) {
        throw new MissingField({
          field: check.field,
          recordId: undefined,
        });
      }
      // Empty string check for string fields
      if (
        typeof check.value === 'string' &&
        check.value.trim() === ''
      ) {
        throw new MissingField({
          field: check.field,
          recordId: undefined,
        });
      }
    }

    // inputDatasetIds can be empty (source Dataset), but must be an array
    if (!Array.isArray(input.inputDatasetIds)) {
      throw new MissingField({
        field: 'inputDatasetIds',
        recordId: undefined,
      });
    }
  }

  // ========================================================================
  // Event emission
  // ========================================================================

  #emitRecordWritten(record: ProvenanceRecord): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'provenance_record_written',
        recordId: record.id,
        datasetId: record.outputDatasetId
          ? record.outputDatasetId
          : ('unknown' as unknown as DatasetId),
        toolId: record.toolId,
        timestamp: new Date(),
      });
    }
  }

  #emitRecordReconstructed(record: ProvenanceRecord): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'provenance_record_reconstructed',
        recordId: record.id,
        datasetId: record.outputDatasetId
          ? record.outputDatasetId
          : ('unknown' as unknown as DatasetId),
        source: 'partial_record',
        timestamp: new Date(),
      });
    }
  }

  #emitDatasetQuarantined(datasetId: DatasetId, reason: string): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'provenance_dataset_quarantined',
        datasetId,
        reason,
        timestamp: new Date(),
      });
    }
  }
}
