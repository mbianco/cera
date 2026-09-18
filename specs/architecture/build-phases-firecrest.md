# Build Phases — FirecREST-Only Refactor

> This document describes the **refactor phases** for transitioning
> from the original 5-phase implementation (ADR-011: FirecREST as
> second backend) to the FirecREST-only primary architecture
> (ADR-012). The original `build-phases.md` is NOT deleted — it
> remains the reference for the initial implementation order.
>
> The refactor does NOT follow the original Phase 1–5 order. Instead,
> it follows Refactor Phases A–F, which are ordered to minimize
> risk and maximize testability at each step.
>
> **Key principle:** No interface is changed. Only implementations are
> selected, tagged, or modified within existing interface contracts.
> The `dsh-adapter` and `firecrest-adapter` are NOT modified — they
> already implement the right interfaces.

---

## Refactor Phase A: CLI and Startup Wiring

### What changes

1. **`src/cli.ts`** — Change default backend from `local` to `firecrest`.
   - `--backend` defaults to `firecrest` (was `local`)
   - `--backend dev` replaces `--backend local` (dev-only identifier)
   - Add `--uenv-specs` flag (comma-separated, e.g.,
     `--uenv-specs cdo:2.0.5,python:3.11.6`)
   - Add `--default-resource-request` flag (JSON string, e.g.,
     `'{"nodes":1,"coresPerNode":1,"memory":"1GB","wallTime":"00:10:00","partition":"normal","qos":"default"}'`)
   - Update help text: `firecrest` is the only production backend;
     `dev` is for development only
   - Remove `--backend local` from help text (replaced by `--backend
     dev`)

2. **`src/startup.ts`** (NEW) — `createCeraSystem()` factory stub.
   - `BackendSelection` interface
   - `CeraSystemConfig` interface
   - `CeraSystem` interface
   - `createCeraSystem(config: CeraSystemConfig): CeraSystem` function
   - For `type: 'firecrest'`: creates all FirecREST-backed interfaces,
     no `EnvironmentService`
   - For `type: 'dev'`: creates all dsh-adapter-backed interfaces,
     with `EnvironmentService`

3. **`src/index.ts`** — Export `createCeraSystem` and related types
   from `startup.ts`.

### What stays the same

- All existing module interfaces (dsh-adapter, firecrest-adapter,
  scheduling, environment-management, provenance, data-management,
  tool-invocation, agent-interaction).
- The dsh-adapter and firecrest-adapter implementations — NOT
  modified.
- The existing CLI flags (`--firecrest-url`, `--system`,
  `--token-endpoint`, `--client-id`, `--client-secret`) — still
  valid for the FirecREST backend.

### Tests possible after this phase

- **Unit test:** `createCeraSystem({ backend: { type: 'firecrest', firecrestConfig } })`
  returns a `CeraSystem` with `backendType === 'firecrest'` and
  `environmentService === undefined`.
- **Unit test:** `createCeraSystem({ backend: { type: 'dev', dshConfig } })`
  returns a `CeraSystem` with `backendType === 'dev'` and
  `environmentService !== undefined`.
- **Unit test:** CLI `--backend` defaults to `firecrest` when not
  specified (FP-INV-1).
- **Unit test:** CLI `--backend dev` selects the dev backend.
- **Unit test:** CLI `--uenv-specs cdo:2.0.5,python:3.11.6` parses
  correctly and passes specs to `JobScriptConfig`.
- **Unit test:** CLI `--default-resource-request '{"nodes":1,...}'`
  parses correctly and passes the `ResourceRequest` to
  `JobScriptConfig`.
- **Unit test:** `createCeraSystem()` covers all 7 modules
  (`shellExecutor`, `subprocessRunner`, `filesystemGateway`,
  `schedulingService`, `toolInvocationService`,
  `dataManagementService`, `provenanceService`).

### Dependencies on other refactor phases

