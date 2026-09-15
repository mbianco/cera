/**
 * Unit tests for LineageResolver.
 *
 * Verifies:
 * - Single-hop lineage (direct input → output).
 * - Multi-hop lineage (chain of Datasets).
 * - Cycle detection (prevents infinite traversal).
 * - Missing records (source Datasets with no ProvenanceRecord).
 * - Cross-session persistence (INV-P4 — records are not scoped to
 *   a Session).
 *
 * Spec: api-contracts.md §4 (queryLineage); ADR-009;
 * invariants.md INV-P4.
 */

import { describe, it, expect } from 'vitest';
import { LineageResolver } from '../../src/provenance/lineage-resolver';
import type { RecordLookupFn } from '../../src/provenance/lineage-resolver';
import {
  createDatasetId,
  createMockProvenanceRecord,
} from './helpers';
import type { DatasetId, ProvenanceRecord } from '../../src/types';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a lookup function from a map of Dataset ID →
 * ProvenanceRecord. Returns null for unknown IDs.
 */
function createLookup(
  records: ReadonlyMap<string, ProvenanceRecord>,
): RecordLookupFn {
  return async (datasetId: DatasetId) => {
    const idStr = datasetId as string;
    const record = records.get(idStr);
    if (record === undefined) {
      return null;
    }
    return record;
  };
}

/**
 * Creates a chain of ProvenanceRecords:
 *   ds-source → ds-step1 → ds-step2 → ... → ds-final
 *
 * Each record's inputDatasetIds points to the previous record's
 * outputDatasetId.
 */
function createChain(
  datasetIds: readonly string[],
): ReadonlyMap<string, ProvenanceRecord> {
  const records = new Map<string, ProvenanceRecord>();

  for (let i = 0; i < datasetIds.length; i++) {
    const currentId = datasetIds[i];
    if (currentId === undefined) continue;

    const inputIds: DatasetId[] = [];
    if (i > 0) {
      const prevId = datasetIds[i - 1];
      if (prevId !== undefined) {
        inputIds.push(createDatasetId(prevId));
      }
    }

    const record = createMockProvenanceRecord({
      id: `pr-${currentId}` as never,
      outputDatasetId: createDatasetId(currentId),
      inputDatasetIds: inputIds,
      toolName: i === 0 ? 'source' : `step${i}`,
    });
    records.set(currentId, record);
  }

  return records;
}

// ============================================================================
// Single-hop lineage
// ============================================================================

describe('LineageResolver — single hop', () => {
  it('resolves a single-hop lineage (input → output)', async () => {
    const sourceId = 'ds-source';
    const outputId = 'ds-output';

    const sourceRecord = createMockProvenanceRecord({
      id: 'pr-source' as never,
      outputDatasetId: createDatasetId(sourceId),
      inputDatasetIds: [], // source has no inputs
      toolName: 'source-tool',
    });

    const outputRecord = createMockProvenanceRecord({
      id: 'pr-output' as never,
      outputDatasetId: createDatasetId(outputId),
      inputDatasetIds: [createDatasetId(sourceId)],
      toolName: 'cdo',
    });

    const records = new Map<string, ProvenanceRecord>([
      [sourceId, sourceRecord],
      [outputId, outputRecord],
    ]);

    const resolver = new LineageResolver(createLookup(records));
    const lineage = await resolver.resolve(createDatasetId(outputId));

    expect(lineage).toHaveLength(2);
    expect(lineage[0]?.toolName).toBe('cdo'); // output record first
    expect(lineage[1]?.toolName).toBe('source-tool'); // source record
  });

  it('returns empty array when no record exists for the Dataset', async () => {
    const records = new Map<string, ProvenanceRecord>();
    const resolver = new LineageResolver(createLookup(records));

    const lineage = await resolver.resolve(createDatasetId('ds-nonexistent'));
    expect(lineage).toEqual([]);
  });

  it('returns a single record when the Dataset has no inputs', async () => {
    const sourceRecord = createMockProvenanceRecord({
      id: 'pr-source' as never,
      outputDatasetId: createDatasetId('ds-source'),
      inputDatasetIds: [],
    });

    const records = new Map<string, ProvenanceRecord>([
      ['ds-source', sourceRecord],
    ]);

    const resolver = new LineageResolver(createLookup(records));
    const lineage = await resolver.resolve(createDatasetId('ds-source'));

    expect(lineage).toHaveLength(1);
    expect(lineage[0]?.id).toBe(sourceRecord.id);
  });
});

