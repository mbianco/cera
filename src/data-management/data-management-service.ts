/**
 * DataManagementService implementation (C3 — Data Management).
 *
 * Dataset lifecycle management: registration, querying, Location
 * validation, marking consumable (after Provenance verification),
 * and quarantine.
 *
 * Invariants enforced:
 * - INV-D1 (immutability): `registerDataset()` returns a frozen
 *   Dataset. `markConsumable()` and `quarantineDataset()` create new
 *   frozen Datasets and replace the old one in the registry — the
 *   original is never modified in place.
 * - INV-D2 (one Format, one Grid): `registerDataset()` validates
 *   format and grid are non-null. These are `readonly` on the
 *   `Dataset` type (enforced by the type system).
 * - INV-D3 (Provenance before consumption): `markConsumable()` calls
 *   `provenance.verifyProvenance(datasetId)` and throws
 *   `ProvenanceMissing` if it returns false. This is the joint
 *   enforcement point with C6 (INV-P3).
 * - INV-D4 (Location resolves before use): `validateLocation()`
 *   checks the path exists and is readable (read mode) or writable
 *   (write mode) at the time of use.
 *
 * Failure modes handled:
 * - FM-D1: Quota exceeded — `DataQuotaExceeded` (via LocationValidator).
 * - FM-D2: Slow filesystem — `LocationNotReadable`/`LocationNotWritable`
 *   with `cause: 'slow'` (via LocationValidator).
 * - FM-D3: File not found / permission denied —
 *   `LocationNotReadable`/`LocationNotWritable` with
 *   `cause: 'enoent' | 'eacces'` (via LocationValidator).
 * - FM-D5: Corrupted ZARR store — `quarantineDataset()` with a
 *   corruption reason.
 *
 * Events produced: `DatasetEvent.registered`,
 * `DatasetEvent.consumable`, `DatasetEvent.quarantined`,
 * `DatasetEvent.location_invalid`.
 *
 * Spec: api-contracts.md §5; module-graph.md §5; invariants.md
 * INV-D1–D4; failure-modes.md FM-D1–D5; resolutions.md R11.
 */

import type { FilesystemGateway } from '../dsh-adapter/types';
import type { ProvenanceService } from '../provenance/types';
import type {
  Dataset,
  DatasetEvent,
  DatasetId,
  Location,
} from '../types';
import {
  LocationNotReadable,
  LocationNotWritable,
  ProvenanceMissing,
} from '../types/errors';
import type {
  DataManagementConfig,
  DataManagementService,
  DatasetFilter,
  RegisterDatasetInput,
} from './types';
import { DatasetRegistry } from './dataset-registry';
import { LocationValidator } from './location-validator';

// ============================================================================
// DataManagementServiceImplProps
// ============================================================================

/**
 * Constructor parameters for DataManagementServiceImpl.
 *
 * `filesystem` — the dsh-adapter FilesystemGateway for filesystem
 *   access and Location validation (INV-D4).
 * `provenance` — the Phase 2 ProvenanceService for verifying
 *   Provenance before marking a Dataset as consumable (INV-D3).
 * `config` — optional configuration overrides.
 * `onEvent` — optional callback for DatasetEvent emission.
 *
 * Spec: api-contracts.md §5; module-graph.md §5.
 */
export interface DataManagementServiceImplProps {
  readonly filesystem: FilesystemGateway;
  readonly provenance: ProvenanceService;
  readonly config?: Partial<DataManagementConfig>;
  readonly onEvent?: (event: DatasetEvent) => void;
}

// ============================================================================
// ID generation
// ============================================================================

/**
 * Generates a unique DatasetId.
 *
 * Format: `ds-<timestamp>-<random>` where timestamp is the current
 * time in milliseconds and random is a short random string. This
 * ensures uniqueness without requiring a centralized ID generator.
 *
 * Exported so that ToolInvocationServiceImpl can pre-generate an ID
 * and write the ProvenanceRecord before registering the Dataset
 * (FINDING-I1 fix).
 */
export function generateDatasetId(): DatasetId {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  return `ds-${timestamp}-${random}` as DatasetId;
}

// ============================================================================
// DataManagementServiceImpl
// ============================================================================

/**
 * Dataset lifecycle management service.
 *
 * INV-D1: Datasets are immutable. `registerDataset()` returns a
 *   frozen Dataset. `markConsumable()` and `quarantineDataset()`
 *   create new frozen Datasets and replace the old one in the
 *   registry.
 * INV-D2: One Format, one Grid per Dataset. These are `readonly`
 *   on the `Dataset` type and validated at registration.
 * INV-D3: Provenance before consumption. `markConsumable()` calls
 *   `provenance.verifyProvenance()` and throws `ProvenanceMissing`
 *   if it returns false. Joint enforcement with C6 (INV-P3).
 * INV-D4: Location resolves before use. `validateLocation()` checks
 *   the path exists and is readable (read) or writable (write).
 *
 * Spec: api-contracts.md §5; invariants.md INV-D1–D4;
 * failure-modes.md FM-D1–D5; resolutions.md R11.
 */