- **None.** Phase A is the first refactor phase. It establishes the
  startup wiring that subsequent phases rely on.
- Phase B (tool-invocation modifications) depends on Phase A because
  `createCeraSystem()` must pass `JobScriptConfig` to
  `ToolInvocationService`.
- Phase C (environment-management tagging) depends on Phase A because
  the dev-only tagging is reflected in the factory (only `dev` type
  instantiates `EnvironmentService`).
- Phase D (scheduling tagging) depends on Phase A because the factory
  selects `FirecRESTSchedulingService` for `firecrest` type and the
  SLURM CLI implementation for `dev` type.

### Spec references

- `resolutions-r14.md` R14.7 (`--backend` defaults to `firecrest`)
- `invariants-firecrest-primary.md` FP-INV-1, FP-INV-2
- `ADR-012.md`
- `api-contracts-firecrest.md` §0

---

## Refactor Phase B: tool-invocation Modifications

### What changes

The `tool-invocation` module requires the most significant code
changes (resolves FCREST-01 and FCREST-05).

1. **Add `jobScriptConfig?: JobScriptConfig` to
   `ToolInvocationServiceImplProps`** (additive, backward-compatible).
   This passes uenv specs (F-INV-5) and the default
   `ResourceRequest` (FP-INV-5) from `createCeraSystem()` to the
   service.

2. **Modify `invokeTool()` dispatch (line 664)** — When
   `this.#environment` is null (production), ALL ToolInvocations take
   the parallel path, regardless of `request.executionModel`. When
   `this.#environment` is non-null (dev), dispatch on
   `request.executionModel` as before.

   ```typescript
   // Before (FCREST-01 fix):
   if (request.executionModel === 'parallel') {
     const result = await this.#executeParallel(...);
   } else {
     const result = await this.#executeSynchronous(...);
   }

   // After (R14 refactor):
   if (this.#environment === null) {
     // Production: ALL ToolInvocations are parallel (F-INV-6)
     const result = await this.#executeParallel(...);
   } else {
     // Dev: dispatch on executionModel
     if (request.executionModel === 'parallel') {
       const result = await this.#executeParallel(...);
     } else {
       const result = await this.#executeSynchronous(...);
     }
   }
   ```

3. **Supply default `ResourceRequest` (FP-INV-5)** — When
   `this.#jobScriptConfig?.defaultResourceRequest` is available and
   `request.resourceRequest` is absent, supply the default before
   validation and before `#executeParallel()`.

   ```typescript
   // Before validation (line 473):
   const effectiveResourceRequest =
     request.resourceRequest ??
     this.#jobScriptConfig?.defaultResourceRequest;

   if (request.executionModel === 'parallel' && !effectiveResourceRequest) {
     throw new InvalidParameters({...});
   }

   // In #executeParallel (line 964):
   const resourceRequest =
     request.resourceRequest ??
     this.#jobScriptConfig?.defaultResourceRequest;
   if (!resourceRequest) {
     throw new InvalidParameters({...});
   }
   ```

4. **Bypass `validateExecutionModel` (line 237)** — When
   `this.#environment` is null (production), skip the
   `validateExecutionModel` check. A synchronous Tool can be
   submitted as a Job (the Job runs the synchronous command and
   exits).

   ```typescript
   // Before:
   validateExecutionModel(tool, request);

   // After:
   if (this.#environment !== null) {
     validateExecutionModel(tool, request);
   }
   // In production, all Tools are submitted as Jobs — no
   // executionModel compatibility check.
   ```

5. **Embed uenv specs in Job script (F-INV-5)** — When
   `this.#jobScriptConfig?.uenvSpecs` is available and
   `this.#environment` is null (production), embed the uenv specs in
   the Job script. This is done by passing the specs to
   `FirecrestShellExecutor` via the `UENV_SPECS_KEY` environment
   variable (already supported by the existing `FirecrestShellExecutor`
   code).

   *Note: The existing `FirecrestShellExecutor` already extracts uenv
   specs from `options.env[UENV_SPECS_KEY]` and passes them to
   `buildJobScript()`. The `tool-invocation` module needs to set
   this key when constructing the execution options in production.*

