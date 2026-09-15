/**
 * Provenance module (C6).
 *
 * Writes immutable ProvenanceRecords to a filesystem store
 * (ADR-009), queries by Dataset or Job, resolves lineage
 * recursively, verifies Provenance before consumption (INV-P3),
 * attempts reconstruction of corrupted records (FM-P2), and
 * quarantines individual Datasets (R11: local, not systemic).
 *
 * Public surface:
 * - ProvenanceService interface and ProvenanceServiceImpl
 * - WriteProvenanceInput, ReconstructInput, ProvenanceConfig
 * - ProvenanceStore (low-level filesystem store)
 * - LineageResolver (recursive lineage traversal)
 * - serialize/deserialize functions for ProvenanceRecord JSON
 * - DEFAULT_PROVENANCE_CONFIG, createProvenanceRecordId
 *
 * Invariants enforced: INV-P1 (immutability), INV-P2 (full
 * reproducibility tuple), INV-P3 (Provenance before consumption),
 * INV-P4 (survives Session end).
 *
 * Failure modes handled: FM-P1 (WriteFailed with retry), FM-P2
 * (RecordCorrupted, local quarantine), FM-P3 (missing record).
 *
 * Spec: build-phases.md Phase 2; api-contracts.md §4;
 * module-graph.md §4; invariants.md INV-P1–P4;
 * failure-modes.md FM-P1–P3; resolutions.md R11; ADR-009.
 */

// Types
export type {
  ProvenanceService,
  WriteProvenanceInput,
  ReconstructInput,
  ProvenanceConfig,
} from './types';
export {
  DEFAULT_PROVENANCE_CONFIG,
  createProvenanceRecordId,
} from './types';

// Store (low-level filesystem operations)
export {
  ProvenanceStore,
  serializeProvenanceRecord,
  deserializeProvenanceRecord,
  findMissingFields,
} from './provenance-store';
export type {
  ProvenanceStoreProps,
  QuarantineEntry,
} from './provenance-store';

// Lineage resolver
export {
  LineageResolver,
} from './lineage-resolver';
export type {
  RecordLookupFn,
} from './lineage-resolver';

// Service implementation
export {
  ProvenanceServiceImpl,
} from './provenance-service';
export type {
  ProvenanceServiceImplProps,
} from './provenance-service';
