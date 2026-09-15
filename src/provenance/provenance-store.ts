/**
 * Low-level Provenance store — filesystem read/write/parse of
 * ProvenanceRecords.
 *
 * The store is a directory of JSON files (ADR-009): one file per
 * ProvenanceRecord at `<storePath>/<record-id>.json`. Quarantined
 * Datasets are tracked at `<storePath>/quarantine/<dataset-id>.json`.
 *
 * Immutability (INV-P1) is enforced by:
 * (a) The write function never overwrites existing files — it
 *     checks if a file with the same ID already exists and refuses
 *     to overwrite.
 * (b) The returned ProvenanceRecord is a frozen object
 *     (Object.freeze).
 * (c) The store has no update method — corrections create a new
 *     record linked to the original via a "corrects" relationship.
 *
 * Corruption detection (FM-P2):
 * - On read, if the JSON is unparseable, `RecordCorrupted` is
 *   thrown with `corruptionType: 'unparseable_json'`.
 * - On read, if the JSON is parseable but missing required fields
 *   (INV-P2), `RecordCorrupted` is thrown with
 *   `corruptionType: 'missing_fields'`.
 *
 * Spec: ADR-009; invariants.md INV-P1, INV-P2; failure-modes.md
 * FM-P1, FM-P2; resolutions.md R11.
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
  ProvenanceRecord,
  ToolId,
} from '../types';
import {
  RecordCorrupted,
} from '../types/errors';
import {
  createProvenanceRecordId,
} from './types';

// ============================================================================
// JSON serialization types
// ============================================================================

/**
 * The JSON representation of a ProvenanceRecord, as stored on disk.
 * Dates are serialized as ISO 8601 strings.
 */
interface ProvenanceRecordJson {
  readonly id: string;
  readonly toolId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly parameters: Record<string, unknown>;
  readonly environmentId: string;
  readonly environmentDescription: string;
  readonly inputDatasetIds: readonly string[];
  readonly outputDatasetId: string | null;
  readonly exitOutcome: ExitOutcome;
  readonly timestamp: string; // ISO 8601
  readonly jobId?: number;
  readonly jobState?: JobState;
  readonly caseId?: string;
  readonly correctsRecordId?: string;
  readonly warningFlag?: boolean;
  readonly defective?: boolean;
}

/**
 * Quarantine file structure: `<storePath>/quarantine/<dataset-id>.json`.
 */
export interface QuarantineEntry {
  readonly datasetId: string;
  readonly reason: string;
  readonly timestamp: string; // ISO 8601
}

// ============================================================================
// Required fields for INV-P2 validation
// ============================================================================

/**
 * The fields that must be non-null in a ProvenanceRecord per INV-P2.
 * `outputDatasetId` is allowed to be null for failed invocations.
 */
const REQUIRED_STRING_FIELDS: readonly string[] = [
  'id',
  'toolId',
  'toolName',
  'toolVersion',
  'parameters',
  'environmentId',
  'environmentDescription',
  'inputDatasetIds',
  'timestamp',
  'exitOutcome',
] as const;

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serializes a ProvenanceRecord to a JSON string for storage.
 *
 * Dates are converted to ISO 8601 strings. Branded IDs are converted
 * to plain strings (the brand is compile-time only).
 */
export function serializeProvenanceRecord(record: ProvenanceRecord): string {
  const json: ProvenanceRecordJson = {
    id: record.id as string,
    toolId: record.toolId as string,
    toolName: record.toolName,
    toolVersion: record.toolVersion,
    parameters: record.parameters,
    environmentId: record.environmentId as string,
    environmentDescription: record.environmentDescription,
    inputDatasetIds: record.inputDatasetIds.map((id) => id as string),
    outputDatasetId: record.outputDatasetId ? (record.outputDatasetId as string) : null,
    exitOutcome: record.exitOutcome,
    timestamp: record.timestamp.toISOString(),
    jobId: record.jobId ? (record.jobId as number) : undefined,
    jobState: record.jobState,
    caseId: record.caseId ? (record.caseId as string) : undefined,
    correctsRecordId: record.correctsRecordId
      ? (record.correctsRecordId as string)
      : undefined,
    warningFlag: record.warningFlag,
    defective: record.defective,
  };
  return JSON.stringify(json, null, 2);
}

// ============================================================================
// Deserialization
// ============================================================================

/**
 * Validates that a parsed JSON object has all required non-null
 * fields per INV-P2.
 *
 * @returns An array of missing field names (empty if all present).
 */
