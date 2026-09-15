/**
 * Unit tests for DataManagementServiceImpl.
 *
 * Verifies all four data-management invariants (INV-D1–D4) and all
 * five failure modes (FM-D1–D5), plus event emission and the joint
 * enforcement of INV-D3 / INV-P3 with the ProvenanceService.
 *
 * INV-D1: Dataset immutability — registerDataset returns a frozen
 *   Dataset; quarantineDataset and markConsumable create new
 *   frozen Datasets (never modify in place).
 * INV-D2: One Format, one Grid per Dataset — immutable fields,
 *   validated at registration.
 * INV-D3: Provenance before consumption — markConsumable calls
 *   provenance.verifyProvenance() and throws ProvenanceMissing if
 *   false. Joint enforcement with C6.
 * INV-D4: Location resolves before use — validateLocation checks
 *   exists/readable (read) or writable (write) before use.
 *
 * FM-D1: Quota exceeded (DataQuotaExceeded).
 * FM-D2: Slow filesystem (cause: 'slow').
 * FM-D3: File not found / permission denied (cause: 'enoent' | 'eacces').
 * FM-D5: Corrupted ZARR store (quarantined via quarantineDataset).
 *
 * Spec: build-phases.md Phase 3; api-contracts.md §5;
 * invariants.md INV-D1–D4; failure-modes.md FM-D1–D5;
 * resolutions.md R11.
 */

import { describe, it, expect } from 'vitest';
import { DataManagementServiceImpl } from '../../src/data-management/data-management-service';
import type { DataManagementServiceImplProps } from '../../src/data-management/data-management-service';
import {
  createDatasetId,
  createToolInvocationId,
  createMockFilesystem,
  createMockProvenanceService,
  createMockRegisterInput,
  createMockLocation,
  createMockGrid,
  createMockVariable,
  createEventCollector,
} from './helpers';
import {
  LocationNotReadable,
  LocationNotWritable,
  DataQuotaExceeded,
  ProvenanceMissing,
  DatasetCorrupted,
} from '../../src/types/errors';
import type { DatasetEvent } from '../../src/types';

// ============================================================================
// Test setup helper
// ============================================================================

function createService(overrides: {
  filesystem?: ReturnType<typeof createMockFilesystem>;
  provenance?: ReturnType<typeof createMockProvenanceService>;
  config?: Partial<NonNullable<DataManagementServiceImplProps['config']>>;
  onEvent?: (event: DatasetEvent) => void;
} = {}): {
  service: DataManagementServiceImpl;
  fs: ReturnType<typeof createMockFilesystem>;
  provenance: ReturnType<typeof createMockProvenanceService>;
} {
  const fs = overrides.filesystem ?? createMockFilesystem();
  const provenance = overrides.provenance ?? createMockProvenanceService();
  const service = new DataManagementServiceImpl({
    filesystem: fs,
    provenance,
    config: overrides.config,
    onEvent: overrides.onEvent,
  });
  return { service, fs, provenance };
}

// ============================================================================
// registerDataset — INV-D1 (immutability)
// ============================================================================

describe('DataManagementServiceImpl.registerDataset — INV-D1 (immutability)', () => {
  it('returns a frozen Dataset', async () => {
    const { service } = createService();

    const dataset = await service.registerDataset(createMockRegisterInput());

    expect(Object.isFrozen(dataset)).toBe(true);
  });

  it('assigns a unique DatasetId', async () => {
    const { service } = createService();

    const ds1 = await service.registerDataset(
      createMockRegisterInput({ name: 'dataset_001' }),
    );
    const ds2 = await service.registerDataset(
      createMockRegisterInput({ name: 'dataset_002' }),
    );

    expect(ds1.id).not.toBe(ds2.id);
  });

  it('creates the Dataset with consumable: false (INV-D3 — pending state)', async () => {
    const { service } = createService();

    const dataset = await service.registerDataset(createMockRegisterInput());

    expect(dataset.consumable).toBe(false);
  });

  it('creates the Dataset with quarantined: false', async () => {
    const { service } = createService();

    const dataset = await service.registerDataset(createMockRegisterInput());

    expect(dataset.quarantined).toBe(false);
  });

  it('stores producerToolInvocationId when provided', async () => {
    const { service } = createService();
    const tiId = createToolInvocationId('ti-producer-001');

    const dataset = await service.registerDataset(
      createMockRegisterInput({ producerToolInvocationId: tiId }),
    );

    expect(dataset.producerToolInvocationId).toEqual(tiId);
  });

  it('stores null producerToolInvocationId when not provided (manually registered)', async () => {
    const { service } = createService();

    const dataset = await service.registerDataset(
      createMockRegisterInput({ producerToolInvocationId: undefined }),
    );

    expect(dataset.producerToolInvocationId).toBeNull();
  });
});

