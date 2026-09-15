/**
 * Unit tests for DatasetRegistry.
 *
 * Verifies INV-D1 (immutability — no operation modifies an existing
 * Dataset) and the registry's query/list/filter behavior.
 *
 * Spec: build-phases.md Phase 3; invariants.md INV-D1, INV-D2;
 * api-contracts.md §5 (DatasetFilter).
 */

import { describe, it, expect } from 'vitest';
import { DatasetRegistry } from '../../src/data-management/dataset-registry';
import {
  createDatasetId,
  createToolInvocationId,
  createMockDataset,
  createMockGrid,
  createMockVariable,
} from './helpers';

// ============================================================================
// register
// ============================================================================

describe('DatasetRegistry — register', () => {
  it('stores a Dataset and makes it queryable by ID', () => {
    const registry = new DatasetRegistry();
    const dataset = createMockDataset({
      id: createDatasetId('ds-reg-001'),
      name: 'tas_historical_2000-2010',
    });

    registry.register(dataset);

    const queried = registry.get(createDatasetId('ds-reg-001'));
    expect(queried).not.toBeNull();
    expect(queried?.name).toBe('tas_historical_2000-2010');
  });

  it('stores the exact Dataset object (no copy)', () => {
    const registry = new DatasetRegistry();
    const dataset = createMockDataset({ id: createDatasetId('ds-exact-001') });

    registry.register(dataset);

    const queried = registry.get(createDatasetId('ds-exact-001'));
    expect(queried).toBe(dataset);
  });

  it('throws if a Dataset with the same ID is already registered', () => {
    const registry = new DatasetRegistry();
    const ds1 = createMockDataset({ id: createDatasetId('ds-dup-001') });
    const ds2 = createMockDataset({
      id: createDatasetId('ds-dup-001'),
      name: 'different_name',
    });

    registry.register(ds1);

    expect(() => registry.register(ds2)).toThrow();
  });
});

// ============================================================================
// get (query by ID)
// ============================================================================

describe('DatasetRegistry — get', () => {
  it('returns the Dataset for an existing ID', () => {
    const registry = new DatasetRegistry();
    const dataset = createMockDataset({ id: createDatasetId('ds-get-001') });
    registry.register(dataset);

    const result = registry.get(createDatasetId('ds-get-001'));
    expect(result).toBe(dataset);
  });

  it('returns null for a non-existent ID', () => {
    const registry = new DatasetRegistry();

    const result = registry.get(createDatasetId('ds-nonexistent'));
    expect(result).toBeNull();
  });
});

// ============================================================================
// has (existence check)
// ============================================================================

describe('DatasetRegistry — has', () => {
  it('returns true for an existing ID', () => {
    const registry = new DatasetRegistry();
    registry.register(createMockDataset({ id: createDatasetId('ds-has-001') }));

    expect(registry.has(createDatasetId('ds-has-001'))).toBe(true);
  });

  it('returns false for a non-existent ID', () => {
    const registry = new DatasetRegistry();

    expect(registry.has(createDatasetId('ds-nonexistent'))).toBe(false);
  });
});

// ============================================================================
// list (with filter)
// ============================================================================