### What stays the same

- The `ToolInvocationService` interface — **unchanged**.
- The `ToolInvocationRequest` type — **unchanged** (the
  `executionModel` field stays; it's ignored in production).
- The `ToolInvocationResult` type — **unchanged**.
- The CESM Case lifecycle (`createCase()` → `configureCase()` →
  `buildCase()` → `submitCase()` → `monitorCase()` →
  `registerCaseOutput()`) — **unchanged**.
- The ExitOutcome derivation (`jobStateToExitOutcome()`) — **unchanged**.
- The output registration gating (INV-T3) — **unchanged**.
- The input immutability rule (INV-T4) — **unchanged**.
- The signal vs. exit-code distinction (INV-T5) — **unchanged**.
- The strict exit code policy (R4, ADR-008) — **unchanged**.

### Tests possible after this phase

- **Unit test (production):** `invokeTool()` with
  `environment = undefined` and `executionModel: 'synchronous'` takes
  the parallel path (submits a Job via `scheduling.submitJob()`).
- **Unit test (production):** `invokeTool()` with
  `environment = undefined` and no `resourceRequest` supplies the
  default `ResourceRequest` from `jobScriptConfig` (FP-INV-5).
- **Unit test (production):** `invokeTool()` with
  `environment = undefined` does NOT call
  `environmentManagement.verifyEnvironment()` (FCREST-01 verified).
- **Unit test (production):** `invokeTool()` with
  `environment = undefined` and a synchronous Tool does NOT throw
  `InvalidParameters` for `executionModel` incompatibility.
- **Unit test (production):** The Job script contains
  `uenv start <spec> --` before the Tool command (F-INV-5).
- **Unit test (dev):** `invokeTool()` with `environment` present and
  `executionModel: 'synchronous'` takes the synchronous path
  (unchanged behavior).
- **Unit test (dev):** `invokeTool()` with `environment` present and
  `executionModel: 'parallel'` without `resourceRequest` throws
  `InvalidParameters` (unchanged behavior).
- **Unit test (dev):** `invokeTool()` with `environment` present and
  a synchronous Tool with `executionModel: 'parallel'` throws
  `InvalidParameters` (unchanged behavior).
- **BDD test (production):** FP-FM-1 — a formerly-synchronous
  ToolInvocation with default `ResourceRequest` that fails with
  `OUT_OF_MEMORY` → the Agent reports the failure and suggests a
  larger `ResourceRequest`.
- **BDD test (production):** FP-FM-2 — a Job submitted in Session A
  is discoverable in Session B via `queryJobsByUser()` after a
  laptop crash (composed from existing proactive reporting tests).

### Dependencies on other refactor phases

- **Depends on Phase A** — `createCeraSystem()` must pass
  `JobScriptConfig` to `ToolInvocationService`. The factory must
  instantiate `ToolInvocationServiceImpl` with `jobScriptConfig`
  when the backend is FirecREST.
- **No dependency on Phase C** — the `environment-management` tagging
  (Phase C) is independent of the `tool-invocation` changes. However,
  Phase C's dev-only tagging of `EnvironmentService` is consistent
  with Phase B's `this.#environment === null` check (production
  skips EnvironmentService).

### Spec references

- `resolutions-r14.md` R14.4 (all parallel), R14.3 (uenv in Job scripts)
- `invariants-firecrest-primary.md` INV-T1 (re-evaluated), INV-T5
  (re-evaluated), F-INV-5 (elevated), F-INV-6 (elevated), FP-INV-3
  (new), FP-INV-5 (new)
- `failure-modes-firecrest-primary.md` FM-T1 (re-evaluated), FM-T2
  (re-evaluated), FM-T5 (re-evaluated), FP-FM-1 (new), FP-FM-2 (new)
