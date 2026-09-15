/**
 * Unit tests for ProvenanceServiceImpl.
 *
 * Verifies all provenance invariants (INV-P1–P4) and all provenance
 * failure modes (FM-P1–P3).
 *
 * INV-P1: ProvenanceRecord is immutable once written.
 * INV-P2: Full reproducibility tuple — all fields non-null.
 * INV-P3: Provenance exists before consumption.
 * INV-P4: ProvenanceRecords persist across Sessions.
 *
 * FM-P1: Write failure — retry with backoff.
 * FM-P2: Corrupted record — local quarantine (R11).
 * FM-P3: Missing record — verifyProvenance returns false.
 *
 * Spec: build-phases.md Phase 2; api-contracts.md §4;
 * invariants.md INV-P1–P4; failure-modes.md FM-P1–P3;
 * resolutions.md R11; ADR-009.
 */

import { describe, it, expect } from 'vitest';
import { ProvenanceServiceImpl } from '../../src/provenance/provenance-service';
import type { ProvenanceServiceImplProps } from '../../src/provenance/provenance-service';
import {
  createMockFilesystem,
  createMockWriteInput,
  createMockProvenanceRecord,
  createDatasetId,
  createEnvironmentId,
  createProvenanceRecordId,
  createToolId,
  createJobId,
} from './helpers';
import {
  MissingField,
  WriteFailed,
} from '../../src/types/errors';
import type {
  ProvenanceEvent,
  ProvenanceRecord,
} from '../../src/types';

// ============================================================================
// Helpers
// ============================================================================

const STORE_PATH = '/test/provenance';

function createService(overrides: {
  filesystem?: ReturnType<typeof createMockFilesystem>;
  config?: Partial<ProvenanceServiceImplProps['config'] extends infer C ? C : never>;
  onEvent?: (event: ProvenanceEvent) => void;
} = {}): {
  service: ProvenanceServiceImpl;
  fs: ReturnType<typeof createMockFilesystem>;
} {
  const fs = overrides.filesystem ?? createMockFilesystem();
  const service = new ProvenanceServiceImpl({
    filesystem: fs,
    config: {
      storePath: STORE_PATH,
      retryInitialDelayMs: 1, // fast for tests
      maxRetries: 2,
      ...overrides.config,
    },
    onEvent: overrides.onEvent,
  });
  return { service, fs };
}

// ============================================================================
// writeProvenanceRecord — INV-P1 (immutability)
// ============================================================================

describe('ProvenanceServiceImpl.writeProvenanceRecord — INV-P1 (immutability)', () => {
  it('returns a frozen ProvenanceRecord', async () => {
    const { service } = createService();

    const record = await service.writeProvenanceRecord(createMockWriteInput());

    expect(Object.isFrozen(record)).toBe(true);
  });

  it('assigns a unique ProvenanceRecordId', async () => {
    const { service } = createService();

    const record1 = await service.writeProvenanceRecord(createMockWriteInput());
    const record2 = await service.writeProvenanceRecord(
      createMockWriteInput({
        outputDatasetId: createDatasetId('ds-002'),
      }),
    );

    expect(record1.id).not.toBe(record2.id);
  });

  it('does not overwrite an existing record (INV-P1)', async () => {
    const { service } = createService();

    const input = createMockWriteInput({
      outputDatasetId: createDatasetId('ds-immutable-001'),
    });

    // Write once
    const record1 = await service.writeProvenanceRecord(input);

    // Query the record
    const queried = await service.queryProvenanceRecord(
      createDatasetId('ds-immutable-001'),
    );

    expect(queried).not.toBeNull();
    expect(queried?.id).toBe(record1.id);
    expect(queried?.toolName).toBe('cdo');
  });

  it('stores the full reproducibility tuple in the record', async () => {
    const { service } = createService();

    const record = await service.writeProvenanceRecord(
      createMockWriteInput({
        toolName: 'cdo',
        toolVersion: '2.0.5',
        parameters: { operator: '-timmean', input: 'data.nc', output: 'out.nc' },
        environmentDescription: 'cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4',
        inputDatasetIds: [createDatasetId('tas_historical_2000-2010')],
        outputDatasetId: createDatasetId('tas_timmean_2000-2010'),
      }),
    );

    expect(record.toolName).toBe('cdo');
    expect(record.toolVersion).toBe('2.0.5');
    expect(record.parameters['operator']).toBe('-timmean');
    expect(record.environmentDescription).toBe(
      'cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4',
    );
    expect(record.inputDatasetIds).toEqual([
      createDatasetId('tas_historical_2000-2010'),
    ]);
    expect(record.outputDatasetId).toEqual(
      createDatasetId('tas_timmean_2000-2010'),
    );
  });

  it('writes a record with null outputDatasetId for failed invocations', async () => {
    const { service } = createService();

    const record = await service.writeProvenanceRecord(
      createMockWriteInput({
        outputDatasetId: null,
        exitOutcome: { kind: 'signal', name: 'SIGSEGV', number: 11 },
      }),
    );

    expect(record.outputDatasetId).toBeNull();
    expect(record.exitOutcome.kind).toBe('signal');
  });

  it('emits a provenance_record_written event on success', async () => {
    const events: ProvenanceEvent[] = [];
    const { service } = createService({
      onEvent: (e) => events.push(e),
    });

    await service.writeProvenanceRecord(createMockWriteInput());

    const writtenEvent = events.find(
      (e) => e.kind === 'provenance_record_written',
    );
    expect(writtenEvent).toBeDefined();
  });
});

