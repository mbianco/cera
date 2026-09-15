/**
 * Public types for the data-management module (C3).
 *
 * Datasets are immutable (INV-D1), have one Format and one Grid
 * (INV-D2), and are not consumable until their ProvenanceRecord
 * exists (INV-D3, jointly enforced with provenance from Phase 2).
 * A Dataset's Location must resolve before use (INV-D4).
 *
 * Spec references: api-contracts.md §5; module-graph.md §5;
 * invariants.md INV-D1–D4; failure-modes.md FM-D1–D5;
 * resolutions.md R11.
 */

import type {
  Dataset,
  DatasetId,
  Format,
  Grid,
  Location,
  ToolInvocationId,
  Variable,
} from '../types';

// ============================================================================
// RegisterDatasetInput
// ============================================================================

/**
 * Input for registering a new Dataset. The Dataset is created in a
 * "pending" state — it is NOT consumable until `markConsumable()` is
 * called (which requires a ProvenanceRecord, per INV-D3).
 *
 * `producerToolInvocationId` is null for manually registered Datasets
 * (e.g., a User provides an existing NetCDF file).
 *
 * Spec: api-contracts.md §5 (RegisterDatasetInput); invariants.md
 * INV-D1, INV-D2.
 */
export interface RegisterDatasetInput {
  readonly name: string;
  readonly location: Location;
  readonly format: Format;
  readonly grid: Grid;
  readonly variables: readonly Variable[];
  readonly producerToolInvocationId?: ToolInvocationId;
}

// ============================================================================
// DatasetFilter
// ============================================================================

/**
 * Optional filter for `listDatasets()`. All specified fields must
 * match (AND semantics). Unspecified fields are not filtered.
 *
 * `grid` matching uses deep equality on the Grid tagged union.
 * `variableName` matches if any Variable in the Dataset has the
 * given name.
 *
 * Spec: api-contracts.md §5 (DatasetFilter).
 */
export interface DatasetFilter {
  readonly format?: Format;
  readonly grid?: Grid;
  readonly variableName?: string;
  readonly producerToolInvocationId?: ToolInvocationId;
}

// ============================================================================
// DataManagementConfig
// ============================================================================

/**
 * Configuration for the data-management module.
 *
 * `slowThresholdMs` — filesystem operations exceeding this duration
 * are treated as slow (FM-D2) and `LocationNotReadable` or
 * `LocationNotWritable` with `cause: 'slow'` is thrown.
 *
 * `quotaChecker` — optional function that returns true if the
 * filesystem at `path` has exceeded its quota (FM-D1). When provided,
 * `validateLocation(location, 'write')` calls it before returning
 * success. If not provided, quota is not checked proactively (the
 * actual write will fail naturally if quota is exceeded).
 *
 * Spec: failure-modes.md FM-D1, FM-D2; invariants.md INV-D4.
 */
export interface DataManagementConfig {
  /** Slow filesystem threshold in milliseconds. Default: 10_000. */
  readonly slowThresholdMs: number;
  /**
   * Optional quota checker for FM-D1. Returns true if quota is
   * exceeded at the given path on the named filesystem.
   */
  readonly quotaChecker?: (path: string, filesystem: string) => Promise<boolean>;
}

/**
 * Default data-management configuration.
 *
 * Slow threshold: 10 seconds (generous for HPC parallel filesystems,
 * per FM-D2: "Timeout thresholds must be generous for HPC
 * filesystems"). Quota checker: none (not checked proactively).
 */
export const DEFAULT_DATA_MANAGEMENT_CONFIG: DataManagementConfig = {
  slowThresholdMs: 10_000,
};

// ============================================================================
// DataManagementService interface
// ============================================================================

/**
 * Dataset lifecycle management. Datasets are immutable (INV-D1),
 * have one Format and one Grid (INV-D2), and are not consumable
 * until their ProvenanceRecord exists (INV-D3).
 *
 * The service uses `dsh-adapter.FilesystemGateway` for filesystem
 * access and `provenance.ProvenanceService` for Provenance
 * verification before marking a Dataset as consumable (the joint
 * enforcement point for INV-D3 / INV-P3).
 *
 * Events produced: `DatasetEvent.registered`,
 * `DatasetEvent.consumable`, `DatasetEvent.quarantined`,
 * `DatasetEvent.location_invalid`.
 *
 * Spec: api-contracts.md §5; module-graph.md §5; invariants.md
 * INV-D1–D4; failure-modes.md FM-D1–D5; resolutions.md R11.
 */
