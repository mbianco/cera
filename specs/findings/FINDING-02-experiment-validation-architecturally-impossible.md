## Finding: Case cannot validate experimentId — dependency graph prohibits it
Severity: Critical
Category: Correctness > Implicit coupling
Location: specs/architecture/api-contracts.md (lines 615–706, CreateCaseInput); specs/architecture/dependency-graph.md (lines 59–138); specs/architecture/adr/ADR-002.md (lines 45–48)
Spec reference: resolutions.md R2; ADR-002 (ownership constraints)

### Description

R2 states: "A Case belongs to exactly one Experiment." ADR-002
states: "Enforced by `agent-interaction.createWorkflow()` (validates
`experimentId` before creating a Workflow) and
`tool-invocation.createCase()` (validates `experimentId` before
creating a Case)."

This is architecturally impossible. The dependency graph (Phase 4:
`tool-invocation`; Phase 5: `agent-interaction`) shows that
`tool-invocation` does **not** depend on `agent-interaction`. The
graph is acyclic — `tool-invocation` (Phase 4) cannot import from
`agent-interaction` (Phase 5). Therefore, `tool-invocation` has no
access to `ExperimentService` and cannot validate whether an
`ExperimentId` refers to an existing Experiment.

The `CaseService.createCase()` API contract (api-contracts.md
lines 615–623) confirms this gap — it only declares:

```
@throws {ToolInvocationError.InvalidParameters} if compset,
  resolution, or machine target is invalid.
```

No `ExperimentNotFound` is thrown, and no validation of
`experimentId` is documented. Compare with
`WorkflowService.createWorkflow()` (line 826) which explicitly
declares:

```
@throws {AgentError.ExperimentNotFound} if the Experiment does
  not exist.
```

### Evidence

1. dependency-graph.md Phase 4: `tool-invocation` deps =
   `environment-management, data-management, provenance, scheduling,
   dsh-adapter` — no `agent-interaction`.
2. api-contracts.md `CaseService.createCase()` has no
   `@throws {ExperimentNotFound}`.
3. api-contracts.md `WorkflowService.createWorkflow()` has
   `@throws {AgentError.ExperimentNotFound}` — but this error type
   is not defined in `src/types/errors.ts` (see FINDING-03).
4. `CreateCaseInput` includes `experimentId: ExperimentId` but
   nothing validates it.

### Suggested resolution

Architect must choose one:
A. Move Case creation to `agent-interaction` (C7) so it can
   validate `experimentId` via `ExperimentService`. This inverts
   the current design where Case is in C1.
B. Add a validation callback or event-based mechanism where
   `tool-invocation` emits a `case_created` event and
   `agent-interaction` validates asynchronously — but this weakens
   the "belongs to exactly one" constraint to eventual consistency.
C. Maintain a read-only Experiment ID registry in
   `tool-invocation` (duplicated state) — fragile and violates
   bounded context boundaries.