// ============================================================================
// writeProvenanceRecord — INV-P2 (full reproducibility tuple)
// ============================================================================

describe('ProvenanceServiceImpl.writeProvenanceRecord — INV-P2 (full tuple)', () => {
  it('throws MissingField when toolId is null', async () => {
    const { service } = createService();

    await expect(
      service.writeProvenanceRecord(
        createMockWriteInput({ toolId: null as never }),
      ),
    ).rejects.toThrow(MissingField);
  });

  it('throws MissingField when toolName is null', async () => {
    const { service } = createService();

    await expect(
      service.writeProvenanceRecord(
        createMockWriteInput({ toolName: null }),
      ),
    ).rejects.toThrow(MissingField);
  });

  it('throws MissingField when toolVersion is null', async () => {
    const { service } = createService();

    await expect(
      service.writeProvenanceRecord(
        createMockWriteInput({ toolVersion: null }),
      ),
    ).rejects.toThrow(MissingField);
  });

  it('throws MissingField when environmentId is null', async () => {
    const { service } = createService();

    await expect(
      service.writeProvenanceRecord(
        createMockWriteInput({ environmentId: null as never }),
      ),
    ).rejects.toThrow(MissingField);
  });

  it('throws MissingField when environmentDescription is null', async () => {
    const { service } = createService();

    await expect(
      service.writeProvenanceRecord(
        createMockWriteInput({ environmentDescription: null }),
      ),
    ).rejects.toThrow(MissingField);
  });

  it('throws MissingField when parameters is null', async () => {
    const { service } = createService();

    await expect(
      service.writeProvenanceRecord(
        createMockWriteInput({ parameters: null as never }),
      ),
    ).rejects.toThrow(MissingField);
  });

  it('throws MissingField when exitOutcome is null', async () => {
    const { service } = createService();

    await expect(
      service.writeProvenanceRecord(
        createMockWriteInput({ exitOutcome: null as never }),
      ),
    ).rejects.toThrow(MissingField);
  });

  it('throws MissingField when timestamp is null', async () => {
    const { service } = createService();

    await expect(
      service.writeProvenanceRecord(
        createMockWriteInput({ timestamp: null as never }),
      ),
    ).rejects.toThrow(MissingField);
  });

  it('throws MissingField when toolName is empty string', async () => {
    const { service } = createService();

    await expect(
      service.writeProvenanceRecord(
        createMockWriteInput({ toolName: '' }),
      ),
    ).rejects.toThrow(MissingField);
  });

  it('does not throw MissingField when outputDatasetId is null (failed invocation)', async () => {
    const { service } = createService();

    const record = await service.writeProvenanceRecord(
      createMockWriteInput({ outputDatasetId: null }),
    );

    expect(record.outputDatasetId).toBeNull();
  });

  it('MissingField error includes the field name', async () => {
    const { service } = createService();

    try {
      await service.writeProvenanceRecord(
        createMockWriteInput({ toolName: null }),
      );
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingField);
      const mf = error as MissingField;
      expect(mf.userMessage).toContain('toolName');
    }
  });
});