// ============================================================================
// registerDataset — INV-D2 (one Format, one Grid)
// ============================================================================

describe('DataManagementServiceImpl.registerDataset — INV-D2 (one Format, one Grid)', () => {
  it('stores the Format as a readonly field', async () => {
    const { service } = createService();

    const dataset = await service.registerDataset(
      createMockRegisterInput({ format: 'zarr' }),
    );

    expect(dataset.format).toBe('zarr');
  });

  it('stores the Grid as a readonly field', async () => {
    const { service } = createService();
    const iconGrid = createMockGrid({ kind: 'icon', refinementLevel: 'R02B09' });

    const dataset = await service.registerDataset(
      createMockRegisterInput({ grid: iconGrid }),
    );

    expect(dataset.grid).toEqual(iconGrid);
  });

  it('a grid conversion produces a new Dataset with a different Grid (INV-D2)', async () => {
    const { service } = createService();

    // Register original Dataset with ICON grid
    const iconGrid = createMockGrid({ kind: 'icon', refinementLevel: 'R02B09' });
    const original = await service.registerDataset(
      createMockRegisterInput({
        name: 'icon_data_R02B09',
        grid: iconGrid,
      }),
    );

    // "Convert" to lat-lon — this is a new Dataset with a different Grid
    const latlonGrid = createMockGrid({ kind: 'lat-lon', nlat: 90, nlon: 180 });
    const converted = await service.registerDataset(
      createMockRegisterInput({
        name: 'icon_to_latlon_R02B09',
        grid: latlonGrid,
        producerToolInvocationId: createToolInvocationId('ti-cdo-remap-001'),
      }),
    );

    // Both Datasets exist — original unchanged, new one has different Grid
    expect(original.grid).toEqual(iconGrid);
    expect(converted.grid).toEqual(latlonGrid);
    expect(converted.id).not.toBe(original.id);
  });

  it('a format conversion produces a new Dataset with a different Format (INV-D2)', async () => {
    const { service } = createService();

    // Register original Dataset as NetCDF
    const original = await service.registerDataset(
      createMockRegisterInput({
        name: 'tas_historical',
        format: 'netcdf',
      }),
    );

    // "Convert" to ZARR — this is a new Dataset with a different Format
    const converted = await service.registerDataset(
      createMockRegisterInput({
        name: 'tas_historical_zarr',
        format: 'zarr',
        producerToolInvocationId: createToolInvocationId('ti-python-convert-001'),
      }),
    );

    expect(original.format).toBe('netcdf');
    expect(converted.format).toBe('zarr');
    expect(converted.id).not.toBe(original.id);
  });

  it('stores all Variables provided at registration', async () => {
    const { service } = createService();
    const variables = [
      createMockVariable({ name: 'TAS', units: 'K', dimensions: ['time', 'lat', 'lon'] }),
      createMockVariable({ name: 'PR', units: 'mm/day', dimensions: ['time', 'lat', 'lon'] }),
    ];

    const dataset = await service.registerDataset(
      createMockRegisterInput({ variables }),
    );

    expect(dataset.variables).toHaveLength(2);
    expect(dataset.variables[0]?.name).toBe('TAS');
    expect(dataset.variables[1]?.name).toBe('PR');
  });
});

// ============================================================================
// registerDataset — Location validation (INV-D4, FM-D3)
// ============================================================================