// ============================================================================
// Multi-hop lineage
// ============================================================================

describe('LineageResolver — multi-hop', () => {
  it('resolves a multi-hop lineage chain', async () => {
    const chain = createChain([
      'tas_historical_2000-2010',
      'tas_only_2000-2010',
      'tas_annual_mean',
      'tas_annual_mean_remapped',
    ]);

    const resolver = new LineageResolver(createLookup(chain));
    const lineage = await resolver.resolve(
      createDatasetId('tas_annual_mean_remapped'),
    );

    expect(lineage).toHaveLength(4);
    // Ordered from the queried Dataset to the original source
    expect(lineage[0]?.outputDatasetId).toBe(
      createDatasetId('tas_annual_mean_remapped'),
    );
    expect(lineage[3]?.outputDatasetId).toBe(
      createDatasetId('tas_historical_2000-2010'),
    );
  });

  it('full chain is traceable from output back to original input', async () => {
    const chain = createChain([
      'input_data',
      'step1_output',
      'step2_output',
      'step3_output',
    ]);

    const resolver = new LineageResolver(createLookup(chain));
    const lineage = await resolver.resolve(createDatasetId('step3_output'));

    // Every Dataset in the chain should be represented
    const outputIds = lineage.map(
      (r) => (r.outputDatasetId ?? '') as string,
    );
    expect(outputIds).toContain('step3_output');
    expect(outputIds).toContain('step2_output');
    expect(outputIds).toContain('step1_output');
    expect(outputIds).toContain('input_data');
  });

  it('stops at a Dataset with no ProvenanceRecord (missing branch)', async () => {
    const outputRecord = createMockProvenanceRecord({
      id: 'pr-output' as never,
      outputDatasetId: createDatasetId('ds-output'),
      inputDatasetIds: [
        createDatasetId('ds-with-record'),
        createDatasetId('ds-without-record'),
      ],
    });

    const withRecord = createMockProvenanceRecord({
      id: 'pr-with-record' as never,
      outputDatasetId: createDatasetId('ds-with-record'),
      inputDatasetIds: [],
    });

    const records = new Map<string, ProvenanceRecord>([
      ['ds-output', outputRecord],
      ['ds-with-record', withRecord],
      // ds-without-record has no record
    ]);

    const resolver = new LineageResolver(createLookup(records));
    const lineage = await resolver.resolve(createDatasetId('ds-output'));

    // Should contain ds-output and ds-with-record, but NOT ds-without-record
    expect(lineage).toHaveLength(2);
    const outputIds = lineage.map(
      (r) => (r.outputDatasetId ?? '') as string,
    );
    expect(outputIds).toContain('ds-output');
    expect(outputIds).toContain('ds-with-record');
  });
});

// ============================================================================
// Cycle detection
// ============================================================================