// ============================================================================
// writeProvenanceRecord — FM-P1 (write failure)
// ============================================================================

describe('ProvenanceServiceImpl.writeProvenanceRecord — FM-P1 (write failure)', () => {
  it('retries the write with backoff on filesystem failure', async () => {
    // Create a filesystem that fails the first two writes, then succeeds
    let writeCount = 0;
    const fs = createMockFilesystem();
    const realWriteFile = fs.writeFile.bind(fs);
    fs.writeFile = async (path: string, data: Buffer): Promise<void> => {
      writeCount++;
      if (writeCount <= 2) {
        throw new Error('Mock write failure');
      }
      return realWriteFile(path, data);
    };

    const { service } = createService({
      filesystem: fs,
      config: {
        maxRetries: 3,
        retryInitialDelayMs: 1,
        retryBackoffMultiplier: 2,
      },
    });

    const record = await service.writeProvenanceRecord(createMockWriteInput());

    expect(writeCount).toBe(3); // 2 failures + 1 success
    expect(record.toolName).toBe('cdo');
  });

  it('throws WriteFailed after all retries are exhausted', async () => {
    const fs = createMockFilesystem({ failOnWrite: true });
    const { service } = createService({
      filesystem: fs,
      config: {
        maxRetries: 2,
        retryInitialDelayMs: 1,
        retryBackoffMultiplier: 2,
      },
    });

    await expect(
      service.writeProvenanceRecord(createMockWriteInput()),
    ).rejects.toThrow(WriteFailed);
  });

  it('WriteFailed error includes retry count', async () => {
    const fs = createMockFilesystem({ failOnWrite: true });
    const { service } = createService({
      filesystem: fs,
      config: {
        maxRetries: 2,
        retryInitialDelayMs: 1,
      },
    });

    try {
      await service.writeProvenanceRecord(createMockWriteInput());
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WriteFailed);
      const wf = error as WriteFailed;
      expect(wf.userMessage).toContain('retries');
    }
  });
});

// ============================================================================
// queryProvenanceRecord — INV-P4 (persists across Sessions)
// ============================================================================

describe('ProvenanceServiceImpl.queryProvenanceRecord — INV-P4', () => {
  it('returns the ProvenanceRecord for a Dataset', async () => {
    const { service } = createService();

    const outputDatasetId = createDatasetId('ds-query-001');
    await service.writeProvenanceRecord(
      createMockWriteInput({ outputDatasetId }),
    );

    const record = await service.queryProvenanceRecord(outputDatasetId);

    expect(record).not.toBeNull();
    expect(record?.outputDatasetId).toEqual(outputDatasetId);
  });

  it('returns null if no record exists for the Dataset', async () => {
    const { service } = createService();

    const record = await service.queryProvenanceRecord(
      createDatasetId('ds-nonexistent'),
    );

    expect(record).toBeNull();
  });

  it('records persist across Sessions — same service instance (INV-P4)', async () => {
    const fs = createMockFilesystem();

    // Session s1: write a record
    const service1 = new ProvenanceServiceImpl({
      filesystem: fs,
      config: { storePath: STORE_PATH, retryInitialDelayMs: 1 },
    });

    const outputId = createDatasetId('ds-cross-session-001');
    await service1.writeProvenanceRecord(
      createMockWriteInput({ outputDatasetId: outputId }),
    );

    // Session s2: query the record (same filesystem, new service instance)
    const service2 = new ProvenanceServiceImpl({
      filesystem: fs,
      config: { storePath: STORE_PATH, retryInitialDelayMs: 1 },
    });

    const record = await service2.queryProvenanceRecord(outputId);

    expect(record).not.toBeNull();
    expect(record?.outputDatasetId).toEqual(outputId);
    expect(record?.toolName).toBe('cdo');
  });

  it('returns null for a quarantined Dataset', async () => {
    const { service } = createService();

    const outputId = createDatasetId('ds-quarantined-query');
    await service.writeProvenanceRecord(
      createMockWriteInput({ outputDatasetId: outputId }),
    );
    await service.quarantineDataset(outputId, 'corrupted');

    const record = await service.queryProvenanceRecord(outputId);

    expect(record).toBeNull();
  });
});

// ============================================================================
// queryProvenanceForJob — INV-P4
// ============================================================================

