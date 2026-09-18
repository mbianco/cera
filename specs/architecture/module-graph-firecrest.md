# Module Graph — FirecREST-Only Primary (R14, ADR-012)

> This document supersedes `module-graph.md` for the **production
> path**. The original `module-graph.md` is NOT deleted (append-only);
> it remains valid for the `--backend dev` code path.
>
> Under R14 (ADR-012), FirecREST is the **only** production HPC
> transport. dsh runs on the laptop. The local backend
> (dsh-adapter wrapping local subprocess) is demoted to
> `--backend dev` for testing only. All ToolInvocations are
> parallel — submitted as SLURM Jobs via FirecREST. uenv is always
> loaded in Job scripts.
>
> Each module below is annotated with:
> - **Production status** — PRODUCTION, DEV-ONLY, or UNCHANGED
> - **What changes** — under R14
> - **What stays the same** — interfaces, types, domain logic
> - **dsh mount point** — the dsh extension point the module mounts
>   on (for dsh-adapter) or that is replaced by FirecREST (for
>   production)

---

## Overview

### Production path (default: `--backend firecrest`)

```
Laptop
┌─────────────────────────────────────────────────────┐
│  dsh (agent loop, LLM adapter, session, tool reg)   │
│                    │                                 │
│  ┌─────────────────▼──────────────┐                  │
│  │ firecrest-adapter               │  HTTPS + JWT    │
│  │ (ShellExecutor, SubprocessRunner│────────────────┐ │
│  │  FilesystemGateway,             │               │ │
│  │  SchedulingService)              │               │ │
│  └─────────────────┬──────────────┘               │ │
│                    │                               │ │
│  ┌─────────────────▼──────────────┐               │ │
│  │ domain modules                 │               │ │
│  │  tool-invocation (all parallel)│               │ │
│  │  scheduling (via FirecREST)    │               │ │
│  │  provenance (via FirecREST FS) │               │ │
│  │  data-management (via FirecREST FS)│           │ │
│  │  agent-interaction (Session,   │               │ │
│  │    Workflow, Action)           │               │ │
│  └────────────────────────────────┘               │ │
└─────────────────────────────────────────────────────┘ │
                                                        │
┌───────────────────────────────────────────────────────▼─┐
│  HPC (Alps)                                              │
│  ┌──────────┐   ┌─────────┐   ┌──────────────────┐      │
│  │FirecREST │──▶│  SLURM  │──▶│  Compute Nodes   │      │
│  │ (server) │   │(control)│   │ (Jobs run here)  │      │
│  └──────────┘   └─────────┘   └──────────────────┘      │
│                                                          │
│  ┌─────────────────────────────────────────────┐        │
│  │  HPC Filesystem (scratch, store)            │        │
│  │  Datasets, Provenance, Job I/O              │        │
│  └─────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────┘
```

### Dev-only path (`--backend dev`)

```
Login Node or Local Machine (dev only)
┌─────────────────────────────────────────────────────┐
│  dsh (agent loop, LLM adapter, session, tool reg)   │
│                    │                                 │
│  ┌─────────────────▼──────────────┐                  │
│  │ dsh-adapter                     │  local subs proc │
│  │ (ShellExecutor, SubprocessRunner│                  │
│  │  FilesystemGateway, JobBackend, │                  │
│  │  ToolRegistry, CommandRegistry) │                  │
│  └─────────────────┬──────────────┘                  │
│                    │                                 │
│  ┌─────────────────▼──────────────┐                  │
│  │ domain modules (same as prod)  │                  │
│  │  tool-invocation (sync + para) │                  │
│  │  scheduling (SLURM CLI)        │                  │
│  │  environment-management (uenv CLI)│               │
│  │  provenance (local fs)          │                  │
│  │  data-management (local fs)     │                  │
│  │  agent-interaction              │                  │
│  └────────────────────────────────┘                  │
└──────────────────────────────────────────────────────┘
```

### Module summary table