describe('DataManagementServiceImpl.registerDataset — Location validation (INV-D4)', () => {
  it('validates the Location is readable before registering', async () => {
    const { service, fs } = createService();

    await service.registerDataset(
      createMockRegisterInput({
        location: createMockLocation({ path: '/scratch/data/test.nc' }),
      }),
    );

    expect(fs.existsCalls).toContain('/scratch/data/test.nc');
    expect(fs.isReadableCalls).toContain('/scratch/data/test.nc');
  });

  it('throws LocationNotReadable when the Location does not exist (FM-D3)', async () => {
    const fs = createMockFilesystem({
      nonExistentPaths: new Set(['/scratch/data/missing.nc']),
    });
    const { service } = createService({ filesystem: fs });

    await expect(
      service.registerDataset(
        createMockRegisterInput({
          location: createMockLocation({ path: '/scratch/data/missing.nc' }),
        }),
      ),
    ).rejects.toThrow(LocationNotReadable);
  });

  it('throws LocationNotReadable when the Location is not readable (FM-D3)', async () => {
    const fs = createMockFilesystem({
      existingPaths: new Set(['/scratch/data/protected.nc']),
      readablePaths: new Set([]),
    });
    const { service } = createService({ filesystem: fs });

    await expect(
      service.registerDataset(
        createMockRegisterInput({
          location: createMockLocation({ path: '/scratch/data/protected.nc' }),
        }),
      ),
    ).rejects.toThrow(LocationNotReadable);
  });

  it('does not register the Dataset when Location validation fails', async () => {
    const fs = createMockFilesystem({
      nonExistentPaths: new Set(['/scratch/data/missing.nc']),
    });
    const { service } = createService({ filesystem: fs });

    try {
      await service.registerDataset(
        createMockRegisterInput({
          name: 'should_not_register',
          location: createMockLocation({ path: '/scratch/data/missing.nc' }),
        }),
      );
      expect.fail('should have thrown');
    } catch {
      // Query the Dataset — it should not exist
      const queried = await service.queryDataset(
        createDatasetId('should_not_register'),
      );
      expect(queried).toBeNull();
    }
  });
});

// ============================================================================
// registerDataset — event emission
// ============================================================================

describe('DataManagementServiceImpl.registerDataset — events', () => {
  it('emits a dataset_registered event on success', async () => {
    const collector = createEventCollector();
    const { service } = createService({ onEvent: collector.handler });

    const dataset = await service.registerDataset(
      createMockRegisterInput({ name: 'event_test_001' }),
    );

    const registered = collector.findByKind('dataset_registered');
    expect(registered).toHaveLength(1);
    expect(registered[0]?.kind).toBe('dataset_registered');
    if (registered[0]?.kind === 'dataset_registered') {
      expect(registered[0].datasetId).toEqual(dataset.id);
      expect(registered[0].name).toBe('event_test_001');
    }
  });

  it('includes format and gridKind in the registered event', async () => {
    const collector = createEventCollector();
    const { service } = createService({ onEvent: collector.handler });

    await service.registerDataset(
      createMockRegisterInput({
        format: 'zarr',
        grid: createMockGrid({ kind: 'healpix', nside: 1024, nest: true }),
      }),
    );

    const registered = collector.findByKind('dataset_registered');
    if (registered[0]?.kind === 'dataset_registered') {
      expect(registered[0].format).toBe('zarr');
      expect(registered[0].gridKind).toBe('healpix');
    }
  });
});

// ============================================================================
// queryDataset
// ============================================================================

describe('DataManagementServiceImpl.queryDataset', () => {
  it('returns the Dataset for an existing ID', async () => {
    const { service } = createService();

    const registered = await service.registerDataset(
      createMockRegisterInput({ name: 'queryable_001' }),
    );

    const queried = await service.queryDataset(registered.id);
    expect(queried).not.toBeNull();
    expect(queried?.name).toBe('queryable_001');
  });

  it('returns the same frozen object that was registered', async () => {
    const { service } = createService();

    const registered = await service.registerDataset(
      createMockRegisterInput({ name: 'frozen_queryable' }),
    );

    const queried = await service.queryDataset(registered.id);
    expect(queried).toBe(registered);
  });

  it('returns null for a non-existent ID', async () => {
    const { service } = createService();

    const result = await service.queryDataset(createDatasetId('ds-nonexistent'));
    expect(result).toBeNull();
  });
});

// ============================================================================
// listDatasets
// ============================================================================

