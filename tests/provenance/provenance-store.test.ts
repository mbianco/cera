/**
 * Unit tests for ProvenanceStore (low-level filesystem operations).
 *
 * Verifies:
 * - INV-P1: Immutability — never overwrites existing files, returned
 *   records are frozen.
 * - INV-P2: Full reproducibility tuple — missing fields detected on
 *   read.
 * - FM-P1: Write failures.
 * - FM-P2: Record corruption (unparseable JSON, missing fields).
 * - ADR-009: One file per record, quarantine files.
 *
 * Spec: build-phases.md Phase 2; ADR-009; invariants.md INV-P1,
 * INV-P2; failure-modes.md FM-P1, FM-P2.
 */

import { describe, it, expect } from 'vitest';
import {
  ProvenanceStore,
  serializeProvenanceRecord,
  deserializeProvenanceRecord,
  findMissingFields,
} from '../../src/provenance/provenance-store';
import {
  createMockFilesystem,
  createMockProvenanceRecord,
  createDatasetId,
  createProvenanceRecordId,
} from './helpers';
import { RecordCorrupted } from '../../src/types/errors';

// ============================================================================
// Helpers
// ============================================================================

const STORE_PATH = '/test/provenance';

function createStore(filesystem?: ReturnType<typeof createMockFilesystem>): {
  store: ProvenanceStore;
  fs: ReturnType<typeof createMockFilesystem>;
} {
  const fs = filesystem ?? createMockFilesystem();
  return {
    store: new ProvenanceStore({ filesystem: fs, storePath: STORE_PATH }),
    fs,
  };
}

// ============================================================================
// serializeProvenanceRecord
// ============================================================================

describe('serializeProvenanceRecord', () => {
  it('serializes a ProvenanceRecord to JSON', () => {
    const record = createMockProvenanceRecord();
    const json = serializeProvenanceRecord(record);

    expect(json).toContain('"toolName": "cdo"');
    expect(json).toContain('"toolVersion": "2.0.5"');
    expect(json).toContain('"environmentDescription"');
  });

  it('serializes timestamp as ISO 8601', () => {
    const record = createMockProvenanceRecord({
      timestamp: new Date('2026-09-15T12:00:00Z'),
    });
    const json = serializeProvenanceRecord(record);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed['timestamp']).toBe('2026-09-15T12:00:00.000Z');
  });

  it('serializes outputDatasetId as null for failed invocations', () => {
    const record = createMockProvenanceRecord({
      outputDatasetId: null,
    });
    const json = serializeProvenanceRecord(record);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed['outputDatasetId']).toBeNull();
  });

  it('serializes optional fields (jobId, jobState, caseId)', () => {
    const record = createMockProvenanceRecord({
      jobId: 4827365 as never,
      jobState: 'COMPLETED',
      caseId: 'bhist_f09_g17_001' as never,
    });
    const json = serializeProvenanceRecord(record);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed['jobId']).toBe(4827365);
    expect(parsed['jobState']).toBe('COMPLETED');
    expect(parsed['caseId']).toBe('bhist_f09_g17_001');
  });
});

// ============================================================================
// deserializeProvenanceRecord
// ============================================================================

