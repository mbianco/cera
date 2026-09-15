/**
 * Test helpers for the data-management module.
 *
 * Provides mock FilesystemGateway factories (with configurable
 * existence, readability, writability, delays, and quota), mock
 * ProvenanceService, and Dataset/RegisterDatasetInput data
 * factories so tests can verify all four invariants (INV-D1–D4)
 * and all five failure modes (FM-D1–D5) without real filesystem
 * or Provenance services.
 *
 * Spec: build-phases.md Phase 3 (Tier 1 — unit tests with mock
 * fs and mock provenance).
 */

import type { FilesystemGateway, FileStat } from '../../src/dsh-adapter/types';
import type { ProvenanceService } from '../../src/provenance/types';
import type {
  Dataset,
  DatasetId,
  DatasetEvent,
  EnvironmentId,
  ExitOutcome,
  Format,
  Grid,
  JobId,
  Location,
  ProvenanceRecord,
  ProvenanceRecordId,
  ToolId,
  ToolInvocationId,
  Variable,
} from '../../src/types';

// ============================================================================
// Branded ID factories
// ============================================================================

export function createDatasetId(id: string): DatasetId {
  return id as DatasetId;
}

export function createToolInvocationId(id: string): ToolInvocationId {
  return id as ToolInvocationId;
}

export function createEnvironmentId(id: string): EnvironmentId {
  return id as EnvironmentId;
}

export function createToolId(id: string): ToolId {
  return id as ToolId;
}

export function createJobId(n: number): JobId {
  return n as JobId;
}

export function createProvenanceRecordId(id: string): ProvenanceRecordId {
  return id as ProvenanceRecordId;
}

// ============================================================================
// Value object factories
// ============================================================================

export function createMockLocation(overrides: Partial<Location> = {}): Location {
  return {
    path: overrides.path ?? '/scratch/snx3000/cera_user/data/test_dataset.nc',
    filesystem: overrides.filesystem ?? 'scratch',
  };
}

/**
 * Overrides for createMockGrid. All Grid variant properties are
 * optional; only the ones matching the `kind` are used.
 */
export interface GridOverrides {
  readonly kind?: Grid['kind'];
  readonly nlat?: number;
  readonly nlon?: number;
  readonly refinementLevel?: string;
  readonly nside?: number;
  readonly nest?: boolean;
  readonly spectral?: string;
}

export function createMockGrid(overrides: GridOverrides = {}): Grid {
  const kind = overrides.kind ?? 'lat-lon';
  if (kind === 'lat-lon') {
    return {
      kind: 'lat-lon',
      nlat: overrides.nlat ?? 90,
      nlon: overrides.nlon ?? 180,
    };
  }
  if (kind === 'icon') {
    return {
      kind: 'icon',
      refinementLevel: overrides.refinementLevel ?? 'R02B09',
    };
  }
  if (kind === 'healpix') {
    return {
      kind: 'healpix',
      nside: overrides.nside ?? 1024,
      nest: overrides.nest ?? true,
    };
  }
  return {
    kind: 'grib2-native',
    spectral: overrides.spectral ?? 'T1279',
  };
}

export function createMockVariable(overrides: Partial<Variable> = {}): Variable {
  return {
    name: overrides.name ?? 'TAS',
    units: overrides.units ?? 'K',
    dimensions: overrides.dimensions ?? ['time', 'lat', 'lon'],
  };
}

export function createMockExitOutcome(overrides: Partial<ExitOutcome> = {}): ExitOutcome {
  return {
    kind: 'exit_code',
    code: 0,
    ...overrides,
  } as ExitOutcome;
}

// ============================================================================
// Mock FilesystemGateway (in-memory, configurable)
// ============================================================================

/**
 * Configuration for the mock FilesystemGateway.
 *
 * - `existingPaths` — paths that exist (fs.exists returns true).
 *   If not set, all paths exist.
 * - `nonExistentPaths` — paths that do NOT exist (overrides
 *   `existingPaths` for specific paths).
 * - `readablePaths` — paths that are readable (fs.isReadable returns
 *   true). If not set, all existing paths are readable.
 * - `writablePaths` — paths that are writable (fs.isWritable returns
 *   true). If not set, all existing paths are writable.
 * - `delays` — delay in milliseconds for each operation type.
 *   Operations exceeding the configured slowThresholdMs should be
 *   treated as slow (FM-D2) by the caller.
 */
