# Impact Analysis — FirecREST-Only Primary Architecture

> This document analyzes the impact of R14 (ADR-012) on each of the
> 7 existing modules. It tells the architect and implementer exactly
> what to change, what stays the same, which tests are affected, and
> which ADRs are affected.
>
> **Read this file alongside `invariants-firecrest-primary.md` and
> `failure-modes-firecrest-primary.md` for the full picture.**
>
> Test action legend:
> - **UNCHANGED** — test stays as-is, production and dev
> - **DEV-ONLY** — test stays but is tagged/organized as dev-only
> - **PRODUCTION** — test stays or is added for the production path
> - **MODIFY** — test needs modification (not just reclassification)
> - **ADD** — new test needed for the production path
> - **REMOVE** — test is deleted (no test should be removed — see
>   R14.5: tests are reclassified, not removed)

---

## 1. `dsh-adapter` — dsh Isolation Layer (Phase 1, 162 tests)

### What changes

- The dsh-adapter is tagged as the **dev-only backend**. In
  production, the `firecrest-adapter` provides the same interfaces.
  The `--backend` flag (default: `firecrest`, per FP-INV-1) selects
  which adapter is instantiated at startup.
- No code changes to the dsh-adapter itself. The interfaces
  (`ShellExecutor`, `SubprocessRunner`, `FilesystemGateway`,
  `JobBackend`, `ToolRegistry`, `CommandRegistry`) are unchanged.
- The startup code (`src/index.ts` or equivalent) is modified to
  default to `firecrest` and instantiate the `firecrest-adapter`
  when `--backend` is not specified or is `firecrest`.

### What stays the same

- All 7 adapter interfaces (`ShellExecutor`, `SubprocessRunner`,
  `SandboxRunner`, `FilesystemGateway`, `JobBackend`, `ToolRegistry`,
  `CommandRegistry`).
- The dsh isolation layer (ADR-005) — dsh-adapter wraps dsh's volatile
  extension points. No other module imports dsh directly.
- The version pinning (`package.json` / lockfile). dsh upgrades are
  deliberate, reviewed, and tested (FM-X3).
- The dsh-adapter's internal implementation — it wraps
  `ctx.shell`, `ctx.subprocess`, `ctx.sandbox`, `ctx.fs`, `ctx.jobs`,
  `ctx.tools`, `ctx.commands` exactly as before.

### Which tests are affected

| Test group | Count (approx) | Action | Notes |
|---|---|---|---|
| dsh-adapter unit tests (mock dsh extension points) | 162 | UNCHANGED | These test the dsh-adapter, which is still used in dev mode. Tag the test suite as `@dev-only` to indicate it tests the non-production backend. Do NOT remove. |
| Integration tests that use dsh-adapter + real dsh | (in Tier 3) | UNCHANGED | Still run in Tier 3 for dev-mode validation. |
| New: startup config test (`--backend` defaults to `firecrest`) | 0 | ADD | Verify that when `--backend` is not specified, the `firecrest-adapter` is instantiated. Verify that `--backend dev` instantiates the `dsh-adapter`. |

### Which ADRs are affected

- **ADR-005** (dsh isolation layer) — **unchanged**. Still applies for
  dev mode. The isolation layer is validated by the production backend
  swap (the FirecREST adapter implements the same interfaces without
  importing dsh).
- **ADR-011** (FirecREST as second backend) — **superseded by
  ADR-012**. ADR-011 is NOT deleted (append-only). Its analysis
  remains valid for the dev-mode local backend.

---

## 2. `scheduling` — C4 Scheduling (SLURM) (Phase 2, part of 239 tests)

### What changes

- In production, the SLURM CLI implementation (sbatch, squeue, scancel
  via `dsh-adapter.SubprocessRunner`) is replaced by
  `FirecRESTSchedulingService` (via FirecREST compute endpoints:
  `POST /compute/{system}/jobs`, `GET /compute/{system}/jobs/{id}`,
  `DELETE /compute/{system}/jobs/{id}`).
- The `SchedulingService` interface stays. It is implemented by two
  backends:
  - **Production:** `firecrest-adapter/scheduling-service.ts`
    (`FirecRESTSchedulingService`)
  - **Dev:** existing `scheduling/scheduling-service.ts` (SLURM CLI
    via `dsh-adapter.SubprocessRunner`)
- The `--backend` flag selects which implementation is injected into
  domain modules at startup.
- INV-S1 (Scheduler is authoritative) is re-evaluated: the source of
  authority changes from SLURM CLI to SLURM via FirecREST REST API.

### What stays the same