export function findMissingFields(
  obj: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = obj[field];
    if (value === undefined || value === null) {
      missing.push(field);
      continue;
    }
    // Empty string is considered missing for string fields
    if (typeof value === 'string' && value.trim() === '') {
      if (field !== 'outputDatasetId') {
        missing.push(field);
      }
    }
    // Empty array is considered missing for array fields
    if (Array.isArray(value) && value.length === 0) {
      // inputDatasetIds can be empty (e.g., a source Dataset with no inputs)
      // — only flag if the field is truly undefined/null
    }
  }
  return missing;
}

/**
 * Deserializes a JSON string into a ProvenanceRecord.
 *
 * @throws {RecordCorrupted} if the JSON is unparseable
 *   (`corruptionType: 'unparseable_json'`) or missing required
 *   fields (`corruptionType: 'missing_fields'`).
 *
 * Spec: invariants.md INV-P1, INV-P2; failure-modes.md FM-P2;
 * ADR-009.
 */
export function deserializeProvenanceRecord(
  jsonStr: string,
  recordId: string,
): ProvenanceRecord {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    throw new RecordCorrupted({
      datasetId: recordId as unknown as DatasetId,
      corruptionType: 'unparseable_json',
    });
  }

  const missing = findMissingFields(parsed);
  if (missing.length > 0) {
    throw new RecordCorrupted({
      datasetId: (parsed['outputDatasetId'] ?? recordId) as unknown as DatasetId,
      corruptionType: `missing_fields: ${missing.join(', ')}`,
    });
  }

  // Reconstruct the ProvenanceRecord with proper types
  const record: ProvenanceRecord = {
    id: createProvenanceRecordId(parsed['id'] as string),
    toolId: parsed['toolId'] as ToolId,
    toolName: parsed['toolName'] as string,
    toolVersion: parsed['toolVersion'] as string,
    parameters: parsed['parameters'] as Record<string, unknown>,
    environmentId: parsed['environmentId'] as EnvironmentId,
    environmentDescription: parsed['environmentDescription'] as string,
    inputDatasetIds: (parsed['inputDatasetIds'] as readonly string[]).map(
      (id) => id as DatasetId,
    ),
    outputDatasetId: parsed['outputDatasetId']
      ? (parsed['outputDatasetId'] as DatasetId)
      : null,
    exitOutcome: parsed['exitOutcome'] as ExitOutcome,
    timestamp: new Date(parsed['timestamp'] as string),
    jobId: parsed['jobId'] ? (parsed['jobId'] as JobId) : undefined,
    jobState: parsed['jobState'] as JobState | undefined,
    caseId: parsed['caseId'] ? (parsed['caseId'] as CaseId) : undefined,
    correctsRecordId: parsed['correctsRecordId']
      ? createProvenanceRecordId(parsed['correctsRecordId'] as string)
      : undefined,
    warningFlag: parsed['warningFlag'] as boolean | undefined,
    defective: parsed['defective'] as boolean | undefined,
  };

  return Object.freeze(record);
}

// ============================================================================
// ProvenanceStore
// ============================================================================

/**
 * Constructor parameters for ProvenanceStore.
 */
export interface ProvenanceStoreProps {
  readonly filesystem: FilesystemGateway;
  readonly storePath: string;
}

/**
 * Low-level filesystem store for ProvenanceRecords.
 *
 * Each record is a separate JSON file at
 * `<storePath>/<record-id>.json`. The store is append-only:
 * existing files are never overwritten (INV-P1).
 *
 * Quarantine entries are stored at
 * `<storePath>/quarantine/<dataset-id>.json`.
 *
 * Spec: ADR-009; invariants.md INV-P1, INV-P4; failure-modes.md
 * FM-P1, FM-P2.
 */
export class ProvenanceStore {
  #filesystem: FilesystemGateway;
  #storePath: string;

  constructor(props: ProvenanceStoreProps) {
    this.#filesystem = props.filesystem;
    this.#storePath = props.storePath;
  }

