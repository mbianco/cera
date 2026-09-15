## Finding: Provenance write + markConsumable ordering has no retry or transactional guarantee
Severity: High
Category: Robustness > Error handling quality
Location: specs/architecture/api-contracts.md (lines 540–607, invokeTool; lines 466–475, markConsumable; lines 343–410, writeProvenanceRecord); specs/architecture/adr/ADR-009.md (lines 83–87, no cross-record transactional integrity)
Spec reference: invariants.md INV-D3, INV-P3; ADR-009

### Description

The `invokeTool()` contract (api-contracts.md lines 556–559)
describes the post-execution sequence:

"6. Complete/Fail: record ExitOutcome (INV-T2, INV-T5). If
   success (exit code 0, or in permissiveExitCodes — R4): write
   ProvenanceRecord (X4), register output Dataset via
   data-management, mark consumable."

This is a three-step sequence:
1. `provenance.writeProvenanceRecord()` — creates the record
2. `data-management.registerDataset()` — creates Dataset in
   "pending" state
3. `data-management.markConsumable()` — verifies Provenance,
   marks as available

ADR-009 explicitly states: "The store is **not transactional**
across records. There is no guarantee that a multi-Dataset
ToolInvocation writes all its ProvenanceRecords atomically."

If step 3 (`markConsumable()`) fails after steps 1 and 2 succeed
(e.g., filesystem error, process crash), the Dataset is registered
in "pending" state with a valid ProvenanceRecord, but is **not
consumable**. The `invokeTool()` API has no documented retry
mechanism for `markConsumable()` failures — it returns a
`ToolInvocationResult` with the ProvenanceRecord, implying the
operation is complete.

If step 1 succeeds but step 2 fails, the ProvenanceRecord exists
for a Dataset that was never registered — an orphan record with no
corresponding Dataset.

If step 2 succeeds but step 1 fails, the Dataset is registered in
"pending" state with no ProvenanceRecord. `markConsumable()` would
then throw `DataError.ProvenanceMissing`. But the Dataset exists
in the registry in "pending" state with no way to clean it up
(short of `quarantineDataset()`).

### Evidence

1. api-contracts.md `markConsumable()`: "Precondition:
   provenance.verifyProvenance(datasetId) must return true." No
   documented behavior if `markConsumable()` itself fails (e.g.,
   filesystem write error for the consumable flag).
2. api-contracts.md `invokeTool()`: returns
   `ToolInvocationResult { invocation, outputDatasets,
   provenanceRecord }` — no partial-failure indicator.
3. ADR-009 line 83: "The store is not transactional across
   records."
4. ADR-006 line 127: "Filesystem JSON is not transactional. If the
   Agent crashes during a state transition, the JSON may be
   partially written." — same applies to Dataset state.

### Suggested resolution

Architect should:
1. Add an explicit `retryMarkConsumable(datasetId)` API or document
   the idempotent retry path in `invokeTool()`.
2. Document the cleanup path for each partial-failure scenario
   (orphan ProvenanceRecord, orphan Dataset in pending state).
3. Consider an idempotent `markConsumable()` that can be safely
   retried after a failure.