- The `SchedulingService` interface: `submitJob()`, `queryJob()`,
  `queryJobsByUser()`, `cancelJob()`, `reconcileViaSacct()`.
- The `Job`, `JobID`, `ResourceRequest`, `JobState` types.
- The SLURM-only decision (R8, ADR-004). FirecREST is a transport, not
  a different scheduler.
- All scheduling invariants (INV-S1–S4), re-evaluated for FirecREST.
- The proactive Job reporting behavior (R7, ADR-007) —
  `queryJobsByUser()` is still called on Session start.
- The UNKNOWN state policy (R13) — if FirecREST is unreachable, Jobs
  are marked UNKNOWN (not promoted/demoted). 30-minute UNKNOWN is
  acceptable.
- The `reconcileViaSacct()` method — in production, this maps to a
  fresh FirecREST job query (instead of `sacct` CLI).

### Which tests are affected

| Test group | Count (approx) | Action | Notes |
|---|---|---|---|
| Tests that mock `sbatch` / `squeue` / `scancel` CLI output (via `SubprocessRunner` mock) | ~40 | DEV-ONLY | These test the SLURM CLI implementation. Tag as `@dev-only`. Do NOT remove. |
| Tests that mock `SchedulingService` interface (transport-agnostic) | ~30 | UNCHANGED | These test domain logic (Job state transitions, ResourceRequest immutability, terminal state finality). Interface-level tests are valid for both backends. |
| Tests for `FirecRESTSchedulingService` (mock FirecREST compute endpoints) | (from FCREST phases) | PRODUCTION | These test the production scheduling implementation. Ensure they exist and are tagged `@production`. |
| Tests that verify proactive Job reporting (`queryJobsByUser()` on Session start) | ~10 | MODIFY | Update to use `FirecRESTSchedulingService` mock for production tests. Keep `SubprocessRunner` mock version as `@dev-only`. |
| Tests that verify UNKNOWN state on scheduler unavailability | ~5 | UNCHANGED | Behavior is the same; only the mock changes (FirecREST 503 vs local SLURM connection error). |
| New: tests that verify `reconcileViaSacct()` uses FirecREST job query | 0 | ADD | Verify that reconciliation in production uses `GET /compute/{system}/jobs` (with state filter) instead of `sacct` CLI. |

### Which ADRs are affected

- **ADR-004** (SLURM only) — **unchanged**. SLURM is still the only
  scheduler. FirecREST is a transport.
- **ADR-007** (proactive Job reporting) — **unchanged**. The behavior
  is the same; only the transport changes.
- **ADR-011** (superseded by ADR-012).

---

## 3. `environment-management` — C5 Environment Management (uenv) (Phase 2, part of 239 tests)

### What changes

This is the most significantly affected module. The runtime
`EnvironmentService` is removed from the production path.

- **In production:** cera does NOT call `loadUenv()`,
  `verifyEnvironment()`, `checkUenvAvailability()`,
  `detectConflicts()`, `unloadUenv()`, or `getActiveEnvironment()`.
  There is no active Environment on the laptop — the Environment is
  loaded inside the SLURM Job via `uenv start <spec> --` embedded in
  the Job script by `tool-invocation`.
- **The runtime service implementation** (`environment-service.ts`,
  `uenv-parser.ts`, `conflict-detector.ts`) becomes **dev-only**.
  These files call uenv CLI commands via `dsh-adapter.SubprocessRunner`
  and are only used when `--backend dev` is specified.
- **The domain types** (`Environment`, `UenvSpec`, `Module`,
  `Conflict`) **stay and are used by `tool-invocation`** to construct
  Job scripts. The types are exported from `environment-management`
  (or a shared types module) and imported by `tool-invocation`.
- **The `environment-management` module's public surface changes:**
  - The runtime methods (`loadUenv`, `unloadUenv`,
    `verifyEnvironment`, `checkUenvAvailability`, `detectConflicts`,
    `getActiveEnvironment`) are available only in dev mode.
  - The types (`Environment`, `UenvSpec`, `Module`, `Conflict`) are
    always available.
  - A new method or utility may be needed: `buildUenvScriptPrefix(specs:
    UenvSpec[]): string` — constructs the `uenv start <spec> --` prefix
    for the Job script. This is production-safe (no SubprocessRunner
    dependency).
- **INV-E1** (one active Environment per execution context) is
  re-evaluated: the execution context is the SLURM Job.
- **INV-E2** (conflict detection before execution) is re-evaluated:
  conflict detection happens at uenv mount time inside the Job, not by
  cera before Job submission.
- **INV-E3** (Module availability verified before load) is removed
  from the production path. Availability is tested at Job runtime
  (FM-F-9).