describe('DatasetRegistry — list', () => {
  it('returns all Datasets when no filter is provided', () => {
    const registry = new DatasetRegistry();
    registry.register(createMockDataset({ id: createDatasetId('ds-list-001') }));
    registry.register(createMockDataset({ id: createDatasetId('ds-list-002') }));
    registry.register(createMockDataset({ id: createDatasetId('ds-list-003') }));

    const all = registry.list();
    expect(all).toHaveLength(3);
  });

  it('returns empty array when the registry is empty', () => {
    const registry = new DatasetRegistry();

    expect(registry.list()).toEqual([]);
  });

  it('filters by format', () => {
    const registry = new DatasetRegistry();
    registry.register(
      createMockDataset({ id: createDatasetId('ds-fmt-001'), format: 'netcdf' }),
    );
    registry.register(
      createMockDataset({ id: createDatasetId('ds-fmt-002'), format: 'zarr' }),
    );
    registry.register(
      createMockDataset({ id: createDatasetId('ds-fmt-003'), format: 'netcdf' }),
    );

    const netcdfOnly = registry.list({ format: 'netcdf' });
    expect(netcdfOnly).toHaveLength(2);
    expect(netcdfOnly.every((d) => d.format === 'netcdf')).toBe(true);
  });

  it('filters by grid (deep equality on tagged union)', () => {
    const latlonGrid = createMockGrid({ kind: 'lat-lon', nlat: 90, nlon: 180 });
    const iconGrid = createMockGrid({ kind: 'icon', refinementLevel: 'R02B09' });

    const registry = new DatasetRegistry();
    registry.register(
      createMockDataset({ id: createDatasetId('ds-grid-001'), grid: latlonGrid }),
    );
    registry.register(
      createMockDataset({ id: createDatasetId('ds-grid-002'), grid: iconGrid }),
    );
    registry.register(
      createMockDataset({
        id: createDatasetId('ds-grid-003'),
        grid: createMockGrid({ kind: 'lat-lon', nlat: 90, nlon: 180 }),
      }),
    );

    const latlonOnly = registry.list({ grid: latlonGrid });
    expect(latlonOnly).toHaveLength(2);
    expect(latlonOnly.every((d) => d.grid.kind === 'lat-lon')).toBe(true);
  });

  it('filters by variable name', () => {
    const tasVar = createMockVariable({ name: 'TAS' });
    const prVar = createMockVariable({ name: 'PR' });

    const registry = new DatasetRegistry();
    registry.register(
      createMockDataset({
        id: createDatasetId('ds-var-001'),
        variables: [tasVar],
      }),
    );
    registry.register(
      createMockDataset({
        id: createDatasetId('ds-var-002'),
        variables: [prVar],
      }),
    );
    registry.register(
      createMockDataset({
        id: createDatasetId('ds-var-003'),
        variables: [tasVar, prVar],
      }),
    );

    const tasOnly = registry.list({ variableName: 'TAS' });
    expect(tasOnly).toHaveLength(2);
    expect(
      tasOnly.every((d) => d.variables.some((v) => v.name === 'TAS')),
    ).toBe(true);
  });

  it('filters by producerToolInvocationId', () => {
    const tiId = createToolInvocationId('ti-producer-001');
    const otherTiId = createToolInvocationId('ti-producer-002');

    const registry = new DatasetRegistry();
    registry.register(
      createMockDataset({
        id: createDatasetId('ds-prod-001'),
        producerToolInvocationId: tiId,
      }),
    );
    registry.register(
      createMockDataset({
        id: createDatasetId('ds-prod-002'),
        producerToolInvocationId: otherTiId,
      }),
    );
    registry.register(
      createMockDataset({
        id: createDatasetId('ds-prod-003'),
        producerToolInvocationId: null,
      }),
    );

    const produced = registry.list({ producerToolInvocationId: tiId });
    expect(produced).toHaveLength(1);
    expect(produced[0]?.id).toEqual(createDatasetId('ds-prod-001'));
  });

  it('applies multiple filters with AND semantics', () => {
    const latlonGrid = createMockGrid({ kind: 'lat-lon' });
    const tasVar = createMockVariable({ name: 'TAS' });
    const prVar = createMockVariable({ name: 'PR' });

    const registry = new DatasetRegistry();
    registry.register(
      createMockDataset({
        id: createDatasetId('ds-and-001'),
        format: 'netcdf',
        grid: latlonGrid,
        variables: [tasVar],
      }),
    );
    registry.register(
      createMockDataset({
        id: createDatasetId('ds-and-002'),
        format: 'netcdf',
        grid: latlonGrid,
        variables: [prVar],
      }),
    );
    registry.register(
      createMockDataset({
        id: createDatasetId('ds-and-003'),
        format: 'zarr',
        grid: latlonGrid,
        variables: [tasVar],
      }),
    );

    const result = registry.list({
      format: 'netcdf',
      grid: latlonGrid,
      variableName: 'TAS',
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toEqual(createDatasetId('ds-and-001'));
  });
});

// ============================================================================
// replace (INV-D1 — immutability)
// ============================================================================

describe('DatasetRegistry — replace (INV-D1 immutability)', () => {
  it('replaces a Dataset with a new frozen object', () => {
    const registry = new DatasetRegistry();
    const original = createMockDataset({
      id: createDatasetId('ds-replace-001'),
      consumable: false,
    });
    registry.register(original);

    const replacement = createMockDataset({
      id: createDatasetId('ds-replace-001'),
      consumable: true,
    });
    registry.replace(replacement);

    const queried = registry.get(createDatasetId('ds-replace-001'));
    expect(queried).toBe(replacement);
    expect(queried).not.toBe(original);
    expect(queried?.consumable).toBe(true);
  });

  it('the original Dataset object is not mutated', () => {
    const registry = new DatasetRegistry();
    const original = createMockDataset({
      id: createDatasetId('ds-immutable-001'),
      consumable: false,
    });
    registry.register(original);

    const replacement = createMockDataset({
      id: createDatasetId('ds-immutable-001'),
      consumable: true,
    });
    registry.replace(replacement);

    // The original object still has consumable: false
    expect(original.consumable).toBe(false);
    expect(Object.isFrozen(original)).toBe(true);
  });

  it('throws if replacing a non-existent Dataset', () => {
    const registry = new DatasetRegistry();
    const replacement = createMockDataset({
      id: createDatasetId('ds-not-found'),
      consumable: true,
    });

    expect(() => registry.replace(replacement)).toThrow();
  });
});

// ============================================================================
// Immutability of the returned Dataset
// ============================================================================

describe('DatasetRegistry — returned Datasets are frozen (INV-D1)', () => {
  it('register stores a frozen Dataset', () => {
    const registry = new DatasetRegistry();
    const dataset = createMockDataset({ id: createDatasetId('ds-frozen-001') });

    registry.register(dataset);

    expect(Object.isFrozen(dataset)).toBe(true);
  });

  it('get returns the same frozen object (not a mutable copy)', () => {
    const registry = new DatasetRegistry();
    registry.register(createMockDataset({ id: createDatasetId('ds-frozen-002') }));

    const queried = registry.get(createDatasetId('ds-frozen-002'));
    expect(Object.isFrozen(queried)).toBe(true);
  });

  it('list returns frozen Datasets', () => {
    const registry = new DatasetRegistry();
    registry.register(createMockDataset({ id: createDatasetId('ds-frozen-003') }));

    const all = registry.list();
    expect(all.every((d) => Object.isFrozen(d))).toBe(true);
  });
});