describe('ProvenanceServiceImpl.queryProvenanceForJob — INV-P4', () => {
  it('returns the ProvenanceRecord for a Job', async () => {
    const { service } = createService();

    const jobId = createJobId(4827365);
    await service.writeProvenanceRecord(
      createMockWriteInput({
        jobId,
        jobState: 'COMPLETED',
        outputDatasetId: createDatasetId('ds-job-001'),
      }),
    );

    const record = await service.queryProvenanceForJob(jobId);

    expect(record).not.toBeNull();
    expect(record?.jobId).toEqual(jobId);
    expect(record?.jobState).toBe('COMPLETED');
  });

  it('returns null if no record exists for the Job', async () => {
    const { service } = createService();

    const record = await service.queryProvenanceForJob(createJobId(9999999));

    expect(record).toBeNull();
  });
});

// ============================================================================
// queryLineage — INV-P4 (cross-session lineage)
// ============================================================================

describe('ProvenanceServiceImpl.queryLineage — INV-P4', () => {
  it('resolves the full lineage chain for a Dataset', async () => {
    const { service } = createService();

    // Write a chain: ds-source → ds-step1 → ds-step2
    await service.writeProvenanceRecord(
      createMockWriteInput({
        outputDatasetId: createDatasetId('ds-source'),
        inputDatasetIds: [],
        toolName: 'source-tool',
      }),
    );

    await service.writeProvenanceRecord(
      createMockWriteInput({
        outputDatasetId: createDatasetId('ds-step1'),
        inputDatasetIds: [createDatasetId('ds-source')],
        toolName: 'cdo-selname',
      }),
    );

    await service.writeProvenanceRecord(
      createMockWriteInput({
        outputDatasetId: createDatasetId('ds-step2'),
        inputDatasetIds: [createDatasetId('ds-step1')],
        toolName: 'cdo-timmean',
      }),
    );

    const lineage = await service.queryLineage(
      createDatasetId('ds-step2'),
    );

    expect(lineage).toHaveLength(3);
    expect(lineage[0]?.toolName).toBe('cdo-timmean');
    expect(lineage[1]?.toolName).toBe('cdo-selname');
    expect(lineage[2]?.toolName).toBe('source-tool');
  });

  it('returns empty array if no record exists for the Dataset', async () => {
    const { service } = createService();

    const lineage = await service.queryLineage(
      createDatasetId('ds-nonexistent'),
    );

    expect(lineage).toEqual([]);
  });

  it('resolves lineage across records from different Sessions (INV-P4)', async () => {
    const fs = createMockFilesystem();

    // Session s1: write source and step1
    const service1 = new ProvenanceServiceImpl({
      filesystem: fs,
      config: { storePath: STORE_PATH, retryInitialDelayMs: 1 },
    });

    await service1.writeProvenanceRecord(
      createMockWriteInput({
        outputDatasetId: createDatasetId('ds-source-s1'),
        inputDatasetIds: [],
        toolName: 'source',
      }),
    );

    await service1.writeProvenanceRecord(
      createMockWriteInput({
        outputDatasetId: createDatasetId('ds-step1-s1'),
        inputDatasetIds: [createDatasetId('ds-source-s1')],
        toolName: 'cdo-selname',
      }),
    );

    // Session s2: write step2 and query lineage
    const service2 = new ProvenanceServiceImpl({
      filesystem: fs,
      config: { storePath: STORE_PATH, retryInitialDelayMs: 1 },
    });

    await service2.writeProvenanceRecord(
      createMockWriteInput({
        outputDatasetId: createDatasetId('ds-step2-s2'),
        inputDatasetIds: [createDatasetId('ds-step1-s1')],
        toolName: 'cdo-timmean',
      }),
    );

    const lineage = await service2.queryLineage(
      createDatasetId('ds-step2-s2'),
    );

    expect(lineage).toHaveLength(3);
    // Records from s1 are queryable in s2
    expect(lineage[2]?.toolName).toBe('source');
  });
});

// ============================================================================
// verifyProvenance — INV-P3 (Provenance before consumption)
// ============================================================================