- **FM-E1, FM-E2, FM-E3** are DEV-ONLY. In production, they are
  replaced by FM-F-9 (uenv not available in Job script).

### What stays the same

- The domain types: `Environment`, `UenvSpec`, `Module`, `Conflict`.
  These are used by `tool-invocation` to construct Job scripts in
  both production and dev mode.
- The ubiquitous language: Environment, Module (uenv component),
  Compiler Stack, MPI, uenv.
- The bounded context C5 — it still owns the Environment aggregate
  and its types. The consistency boundary changes (execution context =
  Job, not cera process) but the context still exists.
- The uenv-not-Lmod decision (R9, ADR-003). uenv is still the
  mechanism. The loading location changes from cera (login node) to
  the Job script (compute node).
- The conflict detection logic (path-level, not soname-level). In
  dev mode, `detectConflicts()` runs via SubprocessRunner. In
  production, a static version of the conflict detection (using the
  `Conflict` type, without SubprocessRunner) may be used by
  `tool-invocation` for pre-submission validation.

### Which tests are affected

| Test group | Count (approx) | Action | Notes |
|---|---|---|---|
| Tests that call `loadUenv()`, `verifyEnvironment()`, `unloadUenv()` (with `SubprocessRunner` mock) | ~60 | DEV-ONLY | These test the runtime EnvironmentService. Tag as `@dev-only`. Do NOT remove. |
| Tests that call `checkUenvAvailability()` (with `SubprocessRunner` mock) | ~20 | DEV-ONLY | These test pre-submission availability verification. Tag as `@dev-only`. Do NOT remove. |
| Tests that call `detectConflicts()` (with `SubprocessRunner` mock) | ~15 | DEV-ONLY | These test runtime conflict detection. Tag as `@dev-only`. Do NOT remove. |
| Tests that exercise `UenvSpec` parsing and validation (no `SubprocessRunner`) | ~10 | UNCHANGED | These test the types, which are used in both production and dev. Ensure they are not coupled to the runtime service. |
| Tests that exercise the `Conflict` type (path-level conflict detection logic) | ~5 | UNCHANGED | These test the domain logic, which is used in both production (static validation) and dev (runtime detection). |
| New: tests that verify `buildUenvScriptPrefix()` produces correct `uenv start <spec> --` | 0 | ADD | Production test. Verify the prefix is correctly constructed from `UenvSpec[]`. |
| New: tests that verify `tool-invocation` embeds `uenv start <spec> --` in the Job script | 0 | ADD | Production test. May live in `tool-invocation` test suite. |
| New: tests that verify the Job fails with a uenv error when the uenv doesn't exist (FM-F-9) | (from FCREST phases) | PRODUCTION | Ensure these exist and are tagged `@production`. |
| New: tests that verify `invokeTool()` works without an `EnvironmentService` dependency | 0 | ADD | Production test. Verify the flow does not throw when `EnvironmentService` is absent. |

### Which ADRs are affected

- **ADR-003** (uenv not Lmod) — **re-evaluated**. uenv is still the
  mechanism, but the loading location changes from cera (login node)
  to the Job script (compute node). ADR-003 is NOT deleted (append-
  only). ADR-012 supersedes the loading-location aspect.
- **ADR-011** (superseded by ADR-012).

---

## 4. `provenance` — C6 Provenance (Phase 2, part of 239 tests)

### What changes

- In production, ProvenanceRecords are written and read via FirecREST
  filesystem endpoints (F-INV-7):
  - Write ≤5MB: `POST /filesystem/{system}/ops/upload` (synchronous)
  - Write >5MB: `POST /filesystem/{system}/transfer/upload`
    (asynchronous, poll for completion)
  - Read ≤5MB: `GET /filesystem/{system}/ops/download` (synchronous)
  - Read >5MB: `POST /filesystem/{system}/transfer/download`
    (asynchronous, poll for completion)
- The `ProvenanceService` interface stays. The implementation is
  selected by the `--backend` flag:
  - **Production:** uses `firecrest-adapter.FilesystemGateway` (HTTP
    to FirecREST filesystem endpoints)
  - **Dev:** uses `dsh-adapter.FilesystemGateway` (local `fs`)
- The Provenance store path remains on the HPC filesystem
  (`FirecrestConfig.provenanceStorePath`). In dev mode, the path is
  local.
- FM-P1 (ProvenanceRecord write failure) is re-evaluated: the failure
  manifests as an HTTP error (503, 500, timeout) instead of a local
  filesystem error. The retry logic is the same (backoff), but the
  error detection changes.

### What stays the same

