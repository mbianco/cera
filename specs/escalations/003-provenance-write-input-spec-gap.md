# Escalation 003: WriteProvenanceInput needs toolName, toolVersion, environmentDescription

**Status:** RESOLVED (implementer decision — extend the contract)
**Date:** 2026-09-15
**Raised by:** Implementer (Phase 2 — provenance)
**Spec references:** api-contracts.md §4; invariants.md INV-P2;
entities.ts ProvenanceRecord

## Context

The `WriteProvenanceInput` in `api-contracts.md §4` lists:

```typescript
interface WriteProvenanceInput {
  toolId: ToolId;
  parameters: Record<string, unknown>;
  environmentId: EnvironmentId;
  inputDatasetIds: DatasetId[];
  outputDatasetId: DatasetId | null;
  exitOutcome: ExitOutcome;
  timestamp: Date;
  jobId?: JobId;
  jobState?: JobState;
  caseId?: CaseId;
}
```

However, the `ProvenanceRecord` entity in `src/types/entities.ts`
requires `toolName: string`, `toolVersion: string`, and
`environmentDescription: string` as non-nullable fields (INV-P2:
"Every ProvenanceRecord includes: Tool identity (name + version),
exact parameters, Environment identity (all modules with versions),
input Dataset identities, output Dataset identity, timestamp, exit
outcome. A record missing any field is defective.").

The `provenance` module is a leaf in the dependency graph — it
depends only on `dsh-adapter`. It cannot import Tool or Environment
repositories to look up the name/version/description from IDs.

## Resolution

Extend `WriteProvenanceInput` (in `src/provenance/types.ts`) with
three additional required fields:

- `toolName: string` — the Tool's human-readable name
- `toolVersion: string` — the Tool's version string
- `environmentDescription: string` — a human-readable description
  of all Modules with versions in the Environment

The caller (tool-invocation in Phase 4) has access to the `Tool`
entity (which has `name: string` and `version: string`) and the
`Environment` entity (which has `modules: readonly Module[]`).
The caller provides these values at write time.

This is consistent with the scheduling module's `SubmitJobInput`,
which includes all fields needed to construct a `Job`.

## Impact

- `WriteProvenanceInput` in `src/provenance/types.ts` has three
  more fields than the contract in `api-contracts.md §4`.
- `writeProvenanceRecord()` validates these fields per INV-P2
  (throws `MissingField` if any is null/empty).
- The api-contracts.md should be updated to include these fields
  in a future spec revision.

## Alternatives considered

1. **Derive toolName/toolVersion from toolId** — rejected because
   `ToolId` is a branded string with no defined format for
   encoding name and version.
2. **Add a ToolRepository dependency** — rejected because it
   violates the module graph (provenance is a leaf with only
   dsh-adapter dependency).
3. **Store only toolId and leave toolName/toolVersion empty** —
   rejected because it violates INV-P2 (the record would be
   defective).