describe('ProvenanceServiceImpl.verifyProvenance — INV-P3', () => {
  it('returns true when a valid ProvenanceRecord exists', async () => {
    const { service } = createService();

    const outputId = createDatasetId('ds-verifiable-001');
    await service.writeProvenanceRecord(
      createMockWriteInput({ outputDatasetId: outputId }),
    );

    const result = await service.verifyProvenance(outputId);
    expect(result).toBe(true);
  });

  it('returns false when no ProvenanceRecord exists (FM-P3)', async () => {
    const { service } = createService();

    const result = await service.verifyProvenance(
      createDatasetId('ds-no-provenance'),
    );
    expect(result).toBe(false);
  });

  it('returns false when the Dataset is quarantined', async () => {
    const { service } = createService();

    const outputId = createDatasetId('ds-quarantined-verify');
    await service.writeProvenanceRecord(
      createMockWriteInput({ outputDatasetId: outputId }),
    );
    await service.quarantineDataset(outputId, 'corrupted');

    const result = await service.verifyProvenance(outputId);
    expect(result).toBe(false);
  });

  it('a Dataset without Provenance cannot be consumed (INV-P3)', async () => {
    const { service } = createService();

    // No record written for this Dataset
    const result = await service.verifyProvenance(
      createDatasetId('unprovenanced_data'),
    );

    // verifyProvenance returns false — the Dataset is NOT consumable
    expect(result).toBe(false);
  });
});

// ============================================================================
// quarantineDataset — R11 (local, not systemic)
// ============================================================================

describe('ProvenanceServiceImpl.quarantineDataset — R11', () => {
  it('quarantines a single Dataset', async () => {
    const { service } = createService();

    const datasetId = createDatasetId('ds-to-quarantine');
    await service.quarantineDataset(datasetId, 'corrupted record');

    // The Dataset should no longer pass verifyProvenance
    const result = await service.verifyProvenance(datasetId);
    expect(result).toBe(false);
  });

  it('quarantining one Dataset does not affect others (R11: local)', async () => {
    const { service } = createService();

    const ds1 = createDatasetId('ds-001');
    const ds2 = createDatasetId('ds-002');

    await service.writeProvenanceRecord(
      createMockWriteInput({ outputDatasetId: ds1 }),
    );
    await service.writeProvenanceRecord(
      createMockWriteInput({ outputDatasetId: ds2 }),
    );

    // Quarantine ds-001
    await service.quarantineDataset(ds1, 'corrupted');

    // ds-002 is still verifiable
    const ds2Result = await service.verifyProvenance(ds2);
    expect(ds2Result).toBe(true);

    // ds-001 is not verifiable
    const ds1Result = await service.verifyProvenance(ds1);
    expect(ds1Result).toBe(false);
  });

  it('emits a provenance_dataset_quarantined event', async () => {
    const events: ProvenanceEvent[] = [];
    const { service } = createService({ onEvent: (e) => events.push(e) });

    await service.quarantineDataset(
      createDatasetId('ds-event-001'),
      'test quarantine',
    );

    const quarantineEvent = events.find(
      (e) => e.kind === 'provenance_dataset_quarantined',
    );
    expect(quarantineEvent).toBeDefined();
  });
});

// ============================================================================
// reconstructProvenanceRecord — FM-P2
// ============================================================================