| Module | Bounded context | Production status | What changes | dsh mount (dev) | FirecREST endpoint (prod) |
|--------|----------------|-------------------|--------------|-----------------|---------------------------|
| `dsh-adapter` | (infrastructure) | **DEV-ONLY** | Tagged as dev-only; no code changes | all (`ctx.*`) | — (not used in prod) |
| `firecrest-adapter` | (infrastructure) | **PRODUCTION** | Unchanged (already implements right interfaces) | — | REST API (HTTPS + JWT) |
| `scheduling` | C4 — SLURM | **PRODUCTION** (via FirecREST) | CLI impl tagged dev-only; `FirecRESTSchedulingService` is prod | `ctx.jobs`, `ctx.subprocess` | `POST/GET/DELETE /compute/{system}/jobs` |
| `environment-management` | C5 — uenv | **DEV-ONLY** (runtime service); types are PRODUCTION | Runtime service (env-service, uenv-parser, conflict-detector) tagged dev-only; domain types stay for Job script construction | `ctx.subprocess`, `ctx.fs` | — (uenv loaded in Job script) |
| `provenance` | C6 — Provenance | **UNCHANGED** (interface stable) | Implementation uses FirecREST FS gateway in prod (already done) | `ctx.fs` | `GET/POST /filesystem/{system}/ops/*` |
| `data-management` | C3 — Data Mgmt | **UNCHANGED** (interface stable) | Implementation uses FirecREST FS gateway in prod (already done) | `ctx.fs` | `GET/POST /filesystem/{system}/ops/*`, `PUT /filesystem/{system}/path/*` |
| `tool-invocation` | C1 — Tool Invocation | **PRODUCTION** (modified) | `invokeTool()` modified: optional `EnvironmentService`, all parallel, uenv in Job scripts, default `ResourceRequest` | `ctx.tools`, `ctx.shell`, `ctx.subprocess` | Via `firecrest-adapter.ShellExecutor` |
| `agent-interaction` | C7 — Agent Interaction | **UNCHANGED** | Proactive Job reporting uses `FirecRESTSchedulingService` in prod (already done) | `ctx.tools`, `ctx.commands` | — (uses `SchedulingService` interface) |
| `startup` (new) | (infrastructure) | **PRODUCTION** | New: `createCeraSystem()` factory, backend selection | — | — |

---

## Module Details

### 1. `dsh-adapter` — dsh Isolation Layer

**Production status: DEV-ONLY**

Under R14, the dsh-adapter is the **dev-only backend**. In
production, the `firecrest-adapter` provides the same interfaces
(`ShellExecutor`, `SubprocessRunner`, `FilesystemGateway`,
`SchedulingService`). The `--backend dev` flag selects the
dsh-adapter at startup (FP-INV-2: local backend is not a
production path).

**What changes:**
- The dsh-adapter is tagged as **dev-only**. No code changes to
  the adapter itself.
- The startup code (`src/startup.ts`) selects the dsh-adapter only
  when `--backend dev` is specified (FP-INV-1: `--backend` defaults
  to `firecrest`).
- Tests that exercise the dsh-adapter are tagged `@dev-only`.

**What stays the same:**
- All 7 adapter interfaces (`ShellExecutor`, `SubprocessRunner`,
  `SandboxRunner`, `FilesystemGateway`, `JobBackend`,
  `ToolRegistry`, `CommandRegistry`) — unchanged.
- The dsh isolation layer (ADR-005) — still applies for dev mode.
- The version pinning in `package.json`.
- The internal implementation — wraps `ctx.shell`, `ctx.subprocess`,
  `ctx.sandbox`, `ctx.fs`, `ctx.jobs`, `ctx.tools`, `ctx.commands`.

**dsh extension point:** All (`ctx.shell`, `ctx.subprocess`,
`ctx.sandbox`, `ctx.fs`, `ctx.jobs`, `ctx.tools`, `ctx.commands`).
This is the **only** module that imports dsh directly. In
production, no module imports dsh — they import `firecrest-adapter`
or the shared interface types.