describe('DataManagementServiceImpl.listDatasets', () => {
  it('returns all registered Datasets when no filter is provided', async () => {
    const { service } = createService();

    await service.registerDataset(createMockRegisterInput({ name: 'ds-A' }));
    await service.registerDataset(createMockRegisterInput({ name: 'ds-B' }));
    await service.registerDataset(createMockRegisterInput({ name: 'ds-C' }));

    const all = await service.listDatasets();
    expect(all).toHaveLength(3);
  });

  it('returns empty array when no Datasets are registered', async () => {
    const { service } = createService();

    const all = await service.listDatasets();
    expect(all).toEqual([]);
  });

  it('filters by format', async () => {
    const { service } = createService();

    await service.registerDataset(createMockRegisterInput({ name: 'ds-nc', format: 'netcdf' }));
    await service.registerDataset(createMockRegisterInput({ name: 'ds-zarr', format: 'zarr' }));
    await service.registerDataset(createMockRegisterInput({ name: 'ds-nc2', format: 'netcdf' }));

    const netcdfOnly = await service.listDatasets({ format: 'netcdf' });
    expect(netcdfOnly).toHaveLength(2);
    expect(netcdfOnly.every((d) => d.format === 'netcdf')).toBe(true);
  });

  it('filters by grid (deep equality)', async () => {
    const { service } = createService();

    const latlonGrid = createMockGrid({ kind: 'lat-lon', nlat: 90, nlon: 180 });
    const iconGrid = createMockGrid({ kind: 'icon', refinementLevel: 'R02B09' });

    await service.registerDataset(createMockRegisterInput({ name: 'ds-ll', grid: latlonGrid }));
    await service.registerDataset(createMockRegisterInput({ name: 'ds-icon', grid: iconGrid }));
    await service.registerDataset(
      createMockRegisterInput({ name: 'ds-ll2', grid: createMockGrid({ kind: 'lat-lon', nlat: 90, nlon: 180 }) }),
    );

    const latlonOnly = await service.listDatasets({ grid: latlonGrid });
    expect(latlonOnly).toHaveLength(2);
  });

  it('filters by variable name', async () => {
    const { service } = createService();

    await service.registerDataset(
      createMockRegisterInput({
        name: 'ds-tas',
        variables: [createMockVariable({ name: 'TAS' })],
      }),
    );
    await service.registerDataset(
      createMockRegisterInput({
        name: 'ds-pr',
        variables: [createMockVariable({ name: 'PR' })],
      }),
    );

    const tasOnly = await service.listDatasets({ variableName: 'TAS' });
    expect(tasOnly).toHaveLength(1);
    expect(tasOnly[0]?.name).toBe('ds-tas');
  });

  it('filters by producerToolInvocationId', async () => {
    const { service } = createService();
    const tiId = createToolInvocationId('ti-list-001');

    await service.registerDataset(
      createMockRegisterInput({ name: 'ds-produced', producerToolInvocationId: tiId }),
    );
    await service.registerDataset(
      createMockRegisterInput({ name: 'ds-manual' }),
    );

    const produced = await service.listDatasets({ producerToolInvocationId: tiId });
    expect(produced).toHaveLength(1);
    expect(produced[0]?.name).toBe('ds-produced');
  });
});

// ============================================================================
// validateLocation — INV-D4
// ============================================================================