- `impact-analysis.md` §6
- `ADR-012.md`

---

## Refactor Phase C: environment-management Tagging

### What changes

1. **Tag the runtime service as dev-only.** The files
   `environment-service.ts`, `uenv-parser.ts`, and
   `conflict-detector.ts` are tagged as dev-only. This is a
   documentation and test-organization change, not a code change:
   - JSDoc comments on `EnvironmentServiceImpl` class and
     `EnvironmentService` interface note that they are dev-only.
   - Tests that exercise the runtime `EnvironmentService` (loadUenv,
     verifyEnvironment, checkUenvAvailability, detectConflicts) are
     tagged with `@dev-only`.
   - The `createCeraSystem()` factory only instantiates
     `EnvironmentServiceImpl` when `backend.type === 'dev'`.

2. **Export domain types for use by `tool-invocation`.** The types
   (`Environment`, `UenvSpec`, `Module`, `Conflict`) are already
   exported from `environment-management`. Verify that
   `tool-invocation` imports these types for Job script construction
   and ProvenanceRecord fields. No new export is needed — the types
   are already public.

3. **Consider a `buildUenvScriptPrefix()` utility.** The
   `firecrest-adapter/job-script-builder.ts` already provides
   `buildJobScript()` which handles `uenv start <spec> --` prefixes.
   The `environment-management` types (`UenvSpec`) are used to
   construct the specs passed to `buildJobScript()`. If a standalone
   `buildUenvScriptPrefix(specs: UenvSpec[]): string` utility is
   useful (e.g., for ProvenanceRecord construction), it can be added
   to `environment-management` or `tool-invocation`. This is
   optional and depends on the implementer's needs.

### What stays the same

- The `EnvironmentService` interface — **unchanged** (still exported,
  still used in dev mode).
- The `LoadUenvInput` type — **unchanged**.
- The `EnvironmentManagementConfig` type — **unchanged**.
- The domain types (`Environment`, `UenvSpec`, `Module`, `Conflict`)
  — **unchanged**.
- The `ConflictDetector` class — **unchanged** (used for static
  validation in production, runtime detection in dev).

### Tests possible after this phase

- **Unit test (dev-only):** Tests that call `loadUenv()`,
  `verifyEnvironment()`, `unloadUenv()`, `checkUenvAvailability()`,
  `detectConflicts()` are tagged `@dev-only` and still pass.
- **Unit test (production):** Tests that use `UenvSpec` and
  `Conflict` types for Job script construction and static validation
  pass without an `EnvironmentService` instance.
- **Unit test:** `createCeraSystem({ backend: { type: 'firecrest' } })`
  does NOT instantiate `EnvironmentServiceImpl` (FP-INV-3).
- **Unit test:** `createCeraSystem({ backend: { type: 'dev' } })`
  DOES instantiate `EnvironmentServiceImpl`.

### Dependencies on other refactor phases

- **Depends on Phase A** — the factory (created in Phase A) is where
  the dev-only instantiation is reflected.
- **No dependency on Phase B** — the `tool-invocation` changes (Phase
  B) handle the absence of `EnvironmentService` independently. Phase
  C's tagging is consistent with Phase B's `this.#environment ===
  null` check.

### Spec references

- `resolutions-r14.md` R14.3 (uenv in Job scripts, not by cera)
- `invariants-firecrest-primary.md` INV-E1 (re-evaluated), INV-E2
  (re-evaluated), INV-E3 (removed from prod), FP-INV-3 (new)
- `failure-modes-firecrest-primary.md` FM-E1 (dev-only), FM-E2
  (dev-only), FM-E3 (dev-only)
- `impact-analysis.md` §3
- `ADR-012.md`; `ADR-003` (re-evaluated)

---

## Refactor Phase D: scheduling Tagging

### What changes