**Spec references:** `assumptions.md` A1; `resolutions-r14.md`
R14.5; `invariants-firecrest-primary.md` FP-INV-1, FP-IG-2;
`failure-modes-firecrest-primary.md` FM-X3; ADR-005, ADR-012.

---

### 2. `firecrest-adapter` — FirecREST REST Adapter (NEW — PRODUCTION)

**Production status: PRODUCTION**

Under R14, the firecrest-adapter is the **only production backend**.
It implements the same interfaces as the dsh-adapter
(`ShellExecutor`, `SubprocessRunner`, `FilesystemGateway`) plus
`SchedulingService` (replacing the SLURM CLI implementation).
Domain modules receive these interfaces at startup and never see
the FirecREST HTTP client or JWT token.

**What changes:**
- **Nothing.** The firecrest-adapter already implements the right
  interfaces (from the ADR-011 phases). Under R14, it is simply
  selected as the default backend instead of being "the second
  backend."

**What stays the same:**
- `FirecrestConfig` with `defaultResourceRequest` (FCREST-05, already
  done — `src/firecrest-adapter/types.ts` lines 87-111).
- `FirecrestShellExecutor` — implements `ShellExecutor` by
  submitting all commands as SLURM Jobs (F-INV-6). Already done
  (`src/firecrest-adapter/shell-executor.ts`).
- `buildJobScript()` — constructs Job scripts with `uenv start <spec>
  --` prefix (F-INV-5). Already done
  (`src/firecrest-adapter/job-script-builder.ts`).
- `FirecrestBackend` aggregate — `ShellExecutor`, `SubprocessRunner`,
  `FilesystemGateway`, `SchedulingService`.
- All FirecREST error types (FM-F-1 through FM-F-9).

**dsh extension point:** None. The firecrest-adapter does not
import dsh. It replaces dsh's extension points with FirecREST REST
endpoints.

**FirecREST endpoints (production):**
- Job management: `POST /compute/{system}/jobs`,
  `GET /compute/{system}/jobs/{id}`,
  `DELETE /compute/{system}/jobs/{id}`
- Filesystem: `GET /filesystem/{system}/stat/{path}`,
  `GET /filesystem/{system}/ops/download`,
  `POST /filesystem/{system}/ops/upload`,
  `POST /filesystem/{system}/transfer/{download|upload}`,
  `GET /filesystem/{system}/path/{path}`,
  `PUT /filesystem/{system}/path/{path}`
- Status: `GET /status/systems`,
  `GET /status/{system}/healthchecks`

**Spec references:** `resolutions-r14.md` R14.2;
`invariants-firecrest-primary.md` F-INV-1 through F-INV-7, FP-INV-1;
`failure-modes-firecrest-primary.md` FM-F-1 through FM-F-9;
`assumptions.md` F-A-1 through F-A-4; ADR-011, ADR-012.

---

### 3. `scheduling` — C4 Scheduling (SLURM)

**Production status: PRODUCTION (via FirecREST); CLI is DEV-ONLY**

Under R14, the SLURM CLI implementation (sbatch, squeue, scancel via
`dsh-adapter.SubprocessRunner`) is **dev-only**. In production,
`FirecRESTSchedulingService` implements the `SchedulingService`
interface via FirecREST compute endpoints.

**What changes:**
- The SLURM CLI implementation (`scheduling/scheduling-service.ts`)
  is tagged as **dev-only**. It remains for `--backend dev` mode.
- `FirecRESTSchedulingService` (from `firecrest-adapter`) is the
  **production** implementation. It is already implemented.
- The `--backend` flag selects which implementation is injected into
  domain modules at startup via `createCeraSystem()`.
- INV-S1 is re-evaluated: the source of authority changes from
  SLURM CLI (squeue/sacct) to SLURM via FirecREST REST API
  (`GET /compute/{system}/jobs/{id}`).

**What stays the same:**
- The `SchedulingService` interface: `submitJob()`, `queryJob()`,
  `queryJobsByUser()`, `cancelJob()`, `reconcileViaSacct()`.
- The `Job`, `JobId`, `ResourceRequest`, `JobState` types.
- The SLURM-only decision (R8, ADR-004). FirecREST is a transport,
  not a different scheduler.
