/**
 * Test helpers for the provenance module.
 *
 * Provides mock FilesystemGateway factories and ProvenanceRecord data
 * factories so tests can verify immutability, full reproducibility
 * tuple, corruption detection, lineage resolution, and quarantine
 * behavior without a real filesystem.
 *
 * Spec: build-phases.md Phase 2 (Tier 1 — unit tests with mock fs).
 */

import type { FilesystemGateway } from '../../src/dsh-adapter/types';
import type {
  CaseId,
  DatasetId,
  EnvironmentId,
  ExitOutcome,
  JobId,
  JobState,
  ProvenanceRecord,
  ProvenanceRecordId,
  ToolId,
} from '../../src/types';

// ============================================================================
// Mock FilesystemGateway (in-memory)
// ============================================================================

/**
 * An in-memory mock FilesystemGateway that simulates filesystem
 * operations. Files are stored as `Map<string, Buffer>`. Directories
 * are implicit — any path is considered a directory if it has files
 * under it.
 *
 * The mock supports:
 * - exists, readFile, writeFile, readDir, mkdir
 * - isReadable, isWritable (always true for existing paths)
 * - stat (returns basic file metadata)
 *
 * Failures can be injected via `failOnWrite` or `failOnRead`.
 */
export function createMockFilesystem(overrides: {
  readonly failOnWrite?: boolean;
  readonly failOnRead?: boolean;
  readonly initialFiles?: ReadonlyMap<string, Buffer>;
} = {}): FilesystemGateway & {
  readonly files: Map<string, Buffer>;
  readonly writeCalls: { path: string; data: Buffer }[];
  readonly readCalls: string[];
  readonly existsCalls: string[];
} {
  const files = new Map<string, Buffer>(
    overrides.initialFiles ? Array.from(overrides.initialFiles) : [],
  );
  const writeCalls: { path: string; data: Buffer }[] = [];
  const readCalls: string[] = [];
  const existsCalls: string[] = [];
  const dirs = new Set<string>();

  const fs: FilesystemGateway = {
    async exists(path: string): Promise<boolean> {
      existsCalls.push(path);
      if (dirs.has(path)) return true;
      // Check if any file starts with this path (directory)
      for (const key of files.keys()) {
        if (key.startsWith(path + '/')) return true;
      }
      return files.has(path);
    },

    async isReadable(_path: string): Promise<boolean> {
      return true;
    },

    async isWritable(_path: string): Promise<boolean> {
      return true;
    },

    async stat(path: string) {
      const data = files.get(path);
      if (data !== undefined) {
        return {
          size: data.length,
          isFile: true,
          isDirectory: false,
          mtime: new Date(),
        };
      }
      // It's a directory (or doesn't exist)
      return {
        size: 0,
        isFile: false,
        isDirectory: dirs.has(path),
        mtime: new Date(),
      };
    },

    async readFile(path: string): Promise<Buffer> {
      readCalls.push(path);
      if (overrides.failOnRead) {
        throw new Error(`Read failed (mock): ${path}`);
      }
      const data = files.get(path);
      if (data === undefined) {
        throw new Error(`ENOENT: no such file: ${path}`);
      }
      return data;
    },

    async writeFile(path: string, data: Buffer): Promise<void> {
      writeCalls.push({ path, data });
      if (overrides.failOnWrite) {
        throw new Error(`Write failed (mock): ${path}`);
      }
      files.set(path, data);
    },

    async readDir(path: string): Promise<string[]> {
      const entries: string[] = [];
      const prefix = path.endsWith('/') ? path : path + '/';
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          // Get the immediate child (not deeper)
          const rest = key.slice(prefix.length);
          const firstSlash = rest.indexOf('/');
          if (firstSlash === -1) {
            entries.push(rest);
          } else if (!entries.includes(rest.slice(0, firstSlash))) {
            const dirName = rest.slice(0, firstSlash);
            if (!entries.includes(dirName)) {
              entries.push(dirName);
            }
          }
        }
      }
      return entries;
    },

    async mkdir(path: string, _recursive?: boolean): Promise<void> {
      dirs.add(path);
    },
  };

  return {
    ...fs,
    files,
    writeCalls,
    readCalls,
    existsCalls,
  };
}

// ============================================================================
// Branded ID factories
// ============================================================================