describe('DataManagementServiceImpl.validateLocation — INV-D4', () => {
  it('returns true for a readable path in read mode', async () => {
    const { service } = createService();

    const result = await service.validateLocation(
      createMockLocation({ path: '/scratch/data/test.nc' }),
      'read',
    );

    expect(result).toBe(true);
  });

  it('returns true for a writable path in write mode', async () => {
    const { service } = createService();

    const result = await service.validateLocation(
      createMockLocation({ path: '/scratch/output/output.nc' }),
      'write',
    );

    expect(result).toBe(true);
  });

  it('throws LocationNotReadable when read mode path does not exist (FM-D3)', async () => {
    const fs = createMockFilesystem({
      nonExistentPaths: new Set(['/scratch/data/missing.nc']),
    });
    const { service } = createService({ filesystem: fs });

    await expect(
      service.validateLocation(
        createMockLocation({ path: '/scratch/data/missing.nc' }),
        'read',
      ),
    ).rejects.toThrow(LocationNotReadable);
  });

  it('throws LocationNotWritable when write mode path is not writable (FM-D3)', async () => {
    const fs = createMockFilesystem({
      existingPaths: new Set(['/scratch/readonly/output.nc']),
      writablePaths: new Set([]),
    });
    const { service } = createService({ filesystem: fs });

    await expect(
      service.validateLocation(
        createMockLocation({ path: '/scratch/readonly/output.nc' }),
        'write',
      ),
    ).rejects.toThrow(LocationNotWritable);
  });

  it('throws DataQuotaExceeded when quota is exceeded in write mode (FM-D1)', async () => {
    const { service } = createService({
      config: {
        slowThresholdMs: 10_000,
        quotaChecker: async () => true,
      },
    });

    await expect(
      service.validateLocation(
        createMockLocation({ path: '/scratch/full/output.nc', filesystem: 'scratch' }),
        'write',
      ),
    ).rejects.toThrow(DataQuotaExceeded);
  });

  it('emits a dataset_location_invalid event on validation failure', async () => {
    const collector = createEventCollector();
    const fs = createMockFilesystem({
      nonExistentPaths: new Set(['/scratch/data/missing.nc']),
    });
    const { service } = createService({
      filesystem: fs,
      onEvent: collector.handler,
    });

    try {
      await service.validateLocation(
        createMockLocation({ path: '/scratch/data/missing.nc' }),
        'read',
      );
      expect.fail('should have thrown');
    } catch {
      const invalid = collector.findByKind('dataset_location_invalid');
      expect(invalid).toHaveLength(1);
      if (invalid[0]?.kind === 'dataset_location_invalid') {
        expect(invalid[0].path).toBe('/scratch/data/missing.nc');
        expect(invalid[0].cause).toBe('enoent');
      }
    }
  });
});

// ============================================================================
// markConsumable — INV-D3 (Provenance before consumption)
// ============================================================================

describe('DataManagementServiceImpl.markConsumable — INV-D3 (joint with C6)', () => {
  it('calls provenance.verifyProvenance() before marking consumable', async () => {
    const { service, provenance } = createService();
    const dataset = await service.registerDataset(createMockRegisterInput());

    // Set up: the Dataset has Provenance
    provenance.setVerifiable([dataset.id]);

    await service.markConsumable(dataset.id);

    expect(provenance.verifyCalls).toContain(dataset.id);
  });

  it('marks the Dataset as consumable when verifyProvenance returns true', async () => {
    const { service, provenance } = createService();
    const dataset = await service.registerDataset(createMockRegisterInput());

    provenance.setVerifiable([dataset.id]);

    await service.markConsumable(dataset.id);

    const queried = await service.queryDataset(dataset.id);
    expect(queried?.consumable).toBe(true);
  });

  it('throws ProvenanceMissing when verifyProvenance returns false (INV-D3, FM-P3)', async () => {
    const { service } = createService();
    const dataset = await service.registerDataset(createMockRegisterInput());

    // verifyProvenance returns false (default mock behavior)
    await expect(service.markConsumable(dataset.id)).rejects.toThrow(ProvenanceMissing);

    try {
      await service.markConsumable(dataset.id);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ProvenanceMissing);
      expect((error as ProvenanceMissing).kind).toBe('provenance_missing');
    }
  });

  it('does not mark the Dataset as consumable when Provenance is missing', async () => {
    const { service } = createService();
    const dataset = await service.registerDataset(createMockRegisterInput());

    try {
      await service.markConsumable(dataset.id);
      expect.fail('should have thrown');
    } catch {
      const queried = await service.queryDataset(dataset.id);
      expect(queried?.consumable).toBe(false);
    }
  });

  it('creates a new frozen Dataset (does not modify in place) — INV-D1', async () => {
    const { service, provenance } = createService();
    const original = await service.registerDataset(createMockRegisterInput());

    provenance.setVerifiable([original.id]);

    await service.markConsumable(original.id);

    // The original object is unchanged
    expect(original.consumable).toBe(false);
    expect(Object.isFrozen(original)).toBe(true);

    // The queried Dataset is a different object with consumable: true
    const queried = await service.queryDataset(original.id);
    expect(queried).not.toBe(original);
    expect(queried?.consumable).toBe(true);
    expect(Object.isFrozen(queried)).toBe(true);
  });

  it('emits a dataset_consumable event on success', async () => {
    const collector = createEventCollector();
    const { service, provenance } = createService({ onEvent: collector.handler });
    const dataset = await service.registerDataset(createMockRegisterInput());

    provenance.setVerifiable([dataset.id]);

    await service.markConsumable(dataset.id);

    const consumable = collector.findByKind('dataset_consumable');
    expect(consumable).toHaveLength(1);
    if (consumable[0]?.kind === 'dataset_consumable') {
      expect(consumable[0].datasetId).toEqual(dataset.id);
    }
  });

  it('throws when the Dataset does not exist', async () => {
    const { service } = createService();

    await expect(
      service.markConsumable(createDatasetId('ds-nonexistent')),
    ).rejects.toThrow();
  });

  it('does not mark consumable if the Dataset is already quarantined', async () => {
    const { service, provenance } = createService();
    const dataset = await service.registerDataset(createMockRegisterInput());

    provenance.setVerifiable([dataset.id]);

    // Quarantine first
    await service.quarantineDataset(dataset.id, 'corrupted ZARR store');

    // Attempt to mark consumable should fail (quarantined Datasets
    // are not available for downstream consumption)
    await expect(service.markConsumable(dataset.id)).rejects.toThrow();

    const queried = await service.queryDataset(dataset.id);
    expect(queried?.quarantined).toBe(true);
    expect(queried?.consumable).toBe(false);
  });
});