- The proactive Job reporting behavior (R7, ADR-007).
- The UNKNOWN state policy (R13) — if FirecREST is unreachable,
  Jobs are marked UNKNOWN. 30-minute UNKNOWN is acceptable.
- The `reconcileViaSacct()` method — in production, this maps to a
  fresh FirecREST job query (instead of `sacct` CLI).

**dsh extension point (dev only):** `ctx.jobs` (via
`dsh-adapter.JobBackend`), `ctx.subprocess` (via
`dsh-adapter.SubprocessRunner` for SLURM CLI).

**FirecREST endpoints (production):** `POST /compute/{system}/jobs`,
`GET /compute/{system}/jobs/{id}`, `DELETE /compute/{system}/jobs/{id}`.

**Spec references:** `domain-model.md` C4;
`invariants-firecrest-primary.md` INV-S1 (RE-EVALUATED), INV-S2–S4;
`resolutions-r14.md` R14.6; `failure-modes-firecrest-primary.md`
FM-S1 (RE-EVALUATED), FM-S2 (DEV-ONLY), FM-S3–S4 (RE-EVALUATED);
`impact-analysis.md` §2; ADR-004, ADR-007, ADR-012.

---

### 4. `environment-management` — C5 Environment Management (uenv)

**Production status: DEV-ONLY (runtime service); types are PRODUCTION**

This is the most significantly affected module. Under R14, the
runtime `EnvironmentService` (uenv CLI commands via
`SubprocessRunner`) is **removed from the production path**. cera
never calls `uenv mount`, `uenv status`, or any uenv CLI command
directly in production. Instead, cera embeds `uenv start <spec> --`
in the Job script submitted via FirecREST.

**What changes:**
- **Runtime service implementation** (`environment-service.ts`,
  `uenv-parser.ts`, `conflict-detector.ts`) becomes **dev-only**.
  These files call uenv CLI commands via
  `dsh-adapter.SubprocessRunner` and are only used when
  `--backend dev` is specified.
- **Domain types** (`Environment`, `UenvSpec`, `Module`,
  `Conflict`) **stay and are used by `tool-invocation`** to
  construct Job scripts. The types are always available (both
  production and dev).
- A new utility may be needed: `buildUenvScriptPrefix(specs:
  UenvSpec[]): string` — constructs the `uenv start <spec> --`
  prefix for the Job script. This is production-safe (no
  `SubprocessRunner` dependency). The `firecrest-adapter/job-script-builder.ts`
  already implements this as `buildJobScript()` with
  `BuildJobScriptOptions.uenvSpecs`.
- INV-E1 (one active Environment per execution context) is
  re-evaluated: the execution context is now the SLURM Job, not
  the cera process.
- INV-E2 (conflict detection before execution) is re-evaluated:
  conflict detection happens at uenv mount time inside the Job,
  not by cera before Job submission.
- INV-E3 (Module availability verified before load) is **removed
  from the production path** (DEV-ONLY).
- FM-E1, FM-E2, FM-E3 are **DEV-ONLY**. In production, they are
  replaced by FM-F-9 (uenv not available in Job script).

**What stays the same:**
- The domain types: `Environment`, `UenvSpec`, `Module`,
  `Conflict`. These are used by `tool-invocation` to construct Job
  scripts in both production and dev mode.
- The `EnvironmentService` interface (for dev mode).
- The uenv-not-Lmod decision (R9, ADR-003). uenv is still the
  mechanism; the loading location changes from cera (login node)
  to the Job script (compute node).
- The bounded context C5 — it still owns the Environment aggregate
  and its types.

**dsh extension point (dev only):** `ctx.subprocess` (via
`dsh-adapter` for uenv CLI commands), `ctx.fs` (via
`dsh-adapter` for mount path verification).

**Production path:** No dsh extension point. The uenv is loaded
inside the Job via `uenv start <spec> --` embedded by
`firecrest-adapter/job-script-builder.ts` (F-INV-5). The
`tool-invocation` module uses the `Environment` types to construct
the Job script but does NOT call the `EnvironmentService` runtime
methods.