describe('LineageResolver — cycle detection', () => {
  it('does not enter an infinite loop on a cyclic lineage graph', async () => {
    // Create a cycle: ds-A → ds-B → ds-A
    const recordA = createMockProvenanceRecord({
      id: 'pr-A' as never,
      outputDatasetId: createDatasetId('ds-A'),
      inputDatasetIds: [createDatasetId('ds-B')],
      toolName: 'toolA',
    });

    const recordB = createMockProvenanceRecord({
      id: 'pr-B' as never,
      outputDatasetId: createDatasetId('ds-B'),
      inputDatasetIds: [createDatasetId('ds-A')],
      toolName: 'toolB',
    });

    const records = new Map<string, ProvenanceRecord>([
      ['ds-A', recordA],
      ['ds-B', recordB],
    ]);

    const resolver = new LineageResolver(createLookup(records));
    const lineage = await resolver.resolve(createDatasetId('ds-A'));

    // Should resolve ds-A and ds-B, then detect the cycle back to ds-A
    // and stop. Total: 2 records, not infinite.
    expect(lineage).toHaveLength(2);
  });

  it('handles a diamond dependency without duplication', async () => {
    // Diamond: ds-A → ds-B, ds-A → ds-C, ds-B → ds-D, ds-C → ds-D
    // Resolving ds-D should visit ds-D, ds-B, ds-A, ds-C (A once)
    const recordA = createMockProvenanceRecord({
      id: 'pr-A' as never,
      outputDatasetId: createDatasetId('ds-A'),
      inputDatasetIds: [],
      toolName: 'toolA',
    });

    const recordB = createMockProvenanceRecord({
      id: 'pr-B' as never,
      outputDatasetId: createDatasetId('ds-B'),
      inputDatasetIds: [createDatasetId('ds-A')],
      toolName: 'toolB',
    });

    const recordC = createMockProvenanceRecord({
      id: 'pr-C' as never,
      outputDatasetId: createDatasetId('ds-C'),
      inputDatasetIds: [createDatasetId('ds-A')],
      toolName: 'toolC',
    });

    const recordD = createMockProvenanceRecord({
      id: 'pr-D' as never,
      outputDatasetId: createDatasetId('ds-D'),
      inputDatasetIds: [createDatasetId('ds-B'), createDatasetId('ds-C')],
      toolName: 'toolD',
    });

    const records = new Map<string, ProvenanceRecord>([
      ['ds-A', recordA],
      ['ds-B', recordB],
      ['ds-C', recordC],
      ['ds-D', recordD],
    ]);

    const resolver = new LineageResolver(createLookup(records));
    const lineage = await resolver.resolve(createDatasetId('ds-D'));

    // ds-A should appear only once (visited set prevents duplication)
    const aCount = lineage.filter(
      (r) => (r.outputDatasetId ?? '') as string === 'ds-A',
    ).length;
    expect(aCount).toBe(1);

    // All four records should be in the lineage
    expect(lineage).toHaveLength(4);
  });
});

// ============================================================================
// Cross-session persistence (INV-P4)
// ============================================================================

describe('LineageResolver — cross-session (INV-P4)', () => {
  it('resolves lineage across records from different Sessions', async () => {
    // Simulate: record for ds-step1 was written in Session s1,
    // record for ds-step2 was written in Session s2.
    // The lookup function is not Session-scoped — it queries
    // by Dataset ID regardless of which Session wrote the record.

    const step1Record = createMockProvenanceRecord({
      id: 'pr-step1-s1' as never, // written in Session s1
      outputDatasetId: createDatasetId('ds-step1'),
      inputDatasetIds: [createDatasetId('ds-source')],
      toolName: 'cdo-selname',
    });

    const sourceRecord = createMockProvenanceRecord({
      id: 'pr-source-s1' as never, // written in Session s1
      outputDatasetId: createDatasetId('ds-source'),
      inputDatasetIds: [],
      toolName: 'source',
    });

    const step2Record = createMockProvenanceRecord({
      id: 'pr-step2-s2' as never, // written in Session s2
      outputDatasetId: createDatasetId('ds-step2'),
      inputDatasetIds: [createDatasetId('ds-step1')],
      toolName: 'cdo-timmean',
    });

    const records = new Map<string, ProvenanceRecord>([
      ['ds-step1', step1Record],
      ['ds-source', sourceRecord],
      ['ds-step2', step2Record],
    ]);

    const resolver = new LineageResolver(createLookup(records));
    const lineage = await resolver.resolve(createDatasetId('ds-step2'));

    // All three records should be found, regardless of Session
    expect(lineage).toHaveLength(3);
    expect(lineage[0]?.toolName).toBe('cdo-timmean'); // step2 (s2)
    expect(lineage[1]?.toolName).toBe('cdo-selname'); // step1 (s1)
    expect(lineage[2]?.toolName).toBe('source'); // source (s1)
  });
});