1. **Tag the SLURM CLI implementation as dev-only.** The
   `scheduling/scheduling-service.ts` file (SLURM CLI via
   `SubprocessRunner`: sbatch, squeue, scancel) is tagged as
   dev-only. This is a documentation and test-organization change:
   - JSDoc comments on the SLURM CLI `SchedulingService`
     implementation note that it is dev-only.
   - Tests that mock `sbatch`/`squeue`/`scancel` CLI output are
     tagged with `@dev-only`.

2. **Verify `FirecRESTSchedulingService` is the production
   implementation.** The `firecrest-adapter` already implements
   `SchedulingService` via `FirecRESTSchedulingService`. The
   `createCeraSystem()` factory (Phase A) selects
   `FirecRESTSchedulingService` for `backend.type === 'firecrest'`
   and the SLURM CLI implementation for `backend.type === 'dev'`.

3. **Update `reconcileViaSacct()` documentation.** In production,
   `reconcileViaSacct()` maps to a fresh FirecREST job query (via
   `GET /compute/{system}/jobs` with a state filter) instead of the
   `sacct` CLI. The method signature is unchanged; only the
   implementation differs.

### What stays the same

- The `SchedulingService` interface — **unchanged**.
- The `SubmitJobInput`, `JobStatusReport`, `SchedulingConfig` types
  — **unchanged**.
- The `JobMonitor` interface — **unchanged**.
- The `Job`, `JobId`, `ResourceRequest`, `JobState` types — **unchanged**.
- The SLURM-only decision (R8, ADR-004) — **unchanged**. FirecREST
  is a transport, not a different scheduler.
- The proactive Job reporting behavior (R7, ADR-007) — **unchanged**.
- The UNKNOWN state policy (R13) — **unchanged**.

### Tests possible after this phase

- **Unit test (dev-only):** Tests that mock `sbatch`/`squeue`/
  `scancel` CLI output are tagged `@dev-only` and still pass.
- **Unit test (production):** Tests that mock `FirecRESTSchedulingService`
  endpoints (`POST /compute/.../jobs`, `GET /compute/.../jobs/{id}`)
  are tagged `@production` and pass.
- **Unit test (unchanged):** Tests that mock the `SchedulingService`
  interface (transport-agnostic) pass for both backends.
- **Unit test:** `createCeraSystem({ backend: { type: 'firecrest' } })`
  uses `FirecRESTSchedulingService` (FP-INV-4).
- **Unit test:** `createCeraSystem({ backend: { type: 'dev' } })`
  uses the SLURM CLI implementation.
- **New test (production):** `reconcileViaSacct()` uses a FirecREST
  job query (not `sacct` CLI) in production.

### Dependencies on other refactor phases

- **Depends on Phase A** — the factory (created in Phase A) is where
  the backend selection is reflected.
- **No dependency on Phase B or C** — the scheduling tagging is
  independent of the tool-invocation and environment-management
  changes.

### Spec references

- `resolutions-r14.md` R14.6 (SLURM CLI replaced by
  FirecRESTSchedulingService in production)
- `invariants-firecrest-primary.md` INV-S1 (re-evaluated), FP-INV-4
  (new)
- `failure-modes-firecrest-primary.md` FM-S1 (re-evaluated), FM-S2
  (dev-only), FM-S3 (re-evaluated), FM-S4 (re-evaluated)
- `impact-analysis.md` §2
- `ADR-012.md`; `ADR-004` (unchanged); `ADR-007` (unchanged)

---

## Refactor Phase E: Tests Reclassification

### What changes

Tests are reclassified as production, dev-only, or unchanged. **No
tests are removed** (R14.5: tests are reclassified, not deleted).