**Spec references:** `domain-model.md` C5;
`invariants-firecrest-primary.md` INV-E1 (RE-EVALUATED), INV-E2
(RE-EVALUATED), INV-E3 (REMOVED/DEV-ONLY), FP-INV-3;
`resolutions-r14.md` R14.3;
`failure-modes-firecrest-primary.md` FM-E1 (DEV-ONLY), FM-E2
(DEV-ONLY), FM-E3 (DEV-ONLY), FM-F-9 (PRODUCTION-ONLY);
`impact-analysis.md` §3; ADR-003 (re-evaluated), ADR-012.

---

### 5. `provenance` — C6 Provenance

**Production status: UNCHANGED (interface stable; backend selected at startup)**

Under R14, ProvenanceRecords are written and read via FirecREST
filesystem endpoints (F-INV-7). The `ProvenanceService` interface
is unchanged. The implementation is selected by the `--backend`
flag:
- **Production:** uses `firecrest-adapter.FilesystemGateway` (HTTP
  to FirecREST filesystem endpoints)
- **Dev:** uses `dsh-adapter.FilesystemGateway` (local `fs`)

**What changes:**
- In production, ProvenanceRecords are written via
  `POST /filesystem/{system}/ops/upload` (≤5MB) or
  `POST /filesystem/{system}/transfer/upload` (>5MB, async).
- FM-P1 (ProvenanceRecord write failure) is re-evaluated: the
  failure manifests as an HTTP error (503, 500, timeout) instead
  of a local filesystem error. The retry logic is the same.

**What stays the same:**
- The `ProvenanceService` interface: `writeProvenanceRecord()`,
  `queryProvenanceRecord()`, `queryProvenanceForJob()`,
  `queryLineage()`, `verifyProvenance()`,
  `reconstructProvenanceRecord()`, `quarantineDataset()`.
- The `ProvenanceRecord` type and its fields.
- All provenance invariants (INV-P1–P4) — UNCHANGED.
- The write-before-consumption gating logic (INV-D3, INV-P3).
- The corrupted-ProvenanceRecord policy (R11: local, not systemic).

**dsh extension point (dev only):** `ctx.fs` (via
`dsh-adapter.FilesystemGateway` for persistence).

**FirecREST endpoints (production):**
`POST /filesystem/{system}/ops/upload` (sync, ≤5MB),
`POST /filesystem/{system}/transfer/upload` (async, >5MB),
`GET /filesystem/{system}/ops/download` (sync, ≤5MB),
`POST /filesystem/{system}/transfer/download` (async, >5MB).

**Spec references:** `domain-model.md` C6;
`invariants-firecrest-primary.md` INV-P1–P4 (UNCHANGED), F-INV-7
(PRODUCTION-ONLY); `failure-modes-firecrest-primary.md` FM-P1
(RE-EVALUATED), FM-P2–P3 (UNCHANGED); `impact-analysis.md` §4.

---

### 6. `data-management` — C3 Data Management

**Production status: UNCHANGED (interface stable; backend selected at startup)**

Under R14, file operations (stat, read, write, list, exists,
isReadable, isWritable, mkdir) go through FirecREST filesystem
endpoints in production instead of local
`dsh-adapter.FilesystemGateway`. The `DataManagementService`
interface is unchanged. The `FilesystemGateway` implementation is
selected by the `--backend` flag.

**What changes:**
- In production, `validateLocation()` uses the FirecREST stat
  endpoint (`GET /filesystem/{system}/stat/{path}`) instead of
  local `fs.existsSync()`. A 404 means not found; a 403 means
  permission denied.
- FM-D1 (quota exceeded), FM-D2 (filesystem slowdown), FM-D3 (file
  not found / permission denied) are re-evaluated for FirecREST
  HTTP error semantics.

**What stays the same:**
- The `DataManagementService` interface: `registerDataset()`,
  `queryDataset()`, `listDatasets()`, `validateLocation()`,
  `markConsumable()`, `quarantineDataset()`.