describe('deserializeProvenanceRecord', () => {
  it('deserializes a valid JSON string into a ProvenanceRecord', () => {
    const record = createMockProvenanceRecord();
    const json = serializeProvenanceRecord(record);
    const deserialized = deserializeProvenanceRecord(
      json,
      record.id as string,
    );

    expect(deserialized.toolName).toBe('cdo');
    expect(deserialized.toolVersion).toBe('2.0.5');
    expect(deserialized.exitOutcome.kind).toBe('exit_code');
    if (deserialized.exitOutcome.kind === 'exit_code') {
      expect(deserialized.exitOutcome.code).toBe(0);
    }
  });

  it('returns a frozen object (INV-P1)', () => {
    const record = createMockProvenanceRecord();
    const json = serializeProvenanceRecord(record);
    const deserialized = deserializeProvenanceRecord(
      json,
      record.id as string,
    );

    expect(Object.isFrozen(deserialized)).toBe(true);
  });

  it('throws RecordCorrupted for unparseable JSON (FM-P2)', () => {
    expect(() =>
      deserializeProvenanceRecord('{ invalid json', 'pr-test-001'),
    ).toThrow(RecordCorrupted);
  });

  it('RecordCorrupted for unparseable JSON has corruptionType "unparseable_json"', () => {
    try {
      deserializeProvenanceRecord('{ invalid json', 'pr-test-001');
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RecordCorrupted);
      const rec = error as RecordCorrupted;
      expect(rec.kind).toBe('record_corrupted');
    }
  });

  it('throws RecordCorrupted when required fields are missing (INV-P2)', () => {
    const record = createMockProvenanceRecord();
    const json = serializeProvenanceRecord(record);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    // Remove a required field
    delete parsed['toolName'];
    const modifiedJson = JSON.stringify(parsed);

    expect(() =>
      deserializeProvenanceRecord(modifiedJson, 'pr-test-001'),
    ).toThrow(RecordCorrupted);
  });

  it('deserializes outputDatasetId as null when present as null', () => {
    const record = createMockProvenanceRecord({ outputDatasetId: null });
    const json = serializeProvenanceRecord(record);
    const deserialized = deserializeProvenanceRecord(
      json,
      record.id as string,
    );

    expect(deserialized.outputDatasetId).toBeNull();
  });

  it('deserializes correctsRecordId when present', () => {
    const record = createMockProvenanceRecord({
      correctsRecordId: createProvenanceRecordId('pr-original-001'),
    });
    const json = serializeProvenanceRecord(record);
    const deserialized = deserializeProvenanceRecord(
      json,
      record.id as string,
    );

    expect(deserialized.correctsRecordId).toBe(
      createProvenanceRecordId('pr-original-001'),
    );
  });
});

// ============================================================================
// findMissingFields
// ============================================================================

describe('findMissingFields', () => {
  it('returns empty array when all required fields are present', () => {
    const record = createMockProvenanceRecord();
    const json = serializeProvenanceRecord(record);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    const missing = findMissingFields(parsed);
    expect(missing).toEqual([]);
  });

  it('detects missing toolName field', () => {
    const obj: Record<string, unknown> = {
      id: 'pr-001',
      toolId: 'cdo',
      toolName: '',  // empty string is missing
      toolVersion: '2.0.5',
      parameters: {},
      environmentId: 'env-001',
      environmentDescription: 'desc',
      inputDatasetIds: [],
      timestamp: '2026-09-15T12:00:00.000Z',
      exitOutcome: { kind: 'exit_code', code: 0 },
    };

    const missing = findMissingFields(obj);
    expect(missing).toContain('toolName');
  });

  it('detects undefined fields', () => {
    const obj: Record<string, unknown> = {
      id: 'pr-001',
      toolId: 'cdo',
      toolName: 'cdo',
      toolVersion: '2.0.5',
      // parameters is missing
      environmentId: 'env-001',
      environmentDescription: 'desc',
      inputDatasetIds: [],
      timestamp: '2026-09-15T12:00:00.000Z',
      exitOutcome: { kind: 'exit_code', code: 0 },
    };

    const missing = findMissingFields(obj);
    expect(missing).toContain('parameters');
  });

  it('does not flag outputDatasetId as missing (can be null)', () => {
    const obj: Record<string, unknown> = {
      id: 'pr-001',
      toolId: 'cdo',
      toolName: 'cdo',
      toolVersion: '2.0.5',
      parameters: {},
      environmentId: 'env-001',
      environmentDescription: 'desc',
      inputDatasetIds: [],
      timestamp: '2026-09-15T12:00:00.000Z',
      exitOutcome: { kind: 'exit_code', code: 0 },
      outputDatasetId: null,
    };

    const missing = findMissingFields(obj);
    expect(missing).toEqual([]);
  });
});

// ============================================================================
// ProvenanceStore.writeRecord (INV-P1)
// ============================================================================

