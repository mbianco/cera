/**
 * In-memory Dataset registry (C3 — Data Management).
 *
 * Datasets are stored in a `Map<DatasetId, Dataset>`. The registry is
 * NOT persisted to disk in Phase 3 — it is per-Service-instance.
 * Persistence is the integrator's concern.
 *
 * INV-D1 (immutability): The registry never mutates an existing
 * Dataset. `register()` stores a new Dataset; `replace()` creates a
 * new entry with the same ID (for quarantine / consumable state
 * changes). Datasets are expected to be frozen (`Object.freeze`) by
 * the caller — the registry does not freeze them itself, but it
 * never opens a write path to an existing Dataset.
 *
 * Spec: build-phases.md Phase 3; invariants.md INV-D1, INV-D2;
 * api-contracts.md §5 (DatasetFilter).
 */

import type {
  Dataset,
  DatasetId,
  Format,
  Grid,
} from '../types';
import type { DatasetFilter } from './types';

// ============================================================================
// Grid deep-equality
// ============================================================================

/**
 * Compares two Grid values for deep equality. Grid is a tagged union,
 * so we compare the `kind` discriminator and then the kind-specific
 * fields.
 *
 * Spec: api-contracts.md §5 (DatasetFilter.grid).
 */
function gridsEqual(a: Grid, b: Grid): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'lat-lon': {
      const other = b as { readonly kind: 'lat-lon'; readonly nlat: number; readonly nlon: number };
      return a.nlat === other.nlat && a.nlon === other.nlon;
    }
    case 'icon': {
      const other = b as { readonly kind: 'icon'; readonly refinementLevel: string };
      return a.refinementLevel === other.refinementLevel;
    }
    case 'healpix': {
      const other = b as { readonly kind: 'healpix'; readonly nside: number; readonly nest: boolean };
      return a.nside === other.nside && a.nest === other.nest;
    }
    case 'grib2-native': {
      const other = b as { readonly kind: 'grib2-native'; readonly spectral: string };
      return a.spectral === other.spectral;
    }
    default:
      return false;
  }
}

// ============================================================================
// DatasetRegistry
// ============================================================================

/**
 * In-memory Dataset registry. Stores Datasets by ID in a `Map`.
 *
 * INV-D1: The registry never mutates an existing Dataset. State
 *   changes (consumable, quarantined) are performed by `replace()`,
 *   which stores a new Dataset object with the same ID. The
 *   original object is left untouched.
 *
 * The registry is per-Service-instance and is NOT persisted to disk
 * in Phase 3.
 *
 * Spec: build-phases.md Phase 3; invariants.md INV-D1;
 * api-contracts.md §5.
 */
export class DatasetRegistry {
  #datasets = new Map<DatasetId, Dataset>();

  // ========================================================================
  // register
  // ========================================================================

  /**
   * Stores a new Dataset. Throws if a Dataset with the same ID is
   * already registered — `registerDataset()` always creates a new
   * entity with a new identity (INV-D1).
   *
   * @throws {Error} if a Dataset with the same ID already exists.
   */
  register(dataset: Dataset): void {
    if (this.#datasets.has(dataset.id)) {
      throw new Error(
        `Dataset with ID ${dataset.id as string} is already registered`,
      );
    }
    this.#datasets.set(dataset.id, dataset);
  }

  // ========================================================================
  // get
  // ========================================================================

  /**
   * Returns the Dataset for the given ID, or null if not found.
   * The returned Dataset is the same frozen object that was
   * registered (or replaced) — no copy is made.
   */
  get(id: DatasetId): Dataset | null {
    return this.#datasets.get(id) ?? null;
  }

  // ========================================================================
  // has
  // ========================================================================

  /**
   * Returns true if a Dataset with the given ID is registered.
   */
  has(id: DatasetId): boolean {
    return this.#datasets.has(id);
  }

  // ========================================================================
  // list
  // ========================================================================

  /**
   * Returns all Datasets, optionally filtered. All specified filter
   * fields must match (AND semantics).
   *
   * - `format`: exact match on `dataset.format`.
   * - `grid`: deep equality on the Grid tagged union.
   * - `variableName`: match if any Variable in the Dataset has the
   *   given name.
   * - `producerToolInvocationId`: exact match on
   *   `dataset.producerToolInvocationId`.
   *
   * The returned Datasets are the same frozen objects stored in the
   * registry — no copies are made.
   *
   * Spec: api-contracts.md §5 (DatasetFilter).
   */
  list(filter?: DatasetFilter): Dataset[] {
    const all = Array.from(this.#datasets.values());

    if (filter === undefined) {
      return all;
    }

    return all.filter((dataset) => this.#matchesFilter(dataset, filter));
  }

  // ========================================================================
  // replace (INV-D1 — immutability)
  // ========================================================================

  /**
   * Replaces an existing Dataset with a new one. The new Dataset
   * must have the same ID as the existing one. This is the
   * mechanism for state changes (consumable, quarantined) that
   * preserves INV-D1: the original Dataset is never modified in
   * place; a new frozen Dataset replaces it in the registry.
   *
   * @throws {Error} if no Dataset with the given ID exists.
   */
  replace(dataset: Dataset): void {
    if (!this.#datasets.has(dataset.id)) {
      throw new Error(
        `Cannot replace Dataset with ID ${dataset.id as string} — not registered`,
      );
    }
    this.#datasets.set(dataset.id, dataset);
  }

  // ========================================================================
  // size
  // ========================================================================

  /**
   * Returns the number of registered Datasets.
   */
  get size(): number {
    return this.#datasets.size;
  }

  // ========================================================================
  // Private: filter matching
  // ========================================================================

  /**
   * Returns true if the Dataset matches all specified filter fields
   * (AND semantics). Unspecified fields are not checked.
   */
  #matchesFilter(dataset: Dataset, filter: DatasetFilter): boolean {
    if (filter.format !== undefined && dataset.format !== filter.format) {
      return false;
    }

    if (filter.grid !== undefined && !gridsEqual(dataset.grid, filter.grid)) {
      return false;
    }

    if (
      filter.variableName !== undefined &&
      !dataset.variables.some((v) => v.name === filter.variableName)
    ) {
      return false;
    }

    if (
      filter.producerToolInvocationId !== undefined &&
      dataset.producerToolInvocationId !== filter.producerToolInvocationId
    ) {
      return false;
    }

    return true;
  }
}

// ============================================================================
// Utility: dataset comparison helpers (exported for testing)
// ============================================================================

/**
 * Compares two Format values for equality. Exported for testing
 * and for use by other modules that need to compare Formats.
 */
export function formatsEqual(a: Format, b: Format): boolean {
  return a === b;
}