1. **Tag dev-only tests.** Tests that exercise:
   - `EnvironmentService` runtime operations (loadUenv,
     verifyEnvironment, checkUenvAvailability, detectConflicts) →
     `@dev-only`
   - Synchronous `executionModel` dispatch (with `ShellExecutor`
     mock) → `@dev-only`
   - Local SLURM CLI (sbatch/squeue/scancel) → `@dev-only`
   - Local `FilesystemGateway` (exists, readFile, writeFile via local
     fs) → `@dev-only` for transport-specific tests
   - Local process signals (SIGSEGV via SubprocessRunner) →
     `@dev-only`

2. **Tag production tests.** Tests that exercise:
   - FirecREST endpoints (job submission, job query, file stat,
     file download/upload) → `@production` (ensure these exist)
   - `invokeTool()` without `EnvironmentService` → `@production`
   - Job script with `uenv start <spec> --` → `@production`
   - Default `ResourceRequest` for formerly-synchronous
     ToolInvocations → `@production`
   - ExitOutcome derivation from Job state → `@production`

3. **Verify unchanged tests.** Tests that exercise domain logic
   (Dataset immutability, format/grid validation, ProvenanceRecord
   immutability, Workflow lifecycle, Session lifecycle, Action
   validation) remain **unchanged** — they are transport-agnostic.

4. **Add new tests** (from impact analysis):
   - `dsh-adapter`: ~3 new (startup config test)
   - `scheduling`: ~1 new (`reconcileViaSacct` via FirecREST)
   - `environment-management`: ~3 new (`buildUenvScriptPrefix`, Job
     script construction, `invokeTool` without `EnvironmentService`)
   - `provenance`: ~1 new (large ProvenanceRecord >5MB async write)
   - `data-management`: ~2 new (large file async transfer, 404/403
     from FirecREST stat)
   - `tool-invocation`: ~6 new (all parallel, default ResourceRequest,
     uenv in Job script, synchronous Tool as Job, FP-FM-1, FP-FM-2)
   - `agent-interaction`: ~2 new (FP-FM-2 laptop crash recovery,
     backend defaults to firecrest)
   - **Total: ~18 new tests**

### What stays the same

- The test suite structure (742 tests across 7 modules).
- The test framework (vitest).
- The test tiers (Tier 1 fast, Tier 2 slow, Tier 3 full).
- All existing test files and test code — only tags and
  organization change.

### Tests possible after this phase

- All reclassified tests pass with their new tags.
- `make test-fast` runs only fast + `@production` + `@unchanged` tests.
- `make test-slow` runs Tier 1 + slow + `@dev-only` + `@production` tests.
- `make test-full` runs all tests (including real HPC e2e).

### Dependencies on other refactor phases

- **Depends on Phases A–D** — test reclassification requires that the
  code changes (factory, tool-invocation, environment-management,
  scheduling) are in place so that tests can be tagged correctly.
- **No dependency on Phase F** — documentation (Phase F) is
  independent of test reclassification.

### Spec references

- `resolutions-r14.md` R14.5 (tests reclassified, not removed)
- `impact-analysis.md` (per-module test impact tables)
- `invariants-firecrest-primary.md` (test actions per invariant)
- `failure-modes-firecrest-primary.md` (test actions per failure mode)

---

## Refactor Phase F: Documentation Update

### What changes

1. **`README.md`** — Update to describe only the FirecREST backend as
   the production path. Remove references to `--backend local` as a
   production option. Add `--backend firecrest` as the default. Add
   `--backend dev` in a "Development" section only.

2. **`docs/getting-started.md`** — Update to use `--backend firecrest`
   as the default. Add `--uenv-specs` and `--default-resource-request`
   flags. Mention `--backend dev` only in a development section.

3. **`AGENTS.md`** — Update the project state section to reflect the
   R14 refactor. Add a note about the `--backend` flag defaulting to
   `firecrest`. Update the spec references to include
   `resolutions-r14.md`, `invariants-firecrest-primary.md`,
   `failure-modes-firecrest-primary.md`, and `ADR-012.md`.

4. **`src/cli.ts` help text** — Already updated in Phase A. Verify
   that the help text accurately reflects the R14 architecture.