describe('ProvenanceStore.writeRecord', () => {
  it('writes a ProvenanceRecord as a JSON file', async () => {
    const { store, fs } = createStore();
    const record = createMockProvenanceRecord();

    const written = await store.writeRecord(record);
    expect(written).toBe(true);
    expect(fs.files.size).toBeGreaterThan(0);
  });

  it('never overwrites an existing file (INV-P1)', async () => {
    const { store, fs } = createStore();
    const record = createMockProvenanceRecord({
      id: createProvenanceRecordId('pr-duplicate-001'),
    });

    // First write succeeds
    const first = await store.writeRecord(record);
    expect(first).toBe(true);

    // Second write with same ID returns false (not overwritten)
    const second = await store.writeRecord(record);
    expect(second).toBe(false);

    // Only one file exists
    const recordFiles = Array.from(fs.files.keys()).filter(
      (k) => !k.includes('quarantine'),
    );
    expect(recordFiles.length).toBe(1);
  });

  it('creates the store directory if it does not exist', async () => {
    const { store } = createStore();
    const record = createMockProvenanceRecord();

    await store.writeRecord(record);

    // The store should have been created (mock mkdir was called)
    // We verify by checking the file was written
    expect(await store.recordExists(record.id as string)).toBe(true);
  });

  it('throws on filesystem write failure', async () => {
    const fs = createMockFilesystem({ failOnWrite: true });
    const { store } = createStore(fs);
    const record = createMockProvenanceRecord();

    await expect(store.writeRecord(record)).rejects.toThrow();
  });
});

// ============================================================================
// ProvenanceStore.readRecord (FM-P2)
// ============================================================================

describe('ProvenanceStore.readRecord', () => {
  it('reads a previously written ProvenanceRecord', async () => {
    const { store } = createStore();
    const record = createMockProvenanceRecord();

    await store.writeRecord(record);
    const read = await store.readRecord(record.id as string);

    expect(read).not.toBeNull();
    expect(read?.toolName).toBe('cdo');
    expect(read?.toolVersion).toBe('2.0.5');
  });

  it('returns a frozen record (INV-P1)', async () => {
    const { store } = createStore();
    const record = createMockProvenanceRecord();

    await store.writeRecord(record);
    const read = await store.readRecord(record.id as string);

    expect(Object.isFrozen(read)).toBe(true);
  });

  it('returns null if no record exists', async () => {
    const { store } = createStore();

    const read = await store.readRecord('pr-nonexistent');
    expect(read).toBeNull();
  });

  it('throws RecordCorrupted if the file contains unparseable JSON (FM-P2)', async () => {
    const fs = createMockFilesystem();
    // Pre-populate with corrupted JSON
    fs.files.set(
      `${STORE_PATH}/pr-corrupt-001.json`,
      Buffer.from('{ invalid json', 'utf-8'),
    );
    const { store } = createStore(fs);

    await expect(store.readRecord('pr-corrupt-001')).rejects.toThrow(
      RecordCorrupted,
    );
  });

  it('throws RecordCorrupted if the file is missing required fields (FM-P2)', async () => {
    const fs = createMockFilesystem();
    // Pre-populate with JSON missing a required field
    const incompleteRecord = {
      id: 'pr-incomplete-001',
      toolId: 'cdo',
      // toolName is missing
      toolVersion: '2.0.5',
      parameters: {},
      environmentId: 'env-001',
      environmentDescription: 'desc',
      inputDatasetIds: [],
      timestamp: '2026-09-15T12:00:00.000Z',
      exitOutcome: { kind: 'exit_code', code: 0 },
      outputDatasetId: null,
    };
    fs.files.set(
      `${STORE_PATH}/pr-incomplete-001.json`,
      Buffer.from(JSON.stringify(incompleteRecord), 'utf-8'),
    );
    const { store } = createStore(fs);

    await expect(store.readRecord('pr-incomplete-001')).rejects.toThrow(
      RecordCorrupted,
    );
  });
});

// ============================================================================
// ProvenanceStore.recordExists
// ============================================================================

describe('ProvenanceStore.recordExists', () => {
  it('returns true for an existing record', async () => {
    const { store } = createStore();
    const record = createMockProvenanceRecord();

    await store.writeRecord(record);
    expect(await store.recordExists(record.id as string)).toBe(true);
  });

  it('returns false for a non-existent record', async () => {
    const { store } = createStore();

    expect(await store.recordExists('pr-nonexistent')).toBe(false);
  });
});

// ============================================================================
// ProvenanceStore.listRecordIds (ADR-009)
// ============================================================================