export class DataManagementServiceImpl implements DataManagementService {
  #registry: DatasetRegistry;
  #locationValidator: LocationValidator;
  #provenance: ProvenanceService;
  #onEvent?: (event: DatasetEvent) => void;

  constructor(props: DataManagementServiceImplProps) {
    this.#registry = new DatasetRegistry();
    this.#locationValidator = new LocationValidator({
      filesystem: props.filesystem,
      config: props.config,
    });
    this.#provenance = props.provenance;
    this.#onEvent = props.onEvent;
  }

  // ========================================================================
  // registerDataset (INV-D1, INV-D2, INV-D4)
  // ========================================================================

  /**
   * Registers a new Dataset with its Format, Grid, Variables, and
   * Location. The Dataset is created in a "pending" state — it is
   * NOT consumable until `markConsumable()` is called (which
   * requires a ProvenanceRecord, per INV-D3).
   *
   * INV-D1: The returned Dataset is frozen (`Object.freeze`).
   * INV-D2: Format and Grid are validated as non-null and stored as
   *   readonly fields.
   * INV-D4: The Location is validated in 'read' mode before
   *   registration — the Dataset's file/store must already exist and
   *   be readable.
   *
   * @throws {LocationNotReadable} if the Location does not resolve
   *   to a valid, readable path (INV-D4, FM-D3).
   */
  async registerDataset(input: RegisterDatasetInput): Promise<Dataset> {
    // INV-D4: Validate Location is readable before registering
    await this.validateLocation(input.location, 'read');

    // FINDING-I1: Use provided ID if given (for Provenance-before-
    // Dataset ordering), otherwise generate one.
    const id = input.id ?? generateDatasetId();

    // Check for duplicate ID
    if (this.#registry.has(id)) {
      throw new Error(`Dataset with ID '${id as string}' already exists.`);
    }

    // Create the new Dataset (INV-D1 — frozen, new identity)
    const dataset: Dataset = Object.freeze({
      id,
      name: input.name,
      location: input.location,
      format: input.format,
      grid: input.grid,
      variables: input.variables,
      producerToolInvocationId: input.producerToolInvocationId ?? null,
      consumable: false, // INV-D3 — pending state
      quarantined: false,
      createdAt: new Date(),
    });

    // Store in registry
    this.#registry.register(dataset);

    // Emit event
    this.#emitRegistered(dataset);

    return dataset;
  }

  // ========================================================================
  // queryDataset
  // ========================================================================

  /**
   * Queries a Dataset by identity. Returns null if the Dataset
   * does not exist.
   */
  async queryDataset(id: DatasetId): Promise<Dataset | null> {
    return this.#registry.get(id);
  }

  // ========================================================================
  // listDatasets
  // ========================================================================

  /**
   * Lists Datasets, optionally filtered. Returns all Datasets that
   * match all specified filter fields (AND semantics).
   *
   * Spec: api-contracts.md §5 (DatasetFilter).
   */
  async listDatasets(filter?: DatasetFilter): Promise<Dataset[]> {
    return this.#registry.list(filter);
  }

  // ========================================================================
  // validateLocation (INV-D4)
  // ========================================================================

  /**
   * Validates that a Location resolves to an existing, readable
   * path (for inputs) or a writable path (for outputs) at the time
   * of use (INV-D4). Called immediately before a ToolInvocation
   * reads or writes.
   *
   * On failure (LocationNotReadable or LocationNotWritable), a
   * `dataset_location_invalid` event is emitted before re-throwing.
   *
   * @returns true if the Location is valid for the given mode.
   * @throws {LocationNotReadable} if read mode and the path does not
   *   exist or is not readable (FM-D3), or if operations are slow
   *   (FM-D2).
   * @throws {LocationNotWritable} if write mode and the path is not
   *   writable (FM-D3), or if operations are slow (FM-D2).
   * @throws {DataQuotaExceeded} if the filesystem reports quota
   *   exceeded (FM-D1).
   */
  async validateLocation(
    location: Location,
    mode: 'read' | 'write',
  ): Promise<boolean> {
    try {
      return await this.#locationValidator.validate(location, mode);
    } catch (error) {
      // Emit location_invalid event for LocationNotReadable and
      // LocationNotWritable (not for DataQuotaExceeded — it's a
      // different failure mode with a different event shape).
      if (
        error instanceof LocationNotReadable ||
        error instanceof LocationNotWritable
      ) {
        this.#emitLocationInvalid(
          location.path,
          error.cause,
        );
      }
      throw error;
    }
  }

  // ========================================================================
  // markConsumable (INV-D3 / INV-P3 — joint enforcement with C6)
  // ========================================================================

  /**
   * Marks a Dataset as available for downstream consumption. This is
   * the joint enforcement point for INV-D3 / INV-P3: the method
   * calls `provenance.verifyProvenance(datasetId)` and only proceeds
   * if it returns true.
   *
   * INV-D1: The Dataset is not modified in place. A new frozen
   * Dataset with `consumable: true` is created and replaces the old
   * one in the registry.
   *
   * @throws {ProvenanceMissing} if `verifyProvenance()` returns
   *   false (INV-D3, FM-P3).
   * @throws {Error} if the Dataset does not exist.
   * @throws {Error} if the Dataset is already quarantined (a
   *   quarantined Dataset is not available for downstream
   *   consumption, even if it was previously consumable).
   */
  async markConsumable(datasetId: DatasetId): Promise<void> {
    const existing = this.#registry.get(datasetId);
    if (existing === null) {
      throw new Error(
        `Cannot mark Dataset ${datasetId as string} as consumable — not registered`,
      );
    }

    // A quarantined Dataset is not available for downstream
    // consumption, even if it was previously consumable.
    if (existing.quarantined) {
      throw new Error(
        `Cannot mark Dataset ${datasetId as string} as consumable — it is quarantined: ${existing.quarantineReason ?? 'unknown reason'}`,
      );
    }

    // Already consumable — no-op
    if (existing.consumable) {
      return;
    }

    // INV-D3 / INV-P3: Call provenance.verifyProvenance() before
    // marking the Dataset as consumable. This is the joint
    // enforcement point with C6.
    const verified = await this.#provenance.verifyProvenance(datasetId);

    if (!verified) {
      throw new ProvenanceMissing({ datasetId });
    }

    // Query the ProvenanceRecord to get its ID for the event
    const record = await this.#provenance.queryProvenanceRecord(datasetId);
    const provenanceRecordId = record?.id ?? ('pr-unknown' as never);

    // INV-D1: Create a new frozen Dataset (do not modify in place)
    const updated: Dataset = Object.freeze({
      ...existing,
      consumable: true,
    });

    this.#registry.replace(updated);

    // Emit event
    this.#emitConsumable(datasetId, provenanceRecordId);
  }

  // ========================================================================
  // quarantineDataset (R11 — local, not systemic)
  // ========================================================================

  /**
   * Quarantines a Dataset. The Dataset is not available for
   * downstream consumption. Used for corrupted Datasets (FM-D5),
   * corrupted ProvenanceRecords (FM-P2, R11), and Datasets with
   * mismatched Provenance (FM-X5).
   *
   * INV-D1: The Dataset is not modified in place. A new frozen
   * Dataset with `quarantined: true`, `quarantineReason` set, and
   * `consumable: false` is created and replaces the old one in the
   * registry. A previously consumable Dataset that is quarantined
   * is no longer available for downstream consumption.
   *
   * R11: Quarantining one Dataset does not affect others. Other
   * Datasets with valid ProvenanceRecords remain available.
   *
   * @throws {Error} if the Dataset does not exist.
   */
  async quarantineDataset(
    datasetId: DatasetId,
    reason: string,
  ): Promise<void> {
    const existing = this.#registry.get(datasetId);
    if (existing === null) {
      throw new Error(
        `Cannot quarantine Dataset ${datasetId as string} — not registered`,
      );
    }

    // INV-D1: Create a new frozen Dataset (do not modify in place)
    const updated: Dataset = Object.freeze({
      ...existing,
      quarantined: true,
      quarantineReason: reason,
      consumable: false, // quarantined Datasets are not consumable
    });

    this.#registry.replace(updated);

    // Emit event
    this.#emitQuarantined(datasetId, reason);
  }

  // ========================================================================
  // Private: event emission
  // ========================================================================

  #emitRegistered(dataset: Dataset): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'dataset_registered',
        datasetId: dataset.id,
        name: dataset.name,
        format: dataset.format,
        gridKind: dataset.grid.kind,
        producerToolInvocationId: dataset.producerToolInvocationId,
        timestamp: new Date(),
      });
    }
  }

  #emitConsumable(
    datasetId: DatasetId,
    provenanceRecordId: import('../types').ProvenanceRecordId,
  ): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'dataset_consumable',
        datasetId,
        provenanceRecordId,
        timestamp: new Date(),
      });
    }
  }

  #emitQuarantined(datasetId: DatasetId, reason: string): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'dataset_quarantined',
        datasetId,
        reason,
        timestamp: new Date(),
      });
    }
  }

  #emitLocationInvalid(
    path: string,
    cause: 'enoent' | 'eacces' | 'slow',
  ): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'dataset_location_invalid',
        datasetId: 'unknown' as DatasetId,
        path,
        cause,
        timestamp: new Date(),
      });
    }
  }
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { DataManagementConfig, DatasetFilter, RegisterDatasetInput } from './types';
export { DEFAULT_DATA_MANAGEMENT_CONFIG } from './types';
export { DatasetRegistry } from './dataset-registry';
export { LocationValidator } from './location-validator';
export type { LocationValidatorProps } from './location-validator';