- The `Dataset`, `Format`, `Grid`, `Variable`, `Location` types.
- All data management invariants (INV-D1–D4) — D1–D3 UNCHANGED,
  D4 RE-EVALUATED (resolution via FirecREST stat).
- FM-D4 (concurrent write conflict) — UNCHANGED (domain-level).
- FM-D5 (corrupted ZARR store) — UNCHANGED in principle.

**dsh extension point (dev only):** `ctx.fs` (via
`dsh-adapter.FilesystemGateway` for filesystem access and
Location validation).

**FirecREST endpoints (production):**
`GET /filesystem/{system}/stat/{path}` (stat, exists, isReadable, isWritable),
`GET /filesystem/{system}/ops/download` (readFile ≤5MB),
`POST /filesystem/{system}/ops/upload` (writeFile ≤5MB),
`POST /filesystem/{system}/transfer/download` (readFile >5MB),
`POST /filesystem/{system}/transfer/upload` (writeFile >5MB),
`GET /filesystem/{system}/path/{path}` (readDir),
`PUT /filesystem/{system}/path/{path}` (mkdir).

**Spec references:** `domain-model.md` C3;
`invariants-firecrest-primary.md` INV-D1–D3 (UNCHANGED), INV-D4
(RE-EVALUATED); `failure-modes-firecrest-primary.md` FM-D1
(RE-EVALUATED), FM-D2 (RE-EVALUATED), FM-D3 (RE-EVALUATED), FM-D4
(UNCHANGED), FM-D5 (UNCHANGED); `impact-analysis.md` §5.

---

### 7. `tool-invocation` — C1 Tool Invocation (including CESM)

**Production status: PRODUCTION (modified)**

This module requires the most significant code changes under R14
(resolving finding FCREST-01). Under R14, the `invokeTool()` flow
no longer calls `EnvironmentService` (which is absent in
production). Instead, the Job script is constructed with `uenv
start <spec> --` embedded before the Tool command. The
`executionModel` field is **ignored in production** — all
ToolInvocations are submitted as SLURM Jobs. A default
`ResourceRequest` is supplied for formerly-synchronous
ToolInvocations that have no `resourceRequest` (FP-INV-5, resolves
FCREST-05).

**What changes:**
- **Optional `EnvironmentService`:** `ToolInvocationServiceImplProps.
  environment` is now optional (`?: EnvironmentService`). When
  absent (production), the environment verification step is
  skipped and a placeholder `EnvironmentId` is used for the
  ProvenanceRecord. **Already done** (FCREST-01 fix,
  `tool-invocation-service.ts` lines 358, 399, 553-599).
- **All parallel dispatch:** Under R14, when `EnvironmentService`
  is absent (production), the `invokeTool()` flow should **always
  take the parallel path**, regardless of `request.executionModel`.
  The `executionModel` field is ignored. **This is the key
  remaining implementation change** — the current code at line 664
  still dispatches on `request.executionModel`. See
  `build-phases-firecrest.md` Phase B for details.
- **Default `ResourceRequest` (FP-INV-5):** When `request.
  resourceRequest` is absent and the `EnvironmentService` is absent
  (production), the `FirecrestConfig.defaultResourceRequest` should
  be supplied. **Not yet done** — the current code at line 473
  still throws `InvalidParameters` for `parallel` invocations
  without `resourceRequest`, and `#executeParallel` at line 965
  also throws. See `build-phases-firecrest.md` Phase B for details.
- **`validateExecutionModel` bypass:** Under R14, a `synchronous`
  Tool can be submitted as a Job (the Job runs the synchronous
  command and exits). The validation at line 237 that rejects
  `parallel` requests for `synchronous` Tools should be bypassed
  in production. **Not yet done.** See `build-phases-firecrest.md`
  Phase B for details.
- **ExitOutcome derivation from Job state:** The ExitOutcome is
  derived from the Job's terminal state and exit code (already done
  via `jobStateToExitOutcome()` at lines 145-164 and
  `deriveExitOutcome()` in `firecrest-adapter/shell-executor.ts`).