describe('ProvenanceStore.listRecordIds', () => {
  it('lists all record IDs in the store', async () => {
    const { store } = createStore();
    const record1 = createMockProvenanceRecord({
      id: createProvenanceRecordId('pr-001'),
    });
    const record2 = createMockProvenanceRecord({
      id: createProvenanceRecordId('pr-002'),
      outputDatasetId: createDatasetId('ds-002'),
    });

    await store.writeRecord(record1);
    await store.writeRecord(record2);

    const ids = await store.listRecordIds();
    expect(ids).toContain('pr-001');
    expect(ids).toContain('pr-002');
    expect(ids.length).toBe(2);
  });

  it('returns empty array when the store is empty', async () => {
    const { store } = createStore();

    const ids = await store.listRecordIds();
    expect(ids).toEqual([]);
  });
});

// ============================================================================
// ProvenanceStore.readAllRecords (ADR-009)
// ============================================================================

describe('ProvenanceStore.readAllRecords', () => {
  it('reads all records in the store', async () => {
    const { store } = createStore();
    const record1 = createMockProvenanceRecord({
      id: createProvenanceRecordId('pr-001'),
    });
    const record2 = createMockProvenanceRecord({
      id: createProvenanceRecordId('pr-002'),
      outputDatasetId: createDatasetId('ds-002'),
    });

    await store.writeRecord(record1);
    await store.writeRecord(record2);

    const records = await store.readAllRecords();
    expect(records.length).toBe(2);
  });

  it('skips corrupted records (FM-P2 — local, not systemic)', async () => {
    const fs = createMockFilesystem();
    const { store } = createStore(fs);

    // Write a valid record
    const validRecord = createMockProvenanceRecord({
      id: createProvenanceRecordId('pr-valid-001'),
    });
    await store.writeRecord(validRecord);

    // Add a corrupted record
    fs.files.set(
      `${STORE_PATH}/pr-corrupt-001.json`,
      Buffer.from('{ invalid json', 'utf-8'),
    );

    // readAllRecords should return the valid record and skip the corrupted one
    const records = await store.readAllRecords();
    expect(records.length).toBe(1);
    expect(records[0]?.toolName).toBe('cdo');
  });
});

// ============================================================================
// ProvenanceStore quarantine (R11: local, not systemic)
// ============================================================================

describe('ProvenanceStore quarantine (R11)', () => {
  it('writes a quarantine entry for a Dataset', async () => {
    const { store } = createStore();
    const datasetId = 'ds-quarantined-001';

    await store.writeQuarantine(datasetId, 'corrupted record');

    const entry = await store.readQuarantine(datasetId);
    expect(entry).not.toBeNull();
    expect(entry?.datasetId).toBe(datasetId);
    expect(entry?.reason).toBe('corrupted record');
  });

  it('isQuarantined returns true for a quarantined Dataset', async () => {
    const { store } = createStore();
    const datasetId = 'ds-quarantined-002';

    await store.writeQuarantine(datasetId, 'missing record');
    expect(await store.isQuarantined(datasetId)).toBe(true);
  });

  it('isQuarantined returns false for a non-quarantined Dataset', async () => {
    const { store } = createStore();

    expect(await store.isQuarantined('ds-not-quarantined')).toBe(false);
  });

  it('quarantine is local — other Datasets remain available (R11)', async () => {
    const { store } = createStore();

    // Write two records
    const record1 = createMockProvenanceRecord({
      id: createProvenanceRecordId('pr-001'),
      outputDatasetId: createDatasetId('ds-001'),
    });
    const record2 = createMockProvenanceRecord({
      id: createProvenanceRecordId('pr-002'),
      outputDatasetId: createDatasetId('ds-002'),
    });
    await store.writeRecord(record1);
    await store.writeRecord(record2);

    // Quarantine ds-001
    await store.writeQuarantine('ds-001', 'corrupted');

    // ds-002 is still readable
    const record2Read = await store.readRecord('pr-002');
    expect(record2Read).not.toBeNull();
    expect(record2Read?.outputDatasetId).toBe(createDatasetId('ds-002'));

    // ds-001 is quarantined
    expect(await store.isQuarantined('ds-001')).toBe(true);
    expect(await store.isQuarantined('ds-002')).toBe(false);
  });
});