5. **JSDoc comments** — Update module-level JSDoc comments in
   `dsh-adapter` (note dev-only), `environment-management` (note
   runtime service is dev-only), `scheduling` (note SLURM CLI is
   dev-only), and `tool-invocation` (note all-parallel in production).

### What stays the same

- All spec artifacts in `specs/` (invariants.md, failure-modes.md,
  resolutions.md, assumptions.md, features/*.feature) — these are
  append-only and not modified.
- The architecture documents (`module-graph.md`, `api-contracts.md`,
  `build-phases.md`, `dependency-graph.md`, `enforcement-map.md`) —
  these are supplemented by the new `*-firecrest.md` documents, not
  replaced.

### Tests possible after this phase

- **Documentation test:** `README.md` does not mention
  `--backend local` as a production option.
- **Documentation test:** `docs/getting-started.md` uses
  `--backend firecrest` as the default.
- **Documentation test:** `AGENTS.md` references
  `resolutions-r14.md` and `ADR-012.md`.
- **Documentation test:** CLI help text mentions `firecrest` as the
  only production backend.

### Dependencies on other refactor phases

- **Depends on Phases A–E** — documentation must reflect the final
  state of all code changes and test reclassification.
- **No other dependencies.**

### Spec references

- `resolutions-r14.md` R14.5 (user-facing docs describe only
  FirecREST), R14.7 (`--backend` defaults to `firecrest`)
- `invariants-firecrest-primary.md` FP-INV-2 (local backend is not
  a production path — must not be documented as such)
- `ADR-012.md`
- `firecrest/assumptions.md` F-A-4

---

## Refactor Phase Summary

| Phase | What | Modules affected | New tests | Dependencies |
|-------|------|-----------------|-----------|--------------|
| A | CLI and startup wiring | `startup` (new), `cli.ts`, `index.ts` | ~6 | None |
| B | tool-invocation modifications | `tool-invocation` | ~8 | A |
| C | environment-management tagging | `environment-management` | ~4 | A |
| D | scheduling tagging | `scheduling` | ~5 | A |
| E | Tests reclassification | All modules | ~18 (total) | A, B, C, D |
| F | Documentation update | `README.md`, `docs/`, `AGENTS.md`, JSDoc | ~4 (doc tests) | A, B, C, D, E |

### Parallelization opportunities

- **Phase A** must be completed first (all other phases depend on it).
- **Phases B, C, D** are independent of each other and can be
  developed in parallel by up to 3 implementers.
- **Phase E** depends on Phases B, C, D (must be after all code
  changes).
- **Phase F** depends on Phase E (must be after test reclassification
  is complete).

```
Phase A ──┬──> Phase B ──┐
          ├──> Phase C ──┼──> Phase E ──> Phase F
          └──> Phase D ──┘
```

### Risk assessment

| Phase | Risk | Mitigation |
|-------|------|------------|
| A | Factory wiring incorrect (wrong backend selected) | Unit tests for backend selection; FP-INV-1 enforced |
| B | Dispatch logic incorrect (synchronous path taken in production) | Unit tests for `this.#environment === null` dispatch; F-INV-6 enforced |
| B | Default `ResourceRequest` not supplied (FP-INV-5 violated) | Unit tests for absent `resourceRequest` with `jobScriptConfig` |
| C | `EnvironmentService` accidentally instantiated in production | Unit test for `createCeraSystem({ type: 'firecrest' })` → no `environmentService`; FP-INV-3 enforced |
| D | SLURM CLI accidentally used in production | Unit test for `createCeraSystem({ type: 'firecrest' })` → `FirecRESTSchedulingService`; FP-INV-4 enforced |
| E | Tests incorrectly tagged (production test tagged as dev-only) | Review test tags against impact-analysis.md test tables |
| F | Documentation mentions `--backend local` (FP-INV-2 violated) | Documentation test for FP-INV-2 |
