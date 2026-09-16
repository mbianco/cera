## Finding: ADR-011 "no modification to existing modules" contradicts F-INV-5 and F-INV-6
Severity: Critical
Category: Correctness > Specification compliance; Semantic drift
Location: `specs/architecture/adr/ADR-011.md` §"Key design decisions" point 6; `specs/firecrest/invariants.md` F-INV-5, F-INV-6; `src/tool-invocation/tool-invocation-service.ts` lines 460–471, 560–569, 634–649
Spec reference: ADR-011 point 6 ("No modification to existing modules"); F-INV-5 (uenv in Job scripts, not by cera); F-INV-6 (all ToolInvocations are parallel)

### Description

ADR-011 point 6 states: "**No modification to existing modules.** The FirecREST adapter is purely additive... No existing source file is changed (except `src/index.ts` for the barrel export)." This is a load-bearing architectural claim — it is the basis for asserting that the FirecREST backend is low-risk and additive.

However, F-INV-5 and F-INV-6 require **behavioral changes** in `tool-invocation` and `environment-management` — both existing modules with fully implemented source code (Phase 4, 133 tests; Phase 2, 239 tests respectively).

**Contradiction with F-INV-6 (all ToolInvocations are parallel):** The existing `tool-invocation-service.ts` dispatches on `request.executionModel`:
- Line 236: rejects when `request.executionModel === 'parallel' && tool.executionModel === 'synchronous'` (a synchronous Tool cannot be run in parallel)
- Line 464–471: throws `InvalidParameters` when `request.executionModel === 'parallel' && !request.resourceRequest`
- Line 634: `if (request.executionModel === 'parallel')` — the entire synchronous/parallel dispatch branch

F-INV-6 says: "Every ToolInvocation, regardless of its declared `executionModel`, is submitted as a SLURM Job." This means:
1. A Tool with declared `executionModel: 'synchronous'` must now be submitted as a Job (line 236 would reject it).
2. A ToolInvocation with `executionModel: 'synchronous'` (and therefore no `resourceRequest`) must now produce a Job (line 464–471 would reject it).
3. The dispatch at line 634 must always take the parallel branch.

These cannot be achieved without modifying `tool-invocation-service.ts`.

**Contradiction with F-INV-5 (uenv in Job scripts, not by cera):** The existing `tool-invocation-service.ts` calls `EnvironmentService` to load and verify the Environment before invocation (lines 560–569, and the documented flow at lines 420–421: "load and verify the Tool's required Environment via environment-management (INV-T1, INV-E2). Re-verify immediately before execution."). F-INV-5 states: "The `EnvironmentService` interface is NOT used by the FirecREST backend." This means the environment loading step in `invokeTool()` must be skipped or replaced — again, a modification to an existing module.

### Evidence

1. `src/tool-invocation/tool-invocation-service.ts` line 236: `if (request.executionModel === 'parallel' && tool.executionModel === 'synchronous')` — rejects synchronous Tools from parallel execution. F-INV-6 requires all Tools to be parallel.
2. `src/tool-invocation/tool-invocation-service.ts` line 465: `if (request.executionModel === 'parallel' && !request.resourceRequest)` — rejects parallel requests without `resourceRequest`. F-INV-6 requires synchronous ToolInvocations (which have no `resourceRequest`) to become Jobs.
3. `src/tool-invocation/tool-invocation-service.ts` line 634: `if (request.executionModel === 'parallel')` — dispatches to parallel execution only when explicitly requested. F-INV-6 requires this to always be true.
4. `specs/firecrest/invariants.md` F-INV-5: "The `EnvironmentService` interface is NOT used by the FirecREST backend." But `tool-invocation-service.ts` lines 560–569 call `EnvironmentService` unconditionally.
5. `specs/architecture/adr/ADR-011.md` point 6: "No existing source file is changed (except `src/index.ts`)."

### Suggested resolution

The architect must either:
(a) **Withdraw the "no modification" claim** and document which existing modules must be modified for FirecREST (at minimum: `tool-invocation`, `environment-management`). This is the honest path — the FirecREST backend is not purely additive.
(b) **Introduce a backend-strategy abstraction** in `tool-invocation` that selects execution behavior based on the active backend. The strategy is injected at startup; `tool-invocation-service.ts` calls the strategy instead of dispatching on `executionModel` directly. This preserves the "no modification to domain logic" claim but requires modifying `tool-invocation`'s constructor/injection (which is still a modification).
(c) **Make `EnvironmentService` optional** in `tool-invocation` (nullable injection). When absent (FirecREST backend), the environment step is skipped and uenv is embedded in the Job script by the FirecREST `ShellExecutor`/`SubprocessRunner`. This requires modifying `tool-invocation-service.ts` to handle the null case.

Regardless of approach, ADR-011 point 6 must be rewritten. The "purely additive" framing blocks the architect and implementer from seeing the required changes in `tool-invocation` and `environment-management`.