- The `ProvenanceRecord` type and its fields (Tool identity,
  parameters, Environment identity, input Dataset identities, output
  Dataset identity, timestamp, exit outcome).
- All provenance invariants (INV-P1–P4). Immutability (INV-P1),
  full reproducibility tuple (INV-P2), before-consumption gating
  (INV-P3), survives Session end (INV-P4) are all unchanged.
- The `ProvenanceService` interface: `writeProvenanceRecord()`,
  `queryProvenanceRecord()`, `queryProvenanceForJob()`,
  `queryLineage()`, `verifyProvenance()`, `reconstructProvenanceRecord()`,
  `quarantineDataset()`.
- The write-before-consumption gating logic (INV-D3, INV-P3 — jointly
  enforced by `tool-invocation`, `data-management`, and `provenance`).
- The corrupted-ProvenanceRecord policy (R11: local, not systemic).

### Which tests are affected

| Test group | Count (approx) | Action | Notes |
|---|---|---|---|
| Tests that mock `dsh-adapter.FilesystemGateway` for ProvenanceRecord read/write | ~25 | DEV-ONLY | These test local file I/O. Tag as `@dev-only` for transport-specific tests. Do NOT remove. |
| Tests that mock `firecrest-adapter.FilesystemGateway` for ProvenanceRecord read/write | (from FCREST phases) | PRODUCTION | Ensure these exist and are tagged `@production`. |
| Tests that verify ProvenanceRecord immutability (INV-P1) | ~10 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify full reproducibility tuple (INV-P2) | ~10 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify write-before-consumption gating (INV-P3, INV-D3) | ~10 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify Provenance survives Session end (INV-P4) | ~5 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify quarantine and reconstruction (R11) | ~5 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify ProvenanceRecord write failure → retry + no output registration (FM-P1) | ~5 | MODIFY | Update to mock FirecREST HTTP error (503, 500, timeout) for production tests. Keep local filesystem error version as `@dev-only`. |
| New: tests for large ProvenanceRecord (>5MB) async write | 0 | ADD | Production test. Verify that ProvenanceRecords >5MB use the async `/transfer/upload` endpoint and are polled for completion. |

### Which ADRs are affected

- None directly. Provenance is transport-agnostic by design — the
  `ProvenanceService` interface is stable, and the implementation is
  selected by the `--backend` flag. F-INV-7 applies.

---

## 5. `data-management` — C3 Data Management (Phase 3, 90 tests)

### What changes

- In production, file operations (stat, read, write, list, exists,
  isReadable, isWritable, mkdir) go through FirecREST filesystem
  endpoints instead of local `dsh-adapter.FilesystemGateway`:
  - `exists` / `stat` / `isReadable` / `isWritable` →
    `GET /filesystem/{system}/stat/{path}`
  - `readFile` (≤5MB) → `GET /filesystem/{system}/ops/download`
  - `readFile` (>5MB) → `POST /filesystem/{system}/transfer/download`
  - `writeFile` (≤5MB) → `POST /filesystem/{system}/ops/upload`
  - `writeFile` (>5MB) → `POST /filesystem/{system}/transfer/upload`
  - `readDir` → `GET /filesystem/{system}/path/{path}`
  - `mkdir` → `PUT /filesystem/{system}/path/{path}`
- The `DatasetService` interface stays. The `FilesystemGateway`
  implementation is selected by the `--backend` flag:
  - **Production:** `firecrest-adapter.FilesystemGateway`
  - **Dev:** `dsh-adapter.FilesystemGateway`
- INV-D4 (Location resolves to a real path before use) is
  re-evaluated: "resolves" means a successful FirecREST stat response
  (200) instead of local `fs.existsSync()`.
- FM-D1 (quota exceeded), FM-D2 (filesystem slowdown), FM-D3 (file
  not found / permission denied) are re-evaluated for FirecREST HTTP
  error semantics.

### What stays the same

- The `Dataset`, `Format`, `Grid`, `Variable`, `Location` types.
- All data management invariants (INV-D1–D4), re-evaluated for
  FirecREST.
- The `DatasetService` interface: `registerDataset()`,
  `queryDataset()`, `listDatasets()`, `validateLocation()`,
  `markConsumable()`, `quarantineDataset()`.
- The Dataset immutability rule (INV-D1) and its enforcement (the
  module never provides write handles to input Datasets).
- The format/grid immutability rule (INV-D2).
- The Provenance-before-consumption gating (INV-D3, jointly enforced
  with `provenance`).
- FM-D4 (concurrent write conflict) — unchanged (domain-level
  detection, transport-agnostic).