export function createDatasetId(id: string): DatasetId {
  return id as DatasetId;
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

export function createCaseId(id: string): CaseId {
  return id as CaseId;
}

export function createProvenanceRecordId(id: string): ProvenanceRecordId {
  return id as ProvenanceRecordId;
}

// ============================================================================
// ExitOutcome factory
// ============================================================================

export function createMockExitOutcome(
  overrides: Partial<ExitOutcome> = {},
): ExitOutcome {
  return {
    kind: 'exit_code',
    code: 0,
    ...overrides,
  } as ExitOutcome;
}

// ============================================================================
// ProvenanceRecord factory
// ============================================================================

/**
 * Creates a mock ProvenanceRecord with sensible defaults. The record
 * is frozen (INV-P1) to match the behavior of the real service.
 *
 * Uses `!== undefined` checks (not `??`) so that `null` values are
 * passed through (e.g., `outputDatasetId: null` for failed
 * invocations).
 */
export function createMockProvenanceRecord(overrides: {
  id?: ProvenanceRecordId;
  toolId?: ToolId;
  toolName?: string;
  toolVersion?: string;
  parameters?: Record<string, unknown>;
  environmentId?: EnvironmentId;
  environmentDescription?: string;
  inputDatasetIds?: readonly DatasetId[];
  outputDatasetId?: DatasetId | null;
  exitOutcome?: ExitOutcome;
  timestamp?: Date;
  jobId?: JobId;
  jobState?: JobState;
  caseId?: CaseId;
  correctsRecordId?: ProvenanceRecordId;
  warningFlag?: boolean;
  defective?: boolean;
} = {}): ProvenanceRecord {
  return Object.freeze({
    id: overrides.id !== undefined ? overrides.id : createProvenanceRecordId('pr-test-001'),
    toolId: overrides.toolId !== undefined ? overrides.toolId : createToolId('cdo'),
    toolName: overrides.toolName !== undefined ? overrides.toolName : 'cdo',
    toolVersion: overrides.toolVersion !== undefined ? overrides.toolVersion : '2.0.5',
    parameters: overrides.parameters !== undefined ? overrides.parameters : { operator: '-timmean' },
    environmentId:
      overrides.environmentId !== undefined ? overrides.environmentId : createEnvironmentId('env-cdo-gcc-001'),
    environmentDescription:
      overrides.environmentDescription !== undefined ? overrides.environmentDescription : 'cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4',
    inputDatasetIds: overrides.inputDatasetIds !== undefined ? overrides.inputDatasetIds : [
      createDatasetId('tas_historical_2000-2010'),
    ],
    outputDatasetId: overrides.outputDatasetId !== undefined ? overrides.outputDatasetId : createDatasetId('tas_timmean_2000-2010'),
    exitOutcome: overrides.exitOutcome !== undefined ? overrides.exitOutcome : createMockExitOutcome(),
    timestamp: overrides.timestamp !== undefined ? overrides.timestamp : new Date('2026-09-15T12:00:00Z'),
    jobId: overrides.jobId,
    jobState: overrides.jobState,
    caseId: overrides.caseId,
    correctsRecordId: overrides.correctsRecordId,
    warningFlag: overrides.warningFlag,
    defective: overrides.defective,
  });
}

// ============================================================================
// WriteProvenanceInput factory
// ============================================================================

/**
 * Overrides for createMockWriteInput. Fields can be set to null for
 * MissingField tests. The function returns a WriteProvenanceInput
 * (with type assertion) — the null values are intentional for
 * testing that the service rejects them.
 */
export interface WriteInputOverrides {
  toolId?: ToolId;
  toolName?: string | null;
  toolVersion?: string | null;
  parameters?: Record<string, unknown>;
  environmentId?: EnvironmentId;
  environmentDescription?: string | null;
  inputDatasetIds?: readonly DatasetId[];
  outputDatasetId?: DatasetId | null;
  exitOutcome?: ExitOutcome;
  timestamp?: Date;
  jobId?: JobId;
  jobState?: JobState;
  caseId?: CaseId;
}

/**
 * Creates a mock WriteProvenanceInput with all required fields
 * non-null (INV-P2). Individual fields can be overridden to null
 * for MissingField tests. The return type is WriteProvenanceInput
 * (with type assertion) — null values are intentional for testing
 * that the service rejects them.
 */
export function createMockWriteInput(
  overrides: WriteInputOverrides = {},
): import('../../src/provenance/types').WriteProvenanceInput {
  return {
    toolId: overrides.toolId !== undefined ? overrides.toolId : createToolId('cdo'),
    toolName: overrides.toolName !== undefined ? overrides.toolName : 'cdo',
    toolVersion: overrides.toolVersion !== undefined ? overrides.toolVersion : '2.0.5',
    parameters: overrides.parameters !== undefined ? overrides.parameters : { operator: '-timmean' },
    environmentId:
      overrides.environmentId !== undefined ? overrides.environmentId : createEnvironmentId('env-cdo-gcc-001'),
    environmentDescription:
      overrides.environmentDescription !== undefined ? overrides.environmentDescription : 'cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4',
    inputDatasetIds: overrides.inputDatasetIds !== undefined ? overrides.inputDatasetIds : [
      createDatasetId('tas_historical_2000-2010'),
    ],
    outputDatasetId: overrides.outputDatasetId !== undefined ? overrides.outputDatasetId : createDatasetId('tas_timmean_2000-2010'),
    exitOutcome: overrides.exitOutcome !== undefined ? overrides.exitOutcome : createMockExitOutcome(),
    timestamp: overrides.timestamp !== undefined ? overrides.timestamp : new Date('2026-09-15T12:00:00Z'),
    jobId: overrides.jobId,
    jobState: overrides.jobState,
    caseId: overrides.caseId,
  } as import('../../src/provenance/types').WriteProvenanceInput;
}
