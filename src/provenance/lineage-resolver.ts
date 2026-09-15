/**
 * Lineage resolver — recursive lineage traversal for ProvenanceRecords.
 *
 * Traces back through input Dataset IDs recursively: for each input
 * Dataset, query its ProvenanceRecord, then follow its inputs, until
 * no more records are found (a source Dataset with no inputs, or a
 * Dataset whose record is missing).
 *
 * Cycle detection: if a Dataset ID is encountered more than once
 * during traversal, the cycle is broken (the second occurrence is
 * not followed). This prevents infinite loops in corrupted or
 * circular lineage graphs.
 *
 * Spec: api-contracts.md §4 (queryLineage); ADR-009; invariants.md
 * INV-P4 (cross-session lineage).
 */

import type {
  DatasetId,
  ProvenanceRecord,
} from '../types';

// ============================================================================
// Record lookup function type
// ============================================================================

/**
 * A function that looks up a ProvenanceRecord by Dataset ID.
 * Returns null if no record exists.
 *
 * This abstraction allows the LineageResolver to work with any
 * backing store (filesystem, in-memory, mock).
 */
export type RecordLookupFn = (
  datasetId: DatasetId,
) => Promise<ProvenanceRecord | null>;

// ============================================================================
// LineageResolver
// ============================================================================

/**
 * Resolves the full lineage chain for a Dataset by recursively
 * following input Dataset IDs through ProvenanceRecords.
 *
 * The lineage is ordered from the most recent record (the
 * ProvenanceRecord for the queried Dataset) back to the original
 * source Datasets.
 *
 * Cycle detection prevents infinite traversal if the lineage graph
 * contains cycles (corrupted or circular data).
 *
 * Spec: api-contracts.md §4; ADR-009; invariants.md INV-P4.
 */
export class LineageResolver {
  #lookup: RecordLookupFn;

  constructor(lookup: RecordLookupFn) {
    this.#lookup = lookup;
  }

  /**
   * Resolves the full lineage chain for a Dataset.
   *
   * The traversal starts at `datasetId`'s ProvenanceRecord (if it
   * exists), then follows each `inputDatasetId` recursively.
   *
   * Records are ordered from the queried Dataset's record first,
   * then each ancestor's record in depth-first order.
   *
   * If a Dataset has no ProvenanceRecord (a source Dataset), the
   * traversal stops at that branch. If a cycle is detected (a
   * Dataset ID already visited), the traversal stops at that branch.
   *
   * @returns Array of ProvenanceRecords, ordered from the queried
   *   Dataset's record to the original source records. Returns an
   *   empty array if no record exists for `datasetId`.
   */
  async resolve(datasetId: DatasetId): Promise<ProvenanceRecord[]> {
    const visited = new Set<string>();
    const records: ProvenanceRecord[] = [];
    await this.#resolveRecursive(datasetId, visited, records);
    return records;
  }

  /**
   * Recursive helper for lineage resolution.
   *
   * @param datasetId The Dataset ID to resolve.
   * @param visited Set of Dataset IDs already visited (cycle
   *   detection).
   * @param records Accumulator for resolved records.
   */
  async #resolveRecursive(
    datasetId: DatasetId,
    visited: Set<string>,
    records: ProvenanceRecord[],
  ): Promise<void> {
    const idStr = datasetId as string;

    // Cycle detection: if we've already visited this Dataset,
    // stop traversing this branch.
    if (visited.has(idStr)) {
      return;
    }
    visited.add(idStr);

    // Look up the ProvenanceRecord for this Dataset.
    const record = await this.#lookup(datasetId);
    if (record === null) {
      // No record exists — this is a source Dataset or a
      // missing record. Stop traversing this branch.
      return;
    }

    // Add the record to the lineage.
    records.push(record);

    // Recursively follow input Datasets.
    for (const inputId of record.inputDatasetIds) {
      await this.#resolveRecursive(inputId, visited, records);
    }
  }
}