- FM-D5 (corrupted ZARR store) — unchanged in principle (detected
  from Job result).

### Which tests are affected

| Test group | Count (approx) | Action | Notes |
|---|---|---|---|
| Tests that mock `dsh-adapter.FilesystemGateway` for file operations (exists, readFile, writeFile, stat, readDir, mkdir) | ~30 | DEV-ONLY | These test local file I/O. Tag as `@dev-only` for transport-specific tests. Do NOT remove. |
| Tests that mock `firecrest-adapter.FilesystemGateway` for file operations | (from FCREST phases) | PRODUCTION | Ensure these exist and are tagged `@production`. |
| Tests that verify Dataset immutability (INV-D1) | ~10 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify one Format, one Grid per Dataset (INV-D2) | ~10 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify Provenance before consumption (INV-D3) | ~10 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify `validateLocation()` is called before use (INV-D4) | ~10 | UNCHANGED | Interface-level, transport-agnostic. The implementation of `validateLocation()` changes (FirecREST stat vs local `fs`), but the test can mock the `FilesystemGateway` interface. |
| Tests that verify quota exceeded handling (FM-D1) | ~5 | MODIFY | Update to mock FirecREST HTTP error (quota exceeded) or Job FAILED with ENOSPC for production. Keep local version as `@dev-only`. |
| Tests that verify filesystem slowdown handling (FM-D2) | ~5 | MODIFY | Update to mock FirecREST API latency for production. Keep local version as `@dev-only`. |
| New: tests for large file (>5MB) async transfer in data-management | 0 | ADD | Production test. Verify that large file reads/writes use the async `/transfer/...` endpoints. |
| New: tests for 404 (not found) and 403 (permission denied) from FirecREST stat | 0 | ADD | Production test. Verify the Agent reports the specific error (404 vs. 403). |

### Which ADRs are affected

- None directly. Data management is transport-agnostic by design —
  the `DatasetService` interface is stable, and the
  `FilesystemGateway` implementation is selected by the `--backend`
  flag.

---

## 6. `tool-invocation` — C1 Tool Invocation (incl. CESM) (Phase 4, 133 tests)

### What changes

This module requires the most significant code changes (resolving
finding FCREST-01).

- **`invokeTool()` flow modified.** Under R14, the flow changes:
  - **Dev mode:** `invokeTool()` calls
    `environmentManagement.verifyEnvironment()` before entering the
    RUNNING phase (INV-T1 original). Dispatches on
    `request.executionModel` (`synchronous` → `ShellExecutor.execute()`,
    `parallel` → `scheduling.submitJob()`).
  - **Production:** `invokeTool()` does NOT call
    `environmentManagement.verifyEnvironment()` (the
    `EnvironmentService` dependency is absent). Instead, it constructs
    a Job script with `uenv start <spec> --` embedded before the Tool
    command (F-INV-5, elevated to primary). All ToolInvocations are
    submitted as SLURM Jobs via `scheduling.submitJob()` (F-INV-6,
    elevated to primary). The `executionModel` field is ignored —
    every ToolInvocation takes the parallel path.
  - The `EnvironmentService` dependency is made **optional** (nullable
    injection). When absent (production), the environment loading
    step is skipped and the uenv prefix is embedded in the Job script
    by the `FirecRESTShellExecutor` / `FirecRESTSubprocessRunner` or
    by `tool-invocation` itself.
  - Finding FCREST-01 (ADR-011 point 6 "No modification" is false) is
    resolved by this ADR. The "purely additive" framing is withdrawn.

- **Default `ResourceRequest` for formerly-synchronous
  ToolInvocations** (FP-INV-5, resolves FCREST-05). Under R14, a
  formerly-synchronous ToolInvocation (which has no
  `resourceRequest`) must be submitted as a SLURM Job. The FirecREST
  backend supplies a default `ResourceRequest` (1 node, 1 core,
  minimal memory, short wall time, default partition/QoS) when the
  ToolInvocation's `resourceRequest` is absent. The default is
  configurable in `FirecrestConfig.defaultResourceRequest`.
  - The validation at `tool-invocation-service.ts` lines 464–471
    (`if (request.executionModel === 'parallel' && !request.resourceRequest)
    throw InvalidParameters`) must be relaxed under FirecREST — or
    the default `ResourceRequest` must be supplied before validation.
  - The dispatch at line 634 (`if (request.executionModel === 'parallel')`)
    must always take the parallel branch under FirecREST.
  - The rejection at line 236 (`if (request.executionModel === 'parallel'
    && tool.executionModel === 'synchronous') throw`) must be removed
    or bypassed under FirecREST — a synchronous Tool can be submitted
    as a Job (the Job runs the synchronous command and exits).