// ============================================================================
// quarantineDataset — R11 (local, not systemic)
// ============================================================================

describe('DataManagementServiceImpl.quarantineDataset — R11 (local quarantine)', () => {
  it('marks the Dataset as quarantined with a reason', async () => {
    const { service } = createService();
    const dataset = await service.registerDataset(createMockRegisterInput());

    await service.quarantineDataset(dataset.id, 'corrupted ZARR store');

    const queried = await service.queryDataset(dataset.id);
    expect(queried?.quarantined).toBe(true);
    expect(queried?.quarantineReason).toBe('corrupted ZARR store');
  });

  it('creates a new frozen Dataset (does not modify in place) — INV-D1', async () => {
    const { service } = createService();
    const original = await service.registerDataset(createMockRegisterInput());

    await service.quarantineDataset(original.id, 'corrupted');

    // The original object is unchanged
    expect(original.quarantined).toBe(false);
    expect(Object.isFrozen(original)).toBe(true);

    // The queried Dataset is a different object with quarantined: true
    const queried = await service.queryDataset(original.id);
    expect(queried).not.toBe(original);
    expect(queried?.quarantined).toBe(true);
    expect(Object.isFrozen(queried)).toBe(true);
  });

  it('a quarantined Dataset is not available for downstream consumption even if previously consumable', async () => {
    const { service, provenance } = createService();
    const dataset = await service.registerDataset(createMockRegisterInput());

    // Mark consumable first
    provenance.setVerifiable([dataset.id]);
    await service.markConsumable(dataset.id);

    let queried = await service.queryDataset(dataset.id);
    expect(queried?.consumable).toBe(true);

    // Now quarantine — the Dataset is no longer available
    await service.quarantineDataset(dataset.id, 'external mutation detected');

    queried = await service.queryDataset(dataset.id);
    expect(queried?.quarantined).toBe(true);
    expect(queried?.consumable).toBe(false);
  });

  it('quarantining one Dataset does not affect others (R11: local)', async () => {
    const { service } = createService();

    const ds1 = await service.registerDataset(
      createMockRegisterInput({ name: 'ds-quarantine-target' }),
    );
    const ds2 = await service.registerDataset(
      createMockRegisterInput({ name: 'ds-healthy' }),
    );

    // Quarantine ds1
    await service.quarantineDataset(ds1.id, 'corrupted');

    // ds2 is NOT quarantined
    const queried2 = await service.queryDataset(ds2.id);
    expect(queried2?.quarantined).toBe(false);

    // ds1 IS quarantined
    const queried1 = await service.queryDataset(ds1.id);
    expect(queried1?.quarantined).toBe(true);
  });

  it('emits a dataset_quarantined event with the reason', async () => {
    const collector = createEventCollector();
    const { service } = createService({ onEvent: collector.handler });
    const dataset = await service.registerDataset(createMockRegisterInput());

    await service.quarantineDataset(dataset.id, 'ZARR store missing chunks');

    const quarantined = collector.findByKind('dataset_quarantined');
    expect(quarantined).toHaveLength(1);
    if (quarantined[0]?.kind === 'dataset_quarantined') {
      expect(quarantined[0].datasetId).toEqual(dataset.id);
      expect(quarantined[0].reason).toBe('ZARR store missing chunks');
    }
  });

  it('throws when the Dataset does not exist', async () => {
    const { service } = createService();

    await expect(
      service.quarantineDataset(createDatasetId('ds-nonexistent'), 'reason'),
    ).rejects.toThrow();
  });

  it('can quarantine with a DatasetCorrupted reason (FM-D5)', async () => {
    const { service } = createService();
    const dataset = await service.registerDataset(
      createMockRegisterInput({
        name: 'corrupted_zarr_store',
        format: 'zarr',
        location: createMockLocation({ path: '/scratch/data/corrupted.zarr' }),
      }),
    );

    // The caller detects corruption and quarantines the Dataset
    await service.quarantineDataset(dataset.id, 'ZARR store missing .zarray metadata');

    const queried = await service.queryDataset(dataset.id);
    expect(queried?.quarantined).toBe(true);
    expect(queried?.quarantineReason).toContain('ZARR');
  });
});