export interface MockFilesystemConfig {
  readonly existingPaths?: ReadonlySet<string>;
  readonly nonExistentPaths?: ReadonlySet<string>;
  readonly readablePaths?: ReadonlySet<string>;
  readonly writablePaths?: ReadonlySet<string>;
  readonly delays?: {
    readonly exists?: number;
    readonly isReadable?: number;
    readonly isWritable?: number;
    readonly stat?: number;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * An in-memory mock FilesystemGateway that simulates filesystem
 * operations with configurable existence, readability, writability,
 * and delays (for FM-D2 slow filesystem testing).
 *
 * Call tracking is exposed for test assertions:
 * - `existsCalls` — array of paths passed to exists()
 * - `isReadableCalls` — array of paths passed to isReadable()
 * - `isWritableCalls` — array of paths passed to isWritable()
 * - `statCalls` — array of paths passed to stat()
 */
export function createMockFilesystem(
  config: MockFilesystemConfig = {},
): FilesystemGateway & {
  readonly existsCalls: string[];
  readonly isReadableCalls: string[];
  readonly isWritableCalls: string[];
  readonly statCalls: string[];
  readonly config: MockFilesystemConfig;
} {
  const existsCalls: string[] = [];
  const isReadableCalls: string[] = [];
  const isWritableCalls: string[] = [];
  const statCalls: string[] = [];

  function pathExists(path: string): boolean {
    if (config.nonExistentPaths?.has(path)) return false;
    if (config.existingPaths) return config.existingPaths.has(path);
    return true;
  }

  function pathReadable(path: string): boolean {
    if (!pathExists(path)) return false;
    if (config.readablePaths) return config.readablePaths.has(path);
    return true;
  }

  function pathWritable(path: string): boolean {
    if (!pathExists(path)) return false;
    if (config.writablePaths) return config.writablePaths.has(path);
    return true;
  }

  const fs: FilesystemGateway = {
    async exists(path: string): Promise<boolean> {
      existsCalls.push(path);
      if (config.delays?.exists) await delay(config.delays.exists);
      return pathExists(path);
    },

    async isReadable(path: string): Promise<boolean> {
      isReadableCalls.push(path);
      if (config.delays?.isReadable) await delay(config.delays.isReadable);
      return pathReadable(path);
    },

    async isWritable(path: string): Promise<boolean> {
      isWritableCalls.push(path);
      if (config.delays?.isWritable) await delay(config.delays.isWritable);
      return pathWritable(path);
    },

    async stat(path: string): Promise<FileStat> {
      statCalls.push(path);
      if (config.delays?.stat) await delay(config.delays.stat);
      return {
        size: 1024,
        isFile: pathExists(path),
        isDirectory: false,
        mtime: new Date('2026-09-15T12:00:00Z'),
      };
    },

    async readFile(path: string): Promise<Buffer> {
      if (!pathExists(path)) {
        throw new Error(`ENOENT: no such file: ${path}`);
      }
      return Buffer.from('mock-data');
    },

    async writeFile(_path: string, _data: Buffer): Promise<void> {
      // Mock write — does nothing
    },

    async readDir(path: string): Promise<string[]> {
      if (!pathExists(path)) return [];
      return ['file1.nc', 'file2.nc'];
    },

    async mkdir(_path: string, _recursive?: boolean): Promise<void> {
      // Mock mkdir — does nothing
    },
  };

  return {
    ...fs,
    existsCalls,
    isReadableCalls,
    isWritableCalls,
    statCalls,
    config,
  };
}

// ============================================================================
// Mock ProvenanceService
// ============================================================================

/**
 * Configuration for the mock ProvenanceService.
 *
 * - `verifiableDatasetIds` — DatasetIds for which
 *   `verifyProvenance()` returns true. All other IDs return false.
 *   If not set, `verifyProvenance()` returns `defaultVerifyResult`.
 * - `defaultVerifyResult` — default return for `verifyProvenance()`
 *   when the DatasetId is not in `verifiableDatasetIds`. Default:
 *   false.
 * - `throwOnVerify` — if set, `verifyProvenance()` throws this
 *   error instead of returning.
 */
export interface MockProvenanceConfig {
  readonly verifiableDatasetIds?: ReadonlySet<DatasetId>;
  readonly defaultVerifyResult?: boolean;
  readonly throwOnVerify?: Error;
  readonly quarantineReasons?: ReadonlyMap<DatasetId, string>;
}

/**
 * A mock ProvenanceService for testing INV-D3 / INV-P3 joint
 * enforcement. Only `verifyProvenance` and `quarantineDataset` are
 * meaningfully implemented; other methods return defaults or null.
 *
 * Call tracking:
 * - `verifyCalls` — array of DatasetIds passed to verifyProvenance()
 * - `quarantineCalls` — array of { datasetId, reason } passed to
 *   quarantineDataset()
 */
export function createMockProvenanceService(
  config: MockProvenanceConfig = {},
): ProvenanceService & {
  readonly verifyCalls: DatasetId[];
  readonly quarantineCalls: { readonly datasetId: DatasetId; readonly reason: string }[];
  readonly setVerifiable: (ids: readonly DatasetId[]) => void;
} {
  const verifyCalls: DatasetId[] = [];
  const quarantineCalls: { datasetId: DatasetId; reason: string }[] = [];
  let verifiableIds = config.verifiableDatasetIds
    ? new Set(config.verifiableDatasetIds)
    : new Set<DatasetId>();
  const quarantineReasons = config.quarantineReasons
    ? new Map(config.quarantineReasons)
    : new Map<DatasetId, string>();

  const service: ProvenanceService = {
    async writeProvenanceRecord(_input): Promise<ProvenanceRecord> {
      throw new Error('Not implemented in mock');
    },

    async queryProvenanceRecord(datasetId): Promise<ProvenanceRecord | null> {
      // Return a mock record for verifiable Datasets so the
      // DataManagementService can extract the provenanceRecordId
      // for the DatasetConsumable event.
      if (verifiableIds.has(datasetId)) {
        return {
          id: createProvenanceRecordId(`pr-mock-${datasetId as string}`),
          toolId: createToolId('mock-tool'),
          toolName: 'mock-tool',
          toolVersion: '1.0.0',
          parameters: {},
          environmentId: createEnvironmentId('env-mock'),
          environmentDescription: 'mock environment',
          inputDatasetIds: [],
          outputDatasetId: datasetId,
          exitOutcome: { kind: 'exit_code', code: 0 },
          timestamp: new Date('2026-09-15T12:00:00Z'),
        } as ProvenanceRecord;
      }
      return null;
    },

    async queryProvenanceForJob(_jobId): Promise<ProvenanceRecord | null> {
      return null;
    },

    async queryLineage(_datasetId): Promise<ProvenanceRecord[]> {
      return [];
    },

    async verifyProvenance(datasetId: DatasetId): Promise<boolean> {
      verifyCalls.push(datasetId);
      if (config.throwOnVerify) throw config.throwOnVerify;
      if (verifiableIds.has(datasetId)) return true;
      if (quarantineReasons.has(datasetId)) return false;
      return config.defaultVerifyResult ?? false;
    },

    async reconstructProvenanceRecord(_input): Promise<ProvenanceRecord | null> {
      return null;
    },

    async quarantineDataset(datasetId: DatasetId, reason: string): Promise<void> {
      quarantineCalls.push({ datasetId, reason });
      quarantineReasons.set(datasetId, reason);
    },
  };

  return {
    ...service,
    verifyCalls,
    quarantineCalls,
    setVerifiable: (ids: readonly DatasetId[]) => {
      verifiableIds = new Set(ids);
    },
  };
}

// ============================================================================
// Dataset factory
// ============================================================================

/**
 * Creates a mock Dataset with sensible defaults. The Dataset is
 * frozen (INV-D1) to match the behavior of the real service.
 *
 * Uses `!== undefined` checks (not `??`) so that `null` values are
 * passed through (e.g., `producerToolInvocationId: null` for
 * manually registered Datasets).
 */
export function createMockDataset(overrides: {
  id?: DatasetId;
  name?: string;
  location?: Location;
  format?: Format;
  grid?: Grid;
  variables?: readonly Variable[];
  producerToolInvocationId?: ToolInvocationId | null;
  consumable?: boolean;
  quarantined?: boolean;
  quarantineReason?: string;
  createdAt?: Date;
} = {}): Dataset {
  return Object.freeze({
    id: overrides.id !== undefined ? overrides.id : createDatasetId('ds-test-001'),
    name: overrides.name !== undefined ? overrides.name : 'test_dataset',
    location: overrides.location !== undefined ? overrides.location : createMockLocation(),
    format: overrides.format !== undefined ? overrides.format : 'netcdf',
    grid: overrides.grid !== undefined ? overrides.grid : createMockGrid(),
    variables: overrides.variables !== undefined ? overrides.variables : [createMockVariable()],
    producerToolInvocationId:
      overrides.producerToolInvocationId !== undefined
        ? overrides.producerToolInvocationId
        : null,
    consumable: overrides.consumable !== undefined ? overrides.consumable : false,
    quarantined: overrides.quarantined !== undefined ? overrides.quarantined : false,
    quarantineReason: overrides.quarantineReason,
    createdAt: overrides.createdAt !== undefined ? overrides.createdAt : new Date('2026-09-15T12:00:00Z'),
  });
}

// ============================================================================
// RegisterDatasetInput factory
// ============================================================================

/**
 * Creates a mock RegisterDatasetInput with all fields populated.
 * Individual fields can be overridden for specific test scenarios.
 */
export function createMockRegisterInput(overrides: {
  name?: string;
  location?: Location;
  format?: Format;
  grid?: Grid;
  variables?: readonly Variable[];
  producerToolInvocationId?: ToolInvocationId;
} = {}): import('../../src/data-management/types').RegisterDatasetInput {
  return {
    name: overrides.name ?? 'test_dataset',
    location: overrides.location ?? createMockLocation(),
    format: overrides.format ?? 'netcdf',
    grid: overrides.grid ?? createMockGrid(),
    variables: overrides.variables ?? [createMockVariable()],
    producerToolInvocationId: overrides.producerToolInvocationId,
  };
}

// ============================================================================
// Event collector
// ============================================================================

/**
 * Creates an event collector that captures all DatasetEvents
 * emitted by the service. Provides convenience methods for
 * finding events by kind.
 */
export function createEventCollector(): {
  readonly events: DatasetEvent[];
  readonly handler: (event: DatasetEvent) => void;
  findByKind: (kind: DatasetEvent['kind']) => DatasetEvent[];
} {
  const events: DatasetEvent[] = [];
  return {
    events,
    handler: (event: DatasetEvent) => events.push(event),
    findByKind: (kind: DatasetEvent['kind']) =>
      events.filter((e) => e.kind === kind),
  };
}