describe('ProvenanceServiceImpl.reconstructProvenanceRecord — FM-P2', () => {
  it('reconstructs a record from a partial record', async () => {
    const { service } = createService();

    const partialRecord: Partial<ProvenanceRecord> = createMockProvenanceRecord(
      {
        toolName: 'cdo',
        toolVersion: '2.0.5',
        parameters: { operator: '-timmean' },
        environmentDescription: 'cdo/2.0.5 gcc/11.2.0',
        inputDatasetIds: [createDatasetId('ds-input-001')],
        exitOutcome: { kind: 'exit_code', code: 0 },
        timestamp: new Date('2026-09-15T12:00:00Z'),
        environmentId: createEnvironmentId('env-001'),
        toolId: createToolId('cdo'),
        outputDatasetId: createDatasetId('ds-reconstruct-001'),
      },
    );

    const result = await service.reconstructProvenanceRecord({
      datasetId: createDatasetId('ds-reconstruct-001'),
      availableMetadata: { partialRecord },
    });

    expect(result).not.toBeNull();
    expect(result?.toolName).toBe('cdo');
    expect(result?.toolVersion).toBe('2.0.5');
    expect(result?.defective).toBe(true); // reconstructed records are flagged
  });

  it('reconstructs a record from environment state', async () => {
    const { service } = createService();

    const env: ProvenanceRecord['environmentId'] extends infer _E
      ? {
          readonly id: ReturnType<typeof createEnvironmentId>;
          readonly uenvSpecs: readonly { readonly name: string; readonly version: string; readonly mountPath: string }[];
          readonly modules: readonly { readonly name: string; readonly version: string; readonly prefix: string }[];
          readonly compilerStack?: unknown;
          readonly conflictFree: boolean;
          readonly active: boolean;
          readonly loadedAt: Date;
        }
      : never = {
      id: createEnvironmentId('env-reconstruct-001'),
      uenvSpecs: [],
      modules: [
        { name: 'cdo', version: '2.0.5', prefix: '/usr' },
        { name: 'gcc', version: '11.2.0', prefix: '/usr' },
      ],
      conflictFree: true,
      active: true,
      loadedAt: new Date('2026-09-15T10:00:00Z'),
    } as never;

    const partialRecord: Partial<ProvenanceRecord> = {
      toolName: 'cdo',
      toolVersion: '2.0.5',
      parameters: { operator: '-timmean' },
      inputDatasetIds: [],
      exitOutcome: { kind: 'exit_code', code: 0 },
      timestamp: new Date('2026-09-15T12:00:00Z'),
      toolId: createToolId('cdo'),
      // environmentId and environmentDescription will be filled from env
    };

    const result = await service.reconstructProvenanceRecord({
      datasetId: createDatasetId('ds-reconstruct-002'),
      availableMetadata: {
        partialRecord,
        environmentState: env as unknown as import('../../src/types').Environment,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.environmentDescription).toContain('cdo/2.0.5');
    expect(result?.environmentDescription).toContain('gcc/11.2.0');
  });

  it('returns null when reconstruction cannot produce a complete record', async () => {
    const { service } = createService();

    // Only toolName is available — too many fields missing
    const partialRecord: Partial<ProvenanceRecord> = {
      toolName: 'cdo',
    };

    const result = await service.reconstructProvenanceRecord({
      datasetId: createDatasetId('ds-incomplete-001'),
      availableMetadata: { partialRecord },
    });

    expect(result).toBeNull();
  });

  it('links the reconstructed record to the original via correctsRecordId', async () => {
    const { service } = createService();

    const originalId = createProvenanceRecordId('pr-original-001');
    const partialRecord: Partial<ProvenanceRecord> = createMockProvenanceRecord(
      {
        id: originalId,
        toolName: 'cdo',
        toolVersion: '2.0.5',
        parameters: { operator: '-timmean' },
        environmentDescription: 'cdo/2.0.5',
        inputDatasetIds: [],
        exitOutcome: { kind: 'exit_code', code: 0 },
        timestamp: new Date('2026-09-15T12:00:00Z'),
        environmentId: createEnvironmentId('env-001'),
        toolId: createToolId('cdo'),
        outputDatasetId: createDatasetId('ds-reconstruct-003'),
      },
    );

    const result = await service.reconstructProvenanceRecord({
      datasetId: createDatasetId('ds-reconstruct-003'),
      availableMetadata: { partialRecord },
    });

    expect(result).not.toBeNull();
    expect(result?.correctsRecordId).toBe(originalId);
  });
});

// ============================================================================
// Interface stability
// ============================================================================

describe('ProvenanceServiceImpl — interface stability', () => {
  it('does not expose the raw FilesystemGateway', () => {
    const { service } = createService();

    const obj = service as unknown as Record<string, unknown>;
    expect(obj.filesystem).toBeUndefined();
    expect(obj.fs).toBeUndefined();
    expect(obj.store).toBeUndefined();
  });

  it('implements all ProvenanceService methods', () => {
    const { service } = createService();

    expect(typeof service.writeProvenanceRecord).toBe('function');
    expect(typeof service.queryProvenanceRecord).toBe('function');
    expect(typeof service.queryProvenanceForJob).toBe('function');
    expect(typeof service.queryLineage).toBe('function');
    expect(typeof service.verifyProvenance).toBe('function');
    expect(typeof service.reconstructProvenanceRecord).toBe('function');
    expect(typeof service.quarantineDataset).toBe('function');
  });
});