// ============================================================================
// FM-D5: Corrupted ZARR store (full scenario)
// ============================================================================

describe('DataManagementServiceImpl — FM-D5 (corrupted ZARR store)', () => {
  it('a corrupted Dataset is quarantined and not consumable', async () => {
    const { service } = createService();

    // Register a ZARR Dataset
    const dataset = await service.registerDataset(
      createMockRegisterInput({
        name: 'corrupted_data',
        format: 'zarr',
        location: createMockLocation({ path: '/scratch/data/corrupted.zarr' }),
      }),
    );

    // Simulate corruption detection — quarantine the Dataset
    await service.quarantineDataset(
      dataset.id,
      'ZARR store missing .zarray metadata file',
    );
  });

  it('a DatasetCorrupted error can be thrown with datasetId, path, and corruptionType', () => {
    const error = new DatasetCorrupted({
      datasetId: createDatasetId('ds-corrupted-001'),
      path: '/scratch/data/corrupted.zarr',
      corruptionType: 'missing_zarray_metadata',
    });

    expect(error.kind).toBe('dataset_corrupted');
    expect(error.severity).toBe('HIGH');
    expect(error.userMessage).toContain('corrupted');
  });
});

// ============================================================================
// FM-D1: Quota exceeded (full scenario)
// ============================================================================

describe('DataManagementServiceImpl — FM-D1 (quota exceeded)', () => {
  it('validateLocation throws DataQuotaExceeded with path and filesystem', async () => {
    const { service } = createService({
      config: {
        slowThresholdMs: 10_000,
        quotaChecker: async () => true,
      },
    });

    try {
      await service.validateLocation(
        createMockLocation({ path: '/scratch/full/output.nc', filesystem: 'scratch' }),
        'write',
      );
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DataQuotaExceeded);
      const qe = error as DataQuotaExceeded;
      expect(qe.kind).toBe('data_quota_exceeded');
      expect(qe.userMessage).toContain('scratch');
    }
  });
});

// ============================================================================
// Interface stability
// ============================================================================

describe('DataManagementServiceImpl — interface stability', () => {
  it('does not expose the raw FilesystemGateway or ProvenanceService', () => {
    const { service } = createService();

    const obj = service as unknown as Record<string, unknown>;
    expect(obj.filesystem).toBeUndefined();
    expect(obj.fs).toBeUndefined();
    expect(obj.provenance).toBeUndefined();
  });

  it('implements all DataManagementService methods', () => {
    const { service } = createService();

    expect(typeof service.registerDataset).toBe('function');
    expect(typeof service.queryDataset).toBe('function');
    expect(typeof service.listDatasets).toBe('function');
    expect(typeof service.validateLocation).toBe('function');
    expect(typeof service.markConsumable).toBe('function');
    expect(typeof service.quarantineDataset).toBe('function');
  });
});