**What stays the same:**
- The `ToolInvocation`, `Tool`, `CLITool`, `PythonTool`,
  `ModelTool` (CESM), `ExitOutcome`, `Case`, `CaseState`, `Compset`
  types.
- All tool-invocation invariants (INV-T1–T9) — re-evaluated for
  FirecREST.
- The strict exit code policy (R4, ADR-008).
- The CESM Case lifecycle: `createCase()` → `configureCase()` →
  `buildCase()` → `submitCase()` → `monitorCase()` →
  `registerCaseOutput()`.
- The `ToolInvocationService` interface: `invokeTool()`,
  `monitorInvocation()`, `createCase()`, `configureCase()`,
  `buildCase()`, `submitCase()`, `monitorCase()`,
  `registerCaseOutput()`, `getToolCatalog()`, `registerTool()`.
- The output registration gating (INV-T3).
- The input immutability rule (INV-T4).
- The signal vs. exit-code distinction (INV-T5, re-evaluated).

**dsh extension point (dev only):** `ctx.tools` (via
`dsh-adapter.ToolRegistry`), `ctx.shell` (via
`dsh-adapter.ShellExecutor`), `ctx.subprocess` (via
`dsh-adapter.SubprocessRunner`), `ctx.sandbox` (via
`dsh-adapter.SandboxRunner`).

**Production path:** Uses `firecrest-adapter.ShellExecutor` for
all Tool execution. The `FirecrestShellExecutor` always submits
Jobs via `POST /compute/{system}/jobs` (F-INV-6). The uenv specs
are passed via `UENV_SPECS_KEY` in `ShellExecuteOptions.env` and
embedded in the Job script by `buildJobScript()` (F-INV-5).

**Spec references:** `domain-model.md` C1;
`invariants-firecrest-primary.md` INV-T1 (RE-EVALUATED), INV-T2–T4
(UNCHANGED), INV-T5 (RE-EVALUATED), INV-T6–T9 (UNCHANGED), FP-INV-5
(NEW); `resolutions-r14.md` R14.3, R14.4;
`failure-modes-firecrest-primary.md` FM-T1–T5, FM-F-9, FP-FM-1
(NEW); `impact-analysis.md` §6; ADR-001, ADR-008, ADR-012.

---

### 8. `agent-interaction` — C7 Agent Interaction (including Experiment, Workflow)

**Production status: UNCHANGED**

Minimal changes under R14. The Agent already runs on the laptop
under ADR-011. R14 makes this the only production mode (the
login-node mode is dev-only). Proactive Job reporting on Session
start uses `FirecRESTSchedulingService` in production (already
implemented from FCREST phases).

**What changes:**
- Proactive Job reporting on Session start
  (`startSession()` → `queryJobsByUser()`) uses
  `FirecRESTSchedulingService` in production instead of the local
  SLURM CLI implementation. The interface is the same; only the
  implementation changes. **Already done** (FCREST phases).
- FP-FM-2 (laptop crash during Job polling) is a new failure mode.
  On the next Session start, the Agent discovers the in-flight Job
  via `queryJobsByUser()` (R7, INV-W4).

**What stays the same:**
- The `Session`, `User`, `Workflow`, `WorkflowStep`,
  `WorkflowState`, `Experiment`, `Action` types.
- All agent-interaction invariants (INV-W1–W4) — UNCHANGED.
- The `AgentInteractionService` interface — UNCHANGED.
- The proactive Job reporting behavior (R7, ADR-007).
- The LLM hallucination policy (R12, ADR-010).
- FM-A1–A4 — UNCHANGED.

**dsh extension point (dev only):** `ctx.tools` (via
`dsh-adapter.ToolRegistry` for registering Actions as
model-facing capabilities), `ctx.commands` (via
`dsh-adapter.CommandRegistry` for human-command dispatch).

**Production path:** Uses the `SchedulingService` interface (which
is `FirecRESTSchedulingService` in production) for proactive Job
reporting. No dsh extension points in production.