  /**
   * Returns the file path for a ProvenanceRecord.
   */
  #recordPath(recordId: string): string {
    return `${this.#storePath}/${recordId}.json`;
  }

  /**
   * Returns the quarantine file path for a Dataset.
   */
  #quarantinePath(datasetId: string): string {
    return `${this.#storePath}/quarantine/${datasetId}.json`;
  }

  /**
   * Ensures the store directory exists. Creates it recursively
   * if needed.
   */
  async #ensureStoreDir(): Promise<void> {
    const exists = await this.#filesystem.exists(this.#storePath);
    if (!exists) {
      await this.#filesystem.mkdir(this.#storePath, true);
    }
  }

  /**
   * Ensures the quarantine directory exists.
   */
  async #ensureQuarantineDir(): Promise<void> {
    const quarantineDir = `${this.#storePath}/quarantine`;
    const exists = await this.#filesystem.exists(quarantineDir);
    if (!exists) {
      await this.#filesystem.mkdir(quarantineDir, true);
    }
  }

  /**
   * Writes a ProvenanceRecord to the filesystem as a JSON file.
   *
   * INV-P1: If a file with the same ID already exists, the write
   * is refused (the record is immutable). Returns false to
   * indicate the file already existed.
   *
   * @returns true if the record was written, false if a file with
   *   the same ID already existed (INV-P1).
   * @throws {Error} if the filesystem write fails.
   */
  async writeRecord(record: ProvenanceRecord): Promise<boolean> {
    await this.#ensureStoreDir();
    const path = this.#recordPath(record.id as string);

    // INV-P1: never overwrite existing files
    const exists = await this.#filesystem.exists(path);
    if (exists) {
      return false;
    }

    const data = Buffer.from(serializeProvenanceRecord(record), 'utf-8');
    await this.#filesystem.writeFile(path, data);
    return true;
  }

  /**
   * Reads a ProvenanceRecord from the filesystem by record ID.
   *
   * @returns The deserialized ProvenanceRecord (frozen), or null if
   *   no file exists.
   * @throws {RecordCorrupted} if the file exists but is corrupted
   *   (FM-P2).
   */
  async readRecord(recordId: string): Promise<ProvenanceRecord | null> {
    const path = this.#recordPath(recordId);
    const exists = await this.#filesystem.exists(path);
    if (!exists) {
      return null;
    }

    const data = await this.#filesystem.readFile(path);
    const jsonStr = data.toString('utf-8');
    return deserializeProvenanceRecord(jsonStr, recordId);
  }

  /**
   * Checks if a ProvenanceRecord file exists.
   */
  async recordExists(recordId: string): Promise<boolean> {
    return this.#filesystem.exists(this.#recordPath(recordId));
  }

  /**
   * Lists all ProvenanceRecord IDs in the store by scanning the
   * store directory for `.json` files (excluding the `quarantine`
   * subdirectory).
   *
   * This is a scan operation (ADR-009: no built-in indexing).
   * Used for lineage queries and Job-based lookups.
   */
  async listRecordIds(): Promise<string[]> {
    const exists = await this.#filesystem.exists(this.#storePath);
    if (!exists) {
      return [];
    }
    const entries = await this.#filesystem.readDir(this.#storePath);
    return entries
      .filter((e) => e.endsWith('.json'))
      .map((e) => e.replace(/\.json$/, ''));
  }

  /**
   * Reads all ProvenanceRecords in the store. Corrupted records
   * are skipped (not thrown) — the caller can detect missing
   * records via `listRecordIds()` vs. the returned array length.
   *
   * This is used for Dataset-based and Job-based lookups when no
   * index is available (ADR-009).
   */
  async readAllRecords(): Promise<ProvenanceRecord[]> {
    const ids = await this.listRecordIds();
    const records: ProvenanceRecord[] = [];
    for (const id of ids) {
      try {
        const record = await this.readRecord(id);
        if (record !== null) {
          records.push(record);
        }
      } catch {
        // Skip corrupted records (FM-P2 — local, not systemic)
      }
    }
    return records;
  }

  /**
   * Writes a quarantine entry for a Dataset.
   *
   * R11: Only the affected Dataset is quarantined. Other Datasets
   * with valid ProvenanceRecords remain available.
   *
   * @throws {Error} if the filesystem write fails.
   */
  async writeQuarantine(
    datasetId: string,
    reason: string,
    timestamp: Date = new Date(),
  ): Promise<void> {
    await this.#ensureQuarantineDir();
    const entry: QuarantineEntry = {
      datasetId,
      reason,
      timestamp: timestamp.toISOString(),
    };
    const path = this.#quarantinePath(datasetId);
    const data = Buffer.from(JSON.stringify(entry, null, 2), 'utf-8');
    await this.#filesystem.writeFile(path, data);
  }

  /**
   * Reads the quarantine entry for a Dataset, or null if not
   * quarantined.
   */
  async readQuarantine(
    datasetId: string,
  ): Promise<QuarantineEntry | null> {
    const path = this.#quarantinePath(datasetId);
    const exists = await this.#filesystem.exists(path);
    if (!exists) {
      return null;
    }
    const data = await this.#filesystem.readFile(path);
    return JSON.parse(data.toString('utf-8')) as QuarantineEntry;
  }

  /**
   * Checks if a Dataset is quarantined.
   */
  async isQuarantined(datasetId: string): Promise<boolean> {
    return this.#filesystem.exists(this.#quarantinePath(datasetId));
  }
}
