/**
 * data-management module (C3).
 *
 * Dataset lifecycle management — registration, querying, Location
 * validation, marking consumable (after Provenance verification),
 * and quarantine. Datasets are immutable (INV-D1), have one Format
 * and one Grid (INV-D2), and are not consumable until their
 * ProvenanceRecord exists (INV-D3, jointly enforced with provenance
 * from Phase 2).
 *
 * Public surface:
 * - DataManagementService interface and DataManagementServiceImpl
 * - RegisterDatasetInput, DatasetFilter, DataManagementConfig
 * - DatasetRegistry (in-memory Dataset registry)
 * - LocationValidator (Location validation logic)
 * - DEFAULT_DATA_MANAGEMENT_CONFIG, createDatasetIdInternal
 *
 * Invariants enforced: INV-D1 (immutability), INV-D2 (one Format,
 * one Grid), INV-D3 (Provenance before consumption), INV-D4
 * (Location resolves before use).
 *
 * Failure modes handled: FM-D1 (quota exceeded), FM-D2 (slow
 * filesystem), FM-D3 (file not found / permission denied),
 * FM-D5 (corrupted ZARR store).
 *
 * Spec: build-phases.md Phase 3; api-contracts.md §5;
 * module-graph.md §5; invariants.md INV-D1–D4;
 * failure-modes.md FM-D1–D5; resolutions.md R11.
 */

// Types
export type {
  RegisterDatasetInput,
  DatasetFilter,
  DataManagementConfig,
  DataManagementService,
} from './types';
export {
  DEFAULT_DATA_MANAGEMENT_CONFIG,
  createDatasetIdInternal,
} from './types';

// Registry
export {
  DatasetRegistry,
} from './dataset-registry';
export { formatsEqual } from './dataset-registry';

// Location validator
export {
  LocationValidator,
} from './location-validator';
export type { LocationValidatorProps } from './location-validator';

// Service implementation
export {
  DataManagementServiceImpl,
} from './data-management-service';