**Spec references:** `domain-model.md` C7;
`invariants-firecrest-primary.md` INV-W1–W4 (UNCHANGED);
`resolutions-r14.md` R14.1;
`failure-modes-firecrest-primary.md` FM-A1–A4 (UNCHANGED), FM-X2
(DEV-ONLY), FP-FM-2 (NEW); `impact-analysis.md` §7; ADR-002,
ADR-006, ADR-007, ADR-010, ADR-012.

---

### 9. `startup` — Backend Selection and System Factory (NEW)

**Production status: PRODUCTION**

A new module that provides the `createCeraSystem()` factory. This
is the single entry point that the CLI calls to wire all 7 modules
based on the selected backend. For `type: 'firecrest'`, it creates
all FirecREST-backed interfaces. For `type: 'dev'`, it creates all
dsh-adapter-backed interfaces (the original local backend).

**Owned entities:** `BackendSelection`, `CeraSystemConfig`,
`CeraSystem`.

**Public surface:**
- `createCeraSystem(config: CeraSystemConfig): CeraSystem` —
  factory that wires all 7 modules.
- `BackendSelection` — `{ type: 'firecrest' | 'dev'; firecrestConfig?:
  FirecrestConfig }` — selects which adapter is instantiated.
- `CeraSystemConfig` — all configuration needed to wire the system.
- `CeraSystem` — aggregate of all service interfaces.

**dsh extension point:** None. The startup module imports both
`dsh-adapter` and `firecrest-adapter` and selects between them
based on `BackendSelection.type`. It is the **only** module that
imports both adapters. Domain modules receive the selected
interfaces and never see which adapter is active.

**Spec references:** `resolutions-r14.md` R14.7;
`invariants-firecrest-primary.md` FP-INV-1, FP-INV-2;
`api-contracts-firecrest.md` (BackendSelection, CeraSystemConfig,
CeraSystem, createCeraSystem); `src/startup.ts`.

---

## Feature-to-Module Mapping (unchanged)

Every Gherkin feature maps to exactly one primary module (same as
`module-graph.md`). The module boundaries are unchanged by R14;
only the backend implementations and the `tool-invocation` dispatch
logic change.

| Feature file | Primary module | Cross-module deps exercised |
|---|---|---|
| `cdo-operations.feature` | `tool-invocation` | env-mgmt, data-mgmt, provenance |
| `nco-operations.feature` | `tool-invocation` | env-mgmt, data-mgmt, provenance |
| `cesm-submission.feature` | `tool-invocation` | env-mgmt, data-mgmt, scheduling, provenance |
| `grid-conversion.feature` | `tool-invocation` | env-mgmt, data-mgmt, provenance |
| `zarr-io.feature` | `tool-invocation` / `data-management` | env-mgmt, data-mgmt, provenance |
| `environment-management.feature` | `environment-management` | (via X1, called by tool-invocation) |
| `job-management.feature` | `scheduling` | (via X2, X8 called by tool-invocation, agent-interaction) |
| `provenance.feature` | `provenance` | data-mgmt, tool-invocation |
| `workflow-execution.feature` | `agent-interaction` | tool-invocation, data-mgmt, provenance, scheduling |
| `opengrads-evaluation.feature` | `tool-invocation` (if approved) | env-mgmt, data-mgmt, provenance |
| `firecrest-backend.feature` | `firecrest-adapter` | (via startup, tool-invocation, scheduling, data-mgmt, provenance) |

---

## Naming Conformance

- **BackendType** — `'firecrest' | 'dev'` (NOT `'local'`). The
  `--backend local` flag is replaced by `--backend dev` per R14.7.
- **uenv** (not "Lmod" or "Module") used for environment loading
  (R9). The `Module` value object is retained as a uenv component
  descriptor.
- **SLURM** used directly, no `Scheduler` abstraction in domain
  types (R8). FirecREST is a transport, not a different scheduler.
- **ToolInvocation** (not "Operation" or "Command") for the
  C1 aggregate root.
- **Action** (not "Operator") used for LLM-facing operations (R3).