- **ExitOutcome derivation from Job state.** Under R14, the
  ExitOutcome is derived from the Job's terminal state and exit code:
  - `COMPLETED` + exit code 0 → success
  - `COMPLETED` + non-zero exit code → failure (unless permissive)
  - `FAILED` + exit code (may include signal) → failure (Signal if
    exit code indicates signal)
  - `OUT_OF_MEMORY` → failure (Signal: SIGKILL)
  - `TIMEOUT` → failure (Signal: SIGTERM then SIGKILL)
  - `NODE_FAIL` → failure (not a signal — distinct terminal state)
  - `CANCELLED` → failure (not a signal — distinct terminal state)

### What stays the same

- The `ToolInvocation`, `Tool`, `CLITool`, `PythonTool`, `ModelTool`
  (CESM), `ExitOutcome`, `Case`, `CaseState`, `Compset` types.
- All tool-invocation invariants (INV-T1–T9), re-evaluated for
  FirecREST.
- The strict exit code policy (R4, ADR-008). Non-zero exit codes
  block output registration by default. Permissive mode is opt-in
  per ToolInvocation via `permissiveExitCodes`.
- The CESM Case lifecycle: `createCase()` → `configureCase()` →
  `buildCase()` → `submitCase()` → `monitorCase()` →
  `registerCaseOutput()`.
- The `ToolInvocationService` interface: `invokeTool()`,
  `createCase()`, `configureCase()`, `buildCase()`, `submitCase()`,
  `monitorCase()`, `registerCaseOutput()`, `getToolCatalog()`,
  `registerTool()`.
- The output registration gating (INV-T3): output Datasets are not
  registered unless the ExitOutcome indicates success.
- The input immutability rule (INV-T4): the module opens input
  Datasets for reading only, never for writing.
- The signal vs. exit-code distinction (INV-T5, re-evaluated): the
  Agent must not map OUT_OF_MEMORY or TIMEOUT to a synthetic exit
  code.

### Which tests are affected

| Test group | Count (approx) | Action | Notes |
|---|---|---|---|
| Tests that exercise synchronous `executionModel` dispatch (with `ShellExecutor` mock) | ~25 | DEV-ONLY | These test the synchronous execution path, which is not used in production. Tag as `@dev-only`. Do NOT remove. |
| Tests that exercise `environmentManagement.verifyEnvironment()` in the `invokeTool` flow | ~20 | DEV-ONLY | These test the environment verification step, which is absent in production. Tag as `@dev-only`. Do NOT remove. |
| Tests that exercise parallel `executionModel` dispatch (with `SchedulingService` mock) | ~15 | UNCHANGED | These test the parallel execution path, which is the only path in production. Interface-level (mock `SchedulingService`) tests are valid for both backends. |
| Tests that verify output registration gating (INV-T3) | ~10 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify input immutability (INV-T4) | ~5 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify signal vs. exit-code (INV-T5) | ~10 | MODIFY | Update to verify Job state (OUT_OF_MEMORY, TIMEOUT, FAILED with signal) for production. Keep local process signal version as `@dev-only`. |
| Tests that verify CESM Case lifecycle (INV-T6–T9) | ~15 | UNCHANGED | Domain logic, transport-agnostic. The lifecycle steps are the same; only the execution mechanism changes. |
| Tests that verify strict exit codes (R4, ADR-008) | ~10 | UNCHANGED | Domain logic, transport-agnostic. The exit code comes from the Job result in production. |
| Tests that use `SubprocessRunner` mock for tool execution | ~20 | DEV-ONLY | These test local subprocess execution. Tag as `@dev-only`. Do NOT remove. |
| New: tests that verify `invokeTool()` works without `EnvironmentService` | 0 | ADD | Production test. Verify the flow does not throw when `EnvironmentService` is absent. |
| New: tests that verify Job script contains `uenv start <spec> --` | 0 | ADD | Production test. Verify the uenv prefix is correctly embedded in the Job script. |
| New: tests that verify default `ResourceRequest` for formerly-sync ToolInvocations | 0 | ADD | Production test. Verify FP-INV-5: a default `ResourceRequest` is supplied when `request.resourceRequest` is absent. |
| New: tests that verify ExitOutcome derivation from Job state | 0 | ADD | Production test. Verify the ExitOutcome is correctly derived from the Job's terminal state and exit code. |
| New: tests that verify a synchronous Tool can be submitted as a Job | 0 | ADD | Production test. Verify that a Tool with `executionModel: 'synchronous'` is accepted (not rejected) when submitted as a Job under FirecREST. |
| New: tests for FP-FM-1 (default ResourceRequest too small → OOM) | 0 | ADD | Production test. Verify the Agent reports OUT_OF_MEMORY and suggests a larger `ResourceRequest`. |