export interface DataManagementService {
  /**
   * Registers a new Dataset with its Format, Grid, Variables, and
   * Location. The Dataset is created in a "pending" state — it is
   * NOT consumable until `markConsumable()` is called (which
   * requires a ProvenanceRecord, per INV-D3).
   *
   * The returned Dataset is frozen (Object.freeze) — INV-D1.
   *
   * @throws {import('../types').DataError & { kind: 'location_not_readable' }}
   *   if the Location does not resolve to a valid, readable path
   *   (INV-D4, FM-D3). NOTE: api-contracts.md names this
   *   `LocationNotResolved` but that error class does not exist;
   *   `LocationNotReadable` is used instead. See
   *   specs/escalations/004-registerdataset-locationnotresolved-spec-gap.md.
   */
  registerDataset(input: RegisterDatasetInput): Promise<Dataset>;

  /**
   * Queries a Dataset by identity. Returns null if the Dataset
   * does not exist.
   */
  queryDataset(id: DatasetId): Promise<Dataset | null>;

  /**
   * Lists Datasets, optionally filtered. Returns all Datasets that
   * match all specified filter fields (AND semantics).
   */
  listDatasets(filter?: DatasetFilter): Promise<Dataset[]>;

  /**
   * Validates that a Location resolves to an existing, readable
   * path (for inputs) or a writable path (for outputs) at the time
   * of use (INV-D4). Called immediately before a ToolInvocation
   * reads or writes.
   *
   * For read mode: checks the path exists and is readable.
   * For write mode: checks the path is writable, or its parent
   * directory is writable for new files.
   *
   * @returns true if the Location is valid for the given mode.
   * @throws {import('../types').DataError & { kind: 'location_not_readable' }}
   *   if read mode and path does not exist or is not readable (FM-D3).
   * @throws {import('../types').DataError & { kind: 'location_not_writable' }}
   *   if write mode and path is not writable.
   * @throws {import('../types').DataError & { kind: 'data_quota_exceeded' }}
   *   if the filesystem reports quota exceeded (FM-D1).
   */
  validateLocation(location: Location, mode: 'read' | 'write'): Promise<boolean>;

  /**
   * Marks a Dataset as available for downstream consumption. This is
   * the joint enforcement point for INV-D3 / INV-P3: the method
   * calls `provenance.verifyProvenance(datasetId)` and only proceeds
   * if it returns true.
   *
   * The Dataset is not modified in place (INV-D1). Instead, a new
   * frozen Dataset with `consumable: true` replaces the old one in
   * the registry.
   *
   * @throws {import('../types').DataError & { kind: 'provenance_missing' }}
   *   if no ProvenanceRecord exists for the Dataset (INV-D3, FM-P3).
   */
  markConsumable(datasetId: DatasetId): Promise<void>;

  /**
   * Quarantines a Dataset. The Dataset is not available for
   * downstream consumption. Used for corrupted Datasets (FM-D5),
   * corrupted ProvenanceRecords (FM-P2, R11), and Datasets with
   * mismatched Provenance (FM-X5).
   *
   * The Dataset is not modified in place (INV-D1). Instead, a new
   * frozen Dataset with `quarantined: true` and `quarantineReason`
   * set replaces the old one in the registry. A previously
   * consumable Dataset that is quarantined is no longer available
   * for downstream consumption.
   */
  quarantineDataset(datasetId: DatasetId, reason: string): Promise<void>;
}

// ============================================================================
// Branded ID helper (internal to this module)
// ============================================================================

/**
 * Creates a DatasetId from a string. Uses a type assertion because
 * the brand symbol is private to value-objects.ts.
 */
export function createDatasetIdInternal(id: string): DatasetId {
  return id as DatasetId;
}
