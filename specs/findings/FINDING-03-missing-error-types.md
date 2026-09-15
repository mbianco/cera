## Finding: AgentError.ExperimentNotFound and CaseAlreadyAssigned not defined in type stubs
Severity: Critical
Category: Correctness > Specification compliance
Location: specs/architecture/api-contracts.md (line 827); specs/architecture/error-taxonomy.md (lines 54–61); src/types/errors.ts (lines 682–797)
Spec reference: error-taxonomy.md; api-contracts.md §7 (Experiment, Workflow)

### Description

The error taxonomy hierarchy in `error-taxonomy.md` (lines 54–60)
lists the following AgentError subtypes:

```
└── AgentError
    ├── LlmHallucinatedTool (FM-A1, R12)
    ├── LlmHallucinatedParameters (FM-A2, R12)
    ├── ContextWindowExceeded (FM-A3)
    ├── LlmUnavailable (FM-A4)
    ├── NetworkLost (FM-X2)
    └── WorkflowAlreadyAssigned
```

The type stubs in `src/types/errors.ts` match this hierarchy exactly
(6 subtypes). However, the API contracts reference two error types
that are **not in the hierarchy and not in the stubs**:

1. **`AgentError.ExperimentNotFound`** — referenced in
   `WorkflowService.createWorkflow()` (api-contracts.md line 827):
   `@throws {AgentError.ExperimentNotFound} if the Experiment does
   not exist.` This error is needed because R2 requires Workflows to
   belong to exactly one Experiment, and `createWorkflow()` must
   validate that the Experiment exists before creating the Workflow.

2. **`CaseAlreadyAssigned`** — R2 states "A Case belongs to exactly
   one Experiment." `ExperimentService.addCaseToExperiment()` has
   no `@throws` documentation at all, while
   `addWorkflowToExperiment()` throws `WorkflowAlreadyAssigned`.
   There is no corresponding `CaseAlreadyAssigned` error type in
   either the error taxonomy or the type stubs.

### Evidence

1. `grep -n "ExperimentNotFound" src/types/errors.ts` → 0 matches.
2. `grep -n "CaseAlreadyAssigned" .` → 0 matches (entire project).
3. `grep -n "ExperimentNotFound" specs/architecture/api-contracts.md`
   → 1 match (line 827).
4. `ExperimentService.addCaseToExperiment()` (api-contracts.md
   line 795) has no `@throws` — contrast with
   `addWorkflowToExperiment()` (line 789) which throws
   `WorkflowAlreadyAssigned`.

### Suggested resolution

1. Add `ExperimentNotFound extends AgentError` to
   `src/types/errors.ts` and to the error-taxonomy hierarchy.
2. Add `CaseAlreadyAssigned extends AgentError` to
   `src/types/errors.ts` and to the error-taxonomy hierarchy.
3. Add `@throws {AgentError.CaseAlreadyAssigned}` to
   `ExperimentService.addCaseToExperiment()` in api-contracts.md.