### Which ADRs are affected

- **ADR-001** (CESM is a Tool) — **unchanged**. CESM is still a Model
  Tool in C1. The Case lifecycle is still a specialized
  ToolInvocation lifecycle.
- **ADR-008** (strict exit codes) — **unchanged**. The exit code comes
  from the Job result. Strict is still the default.
- **ADR-011** (superseded by ADR-012). ADR-011 point 6 ("No
  modification to existing modules") is explicitly withdrawn by
  ADR-012. The `tool-invocation` module IS modified for the
  FirecREST-only primary architecture.

---

## 7. `agent-interaction` — C7 Agent Interaction (Phase 5, 107 tests)

### What changes

- Minimal. The Agent already runs on the laptop under ADR-011. R14
  makes this the only production mode (the login-node mode is
  dev-only).
- Proactive Job reporting on Session start (`startSession()` →
  `queryJobsByUser()`) uses `FirecRESTSchedulingService` in
  production instead of the local SLURM CLI implementation.
  - **Production:** `agent-interaction` calls
    `FirecRESTSchedulingService.queryJobsByUser()` (via the
    `SchedulingService` interface).
  - **Dev:** `agent-interaction` calls the local SLURM CLI
    `queryJobsByUser()` (via the `SchedulingService` interface).
  - The interface is the same; only the implementation changes.
- The LLM adapter runs on the laptop. LLM latency is determined by
  the laptop's network to the LLM API, not by HPC network conditions.
- The `--backend` flag defaults to `firecrest` (FP-INV-1). The
  `startSession()` call may pass the backend configuration to the
  Session for context.

### What stays the same

- The `Session`, `User`, `Workflow`, `WorkflowStep`, `WorkflowState`,
  `Experiment`, `Action` types.
- All agent-interaction invariants (INV-W1–W4). Step inputs exist
  before start, failure halts downstream, Workflow describes real
  dependencies, Session outlives Jobs.
- The `AgentInteractionService` interface: `startSession()`,
  `endSession()`, `getSession()`, `reportJobStatus()`,
  `createWorkflow()`, `addWorkflowStep()`, `startWorkflow()`,
  `resumeWorkflow()`, `getWorkflowState()`, `createExperiment()`,
  `addWorkflowToExperiment()`, `addCaseToExperiment()`,
  `queryExperiments()`, `registerAction()`, `validateAction()`.
- The proactive Job reporting behavior (R7, ADR-007). On Session
  start, the Agent queries the Scheduler for all Jobs belonging to
  the User and reports their states. This is the default behavior,
  not on-demand.
- The LLM hallucination policy (R12, ADR-010). If the LLM generates a
  Tool name or parameters not in the catalog, the Agent refuses and
  asks the User for clarification.
- The Experiment-first-class decision (R2, ADR-002). Workflow
  persistence (R6, ADR-006). Session-outlives-Jobs (INV-W4, ADR-007).
- FM-A1–A4 are all unchanged. The LLM is a remote API in both dev and
  production. Running Jobs on the HPC are not affected by LLM
  unavailability (FM-A4).

### Which tests are affected

| Test group | Count (approx) | Action | Notes |
|---|---|---|---|
| Tests that exercise proactive Job reporting with local SLURM CLI mock (via `SchedulingService`) | ~15 | DEV-ONLY | These test the local scheduling transport. Tag as `@dev-only`. Do NOT remove. |
| Tests that exercise proactive Job reporting with FirecREST mock (via `SchedulingService`) | (from FCREST phases) | PRODUCTION | Ensure these exist and are tagged `@production`. |
| Tests that verify Session lifecycle (start, end, resume) | ~20 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify Workflow lifecycle (create, add step, start, resume, state) | ~20 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify Experiment lifecycle (create, add Workflow, add Case, query) | ~15 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify Action validation (LLM hallucination — refuse and ask) | ~15 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify INV-W1 (step inputs exist before start) | ~10 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify INV-W2 (failure halts downstream) | ~10 | UNCHANGED | Domain logic, transport-agnostic. |
| Tests that verify INV-W4 (Session outlives Jobs) | ~5 | UNCHANGED | Domain logic, transport-agnostic. |
| New: tests for FP-FM-2 (laptop crash during Job polling → resume via proactive reporting) | 0 | ADD | Production test. Verify that a Job submitted in Session A is discoverable in Session B via `queryJobsByUser()` after a laptop crash. |
| New: tests that verify `--backend` defaults to `firecrest` in agent-interaction | 0 | ADD | Production test. Verify that the Agent starts with the FirecREST backend by default. |

### Which ADRs are affected

- **ADR-002** (Experiment first-class) — **unchanged**.
- **ADR-006** (Workflow persistence) — **unchanged**.
- **ADR-007** (proactive Job reporting) — **unchanged**. The behavior
  is the same; only the transport changes.
- **ADR-010** (refuse and ask) — **unchanged**.
- **ADR-011** (superseded by ADR-012).

---

## Cross-Module Summary

### Test reclassification summary

| Module | Total tests (approx) | UNCHANGED | DEV-ONLY | PRODUCTION (existing) | ADD (new) |
|---|---|---|---|---|---|
| dsh-adapter | 162 | 162 | 162 (tag) | — | ~3 |
| scheduling | ~80 | ~35 | ~40 | (from FCREST) | ~1 |
| environment-management | ~120 | ~15 | ~95 | (from FCREST) | ~3 |
| provenance | ~80 | ~50 | ~25 | (from FCREST) | ~1 |
| data-management | 90 | ~50 | ~30 | (from FCREST) | ~2 |
| tool-invocation | 133 | ~80 | ~45 | (from FCREST) | ~6 |
| agent-interaction | 107 | ~95 | ~15 | (from FCREST) | ~2 |
| **Total** | **~772** | **~487** | **~412** | (varies) | **~18** |

Note: Some tests appear in both UNCHANGED and DEV-ONLY columns because
the "UNCHANGED" tests (domain logic) remain production, while the
"DEV-ONLY" tests (transport-specific) are reclassified. The two
columns are not mutually exclusive for tests within the same module —
a module can have both unchanged domain-logic tests and reclassified
transport-specific tests. The total column shows the approximate
number of tests per module (which may differ slightly from the
AGENTS.md count of 742 due to property and integration tests added in
post-audit).

### Code changes summary

| Module | Code changes required | Severity |
|---|---|---|
| dsh-adapter | None (tagged as dev-only; startup code selects backend) | LOW |
| scheduling | None (interface unchanged; `FirecRESTSchedulingService` already implemented) | LOW |
| environment-management | Runtime service tagged as dev-only; new `buildUenvScriptPrefix()` utility; types exported for use by `tool-invocation` | MEDIUM |
| provenance | None (interface unchanged; `FirecRESTFilesystemGateway` already implemented) | LOW |
| data-management | None (interface unchanged; `FirecRESTFilesystemGateway` already implemented) | LOW |
| tool-invocation | `invokeTool()` modified: optional `EnvironmentService`, uenv in Job scripts, always parallel, default `ResourceRequest`. Resolves FCREST-01 and FCREST-05. | HIGH |
| agent-interaction | Minimal (proactive Job reporting uses `FirecRESTSchedulingService` mock; already implemented in FCREST phases) | LOW |
| Startup code | `--backend` defaults to `firecrest`; `--backend dev` selects `dsh-adapter` | MEDIUM |

### ADR impact summary

| ADR | Impact | Notes |
|---|---|---|
| ADR-001 (CESM is Tool) | Unchanged | |
| ADR-002 (Experiment) | Unchanged | |
| ADR-003 (uenv not Lmod) | Re-evaluated | Loading location: cera → Job script. Not deleted. |
| ADR-004 (SLURM only) | Unchanged | FirecREST is a transport, not a scheduler. |
| ADR-005 (dsh isolation) | Unchanged | Still applies for dev mode. |
| ADR-006 (Workflow persistence) | Unchanged | |
| ADR-007 (proactive Job reporting) | Unchanged | |
| ADR-008 (strict exit codes) | Unchanged | |
| ADR-009 (—) | Unchanged | |
| ADR-010 (refuse and ask) | Unchanged | |
| ADR-011 (FirecREST as 2nd backend) | **Superseded by ADR-012** | Not deleted (append-only). Analysis valid for dev mode. |
| ADR-012 (FirecREST only prod) | **New** | This ADR. |

### Finding resolution summary

| Finding | Resolution |
|---|---|
| FCREST-01 (no modification contradicts F-INV-5/6) | Resolved by ADR-012. The "no modification" claim is withdrawn. `tool-invocation` is modified for the FirecREST-only primary. |
| FCREST-05 (synchronous ToolInvocations lack ResourceRequest) | Resolved by R14.4 / FP-INV-5. A default `ResourceRequest` is supplied by the FirecREST backend when `request.resourceRequest` is absent. |
