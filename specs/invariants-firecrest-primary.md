# Invariants — FirecREST-Only Primary Architecture

> This document classifies every invariant from `invariants.md`
> (INV-T1–T9, INV-D1–D4, INV-S1–S4, INV-E1–E3, INV-P1–P4, INV-W1–W4)
> and every invariant from `specs/firecrest/invariants.md`
> (F-INV-1 through F-INV-7) under the FirecREST-only primary
> architecture (R14, ADR-012).
>
> Each invariant is classified as:
> - **UNCHANGED** — text and enforcement are the same.
> - **RE-EVALUATED** — still holds, but enforcement mechanism changes.
> - **REMOVED** — no longer applies in the production path (may remain
>   for dev mode).
> - **NEW** — introduced by the FirecREST-only architecture.
>
> For each RE-EVALUATED or REMOVED invariant, this document explains:
> - Why it changes
> - What replaces it (if anything)
> Whether existing tests need modification, reclassification to
> dev-only, or removal.
>
> The existing `invariants.md` and `specs/firecrest/invariants.md` are
> NOT deleted or modified. This file supplements and supersedes them
> for the production path.

---

## C1 — Tool Invocation

### INV-T1: Environment loaded before invocation

**Classification: RE-EVALUATED**

**Original:** A ToolInvocation may not begin executing until the Tool's
required Environment (all Modules, Compiler Stack, MPI runtime) is
loaded and verified conflict-free. Enforcement: cera calls
`environmentManagement.verifyEnvironment()` immediately before
`invokeTool()` enters the RUNNING phase.

**Under R14:** The Environment is loaded inside the SLURM Job via
`uenv start <spec> --`, not by cera's EnvironmentService. The invariant
still holds — the Tool's required Environment is loaded before the
Tool command runs — but the enforcement mechanism changes:

- **Dev mode:** cera calls `environmentManagement.verifyEnvironment()`
  before `invokeTool()`. The EnvironmentService (uenv CLI via
  SubprocessRunner) manages the active Environment on the login node.
- **Production:** cera embeds `uenv start <spec> --` in the Job
  script. The uenv is loaded inside the Job, before the Tool command.
  cera does NOT call `verifyEnvironment()` — it cannot, because the
  Environment is loaded on the HPC compute node, not on the laptop.
  The `EnvironmentService` dependency is optional (absent in
  production).

**What replaces it:** F-INV-5 (uenv loaded in Job scripts), elevated
to the primary production mechanism. The Job script guarantees that
`uenv start` runs before the Tool command.

**Tests:**
- Tests that call `environmentManagement.verifyEnvironment()` in the
  `invokeTool` flow → **reclassify as `@dev-only`**.
- Tests that verify the Job script contains `uenv start <spec> --`
  before the Tool command → **production tests** (add if not present).
- Tests that verify `invokeTool()` works without an `EnvironmentService`
  dependency → **production tests** (add if not present).

### INV-T2: Single exit outcome per invocation

**Classification: UNCHANGED**

Under FirecREST, the ExitOutcome is derived from the Job's terminal
state and exit code. There is still exactly one ExitOutcome per
terminated ToolInvocation — either an exit code (integer) or a signal
(name + number), never both, never neither.

### INV-T3: Output registration gated on success

**Classification: UNCHANGED**

The Agent still does not register output Datasets unless the
ExitOutcome indicates success (exit code 0, or a Tool-specific
non-error code documented in advance per R4). Under FirecREST, the
ExitOutcome comes from the Job result (terminal state + exit code).
The gating logic is identical.

### INV-T4: Input immutability during invocation

**Classification: UNCHANGED**

The Agent still does not open input Datasets for writing and does not
recommend that the User or another Tool modify an input Dataset while
a consuming ToolInvocation is RUNNING. Under FirecREST, the
ToolInvocation runs as a Job on the HPC. The Agent on the laptop
cannot modify HPC files (it goes through FirecREST, which is
read/write but the Agent's own behavior never writes to inputs).

### INV-T5: Signal vs. exit-code distinction preserved

**Classification: RE-EVALUATED**

**Original:** A process terminated by a Signal (SIGSEGV, SIGKILL,
SIGTERM) is reported as a Signal, not as an Exit Code. Enforcement:
the OS reports the signal; the Agent captures it and does not map it
to a synthetic exit code.

**Under R14:** Signal information comes from SLURM via the FirecREST
API, not from the local OS process status. SLURM reports some signals
as Job states:
- OUT_OF_MEMORY → SLURM killed the Job (SIGKILL from OOM)
- TIMEOUT → SLURM sent SIGTERM then SIGKILL (wall time exceeded)
- NODE_FAIL → node died (not a signal, but a distinct terminal state)
- FAILED → Job failed; may include signal information in the job's
  exit code or stderr

The FirecREST compute endpoint (`GET /compute/{system}/jobs/{id}`)
returns the Job's state and exit code. The Agent derives the
ExitOutcome: if the Job's exit code indicates a signal (negative exit
code in POSIX convention, or SLURM's `DerivedExitCode` field includes
signal information), the ExitOutcome carries the Signal. The Agent
must not map OUT_OF_MEMORY or TIMEOUT to a synthetic exit code.

**What replaces it:** The same invariant, but the source of signal
information changes from local OS to SLURM via FirecREST. The
distinction is preserved.

**Tests:**
- Tests that check local process signals (SIGSEGV via
  SubprocessRunner) → **reclassify as `@dev-only`**.
- Tests that check Job states (OUT_OF_MEMORY, TIMEOUT, FAILED with
  signal in exit code/stderr) → **production tests** (add if not
  present).
- Tests that verify the Agent does not map OUT_OF_MEMORY or TIMEOUT
  to a synthetic exit code → **production tests** (add if not
  present).

### INV-T6: Submit requires built Case

**Classification: UNCHANGED**

The Case must be in BUILT state before submission. Under FirecREST,
submission is via `POST /compute/{system}/jobs` (through
FirecRESTSchedulingService), but the Case state validation is
identical.

### INV-T7: One running Job per Case

**Classification: UNCHANGED**

SLURM (via FirecREST) is still the authority. The Agent checks Job
states via `GET /compute/{system}/jobs/{id}`. The invariant is
identical.

### INV-T8: Run length bounded by Wall Time

**Classification: UNCHANGED**

The Wall Time is in the ResourceRequest submitted via `POST
/compute/{system}/jobs`. The validation is identical.

### INV-T9: Output tree location known before submission

**Classification: UNCHANGED**

The output tree location is determined at Case creation and verified
via `GET /filesystem/{system}/stat/{path}` (FirecREST stat endpoint).
The invariant is identical; the resolution mechanism changes from
local `fs.existsSync()` to FirecREST stat, but the invariant text
is unchanged.

---

## C3 — Data Management

### INV-D1: Dataset immutability

**Classification: UNCHANGED**

A Dataset, once created, is not modified in place. The Agent's own
behavior never modifies a created Dataset. Under FirecREST, the Agent
accesses files via REST endpoints, but the immutability rule is
identical.

### INV-D2: One Format, one Grid per Dataset

**Classification: UNCHANGED**

Immutable for the lifetime of the Dataset. Identical under both
backends.

### INV-D3: Provenance before consumption

**Classification: UNCHANGED**

A Dataset may not be consumed until its ProvenanceRecord exists. Under
FirecREST, ProvenanceRecords are written and read via FirecREST
filesystem endpoints (F-INV-7). The gating logic is identical.

### INV-D4: Location resolves to a real path before use

**Classification: RE-EVALUATED**

**Original:** A Dataset's Location must resolve to an existing, readable
path (for inputs) or a writable path (for outputs) at the time the
Dataset is used. Enforcement: `data-management.validateLocation()` is
called immediately before a ToolInvocation reads or writes
`d.location`. Under the local backend, "resolves" means
`fs.existsSync()` / `fs.accessSync()` on the local filesystem.

**Under R14:** "Resolves" means a successful
`GET /filesystem/{system}/stat/{path}` response from FirecREST. The
invariant is the same (Location must resolve before use), but the
resolution mechanism changes from local filesystem to FirecREST stat
endpoint.

- **Dev mode:** `data-management.validateLocation()` uses
  `dsh-adapter.FilesystemGateway` (local `fs`).
- **Production:** `data-management.validateLocation()` uses
  `firecrest-adapter.FilesystemGateway` (FirecREST stat endpoint).

**What replaces it:** The same invariant, but the resolution mechanism
is the FirecREST stat endpoint instead of the local filesystem.

**Tests:**
- Tests that mock `dsh-adapter.FilesystemGateway.exists()` /
  `stat()` → **reclassify as `@dev-only`** for transport-specific
  tests.
- Tests that mock `firecrest-adapter.FilesystemGateway.exists()` /
  `stat()` → **production tests** (add if not present).
- Tests that verify `validateLocation()` is called before
  `invokeTool()` → **unchanged** (interface-level, transport-agnostic).

---

## C4 — Scheduling

### INV-S1: Scheduler is authoritative for Job State

**Classification: RE-EVALUATED**

**Original:** The Agent does not infer a Job's State from indirect
evidence. State transitions are taken from the Scheduler's reports
(`squeue`, `sacct`). Enforcement: the scheduling module calls SLURM
CLI commands via `dsh-adapter.SubprocessRunner`.

**Under R14:** The source of authority changes from SLURM CLI (squeue,
sacct) to SLURM via FirecREST REST API
(`GET /compute/{system}/jobs/{id}`). FirecREST itself queries SLURM on
the HPC. The invariant is the same (Agent doesn't infer Job State from
indirect evidence), but the transport changes from CLI to REST.

- **Dev mode:** scheduling module calls `squeue` / `sacct` via
  `dsh-adapter.SubprocessRunner`.
- **Production:** scheduling module calls
  `FirecRESTSchedulingService.queryJob()` / `queryJobsByUser()` via
  FirecREST compute endpoints.

If FirecREST is unreachable, the Agent marks Jobs as UNKNOWN (same as
the SLURM daemon being unreachable in dev mode — FM-S2 / FM-F-4).
UNKNOWN is acceptable for up to 30 minutes (R13).

**What replaces it:** The same invariant, but the source of authority
is SLURM via FirecREST REST API instead of SLURM CLI.

**Tests:**
- Tests that mock `squeue` / `sacct` CLI output → **reclassify as
  `@dev-only`**.
- Tests that mock FirecREST job query response → **production tests**
  (add if not present).
- Tests that verify the Agent marks Jobs as UNKNOWN (not COMPLETED,
  not RUNNING) when the scheduler is unreachable → **unchanged**
  (behavior is the same; only the mock changes).

### INV-S2: Resource Request immutable after submission

**Classification: UNCHANGED**

The ResourceRequest is submitted via `POST /compute/{system}/jobs` and
is immutable afterward. Identical under both backends.

### INV-S3: Unique JobID

**Classification: UNCHANGED**

The JobID is assigned by SLURM (via FirecREST). The Agent does not
generate JobIDs. Identical under both backends.

### INV-S4: Terminal state is final

**Classification: UNCHANGED**

Terminal states from SLURM (via FirecREST) are final. Identical under
both backends.

---

## C5 — Environment Management

### INV-E1: One active Environment per execution context

**Classification: RE-EVALUATED**

**Original:** At most one Environment is active in a given execution
context at a time. Loading a new Environment replaces, not merges
with, the prior one (unless the module system explicitly supports
stacking and the result is verified conflict-free). Enforcement:
cera's `environment-management` module (on the login node) manages the
active Environment via `loadUenv()` / `verifyEnvironment()` /
`unloadUenv()`.

**Under R14:** The "execution context" is now the SLURM Job, not the
cera process. Each Job has exactly one Environment — the uenv
specified in the Job script via `uenv start <spec> --`. cera does not
manage active Environments on the laptop — it builds Job scripts that
specify the Environment. Multiple complementary uenvs may be specified
in a single Job script (if uenv supports stacking), but there is one
logical Environment per Job.

- **Dev mode:** cera's `environment-management` module manages the
  active Environment on the login node via uenv CLI commands.
- **Production:** the Environment is specified in the Job script.
  `tool-invocation` uses the Environment types (UenvSpec, Module,
  Conflict) to construct the Job script. The runtime
  EnvironmentService is absent.

**What replaces it:** F-INV-5 (uenv loaded in Job scripts), elevated
to the primary production mechanism. The execution context is the
SLURM Job.

**Tests:**
- Tests that call `loadUenv()`, `verifyEnvironment()`,
  `unloadUenv()`, `getActiveEnvironment()` → **reclassify as
  `@dev-only`**.
- Tests that verify the Job script contains exactly one (or a set of
  complementary) `uenv start <spec> --` command(s) → **production
  tests** (add if not present).
- Tests that use Environment types (UenvSpec, Module, Conflict) for
  Job script construction → **production tests** (add if not
  present).

### INV-E2: Conflict detection before execution

**Classification: RE-EVALUATED**

**Original:** Environment conflicts (incompatible compiler versions,
conflicting MPI runtimes, conflicting library sonames) are detected
before a Tool runs, not at Tool runtime via a segfault or linker
error. Enforcement: cera's `environment-management` module calls
`detectConflicts()` (which runs uenv CLI commands via
SubprocessRunner) before `invokeTool()`.

**Under R14:** Conflict detection still happens before the Tool
command runs, but inside the Job script (uenv's own mount-time
conflict detection) rather than by cera's `detectConflicts()` before
Job submission.

- **Dev mode:** cera's `detectConflicts()` runs via SubprocessRunner
  on the login node. Conflicts are detected before `invokeTool()`.
- **Production:** cera cannot detect conflicts before Job submission
  (no `uenv status` endpoint in FirecREST). cera may do **static
  validation** of uenv specs (e.g., checking that two uenvs don't
  obviously conflict by path), but full conflict detection happens
  at uenv mount time inside the Job. If uenvs conflict, the Job
  fails with a uenv error before the Tool command runs. The
  invariant's intent (conflict detected before Tool runs, not at
  runtime via segfault) is preserved — uenv's own conflict detection
  runs before the Tool command in the Job script.

**What replaces it:** F-INV-5 (uenv in Job scripts) partially
replaces this. The full conflict detection is delegated to uenv's
own mount-time mechanism. cera's static validation of uenv specs
(type-level, using Conflict type) is a weaker but useful pre-check.

**Tests:**
- Tests that call `detectConflicts()` and verify conflict rejection
  before `invokeTool()` → **reclassify as `@dev-only`**.
- Tests that verify the Job script contains complementary uenv specs
  (no obvious path conflicts) → **production tests** (add if not
  present).
- Tests that verify the Job fails with a uenv conflict error when
  conflicting uenvs are specified → **production tests** (related to
  FM-F-9; add if not present).
- Tests that use the `Conflict` type for static validation →
  **production tests** (add if not present).

### INV-E3: Module availability verified before load

**Classification: REMOVED from production path (DEV-ONLY)**

**Original:** A Module's availability on the target system is verified
before it is loaded. The Agent must not attempt to load a Module that
does not exist on the host. Enforcement: cera's
`environment-management` module calls `checkUenvAvailability()` (which
queries the uenv registry via SubprocessRunner) before `loadUenv()`.

**Under R14:** There is no FirecREST endpoint for uenv registry
queries. cera cannot verify uenv availability before Job submission.
Availability is tested at Job runtime — if the uenv doesn't exist, the
Job fails with a clear error (FM-F-9: uenv not available in Job
script). The invariant (verify before load) is **removed from the
production path**.

- **Dev mode:** cera's `checkUenvAvailability()` queries the uenv
  registry via SubprocessRunner. The invariant is enforced.
- **Production:** The invariant is not enforced. The Job may be
  submitted with a uenv that doesn't exist. The failure is detected
  at Job runtime (FM-F-9) and is recoverable (User corrects the uenv
  spec).

**What replaces it:** FM-F-9 (uenv not available in Job script) is
the accepted failure mode. The risk (Job submitted with non-existent
uenv) is accepted — see F-A-2 in `specs/firecrest/assumptions.md`.

**Tests:**
- Tests that call `checkUenvAvailability()` and verify availability
  before `loadUenv()` → **reclassify as `@dev-only`**.
- Tests that verify the Job fails with a uenv error when the uenv
  doesn't exist (FM-F-9) → **production tests** (already present in
  firecrest features).

---

## C6 — Provenance

### INV-P1: ProvenanceRecord immutability

**Classification: UNCHANGED**

A ProvenanceRecord, once written, is not modified. Under FirecREST,
records are written via filesystem endpoints (F-INV-7) but
immutability is preserved — cera never overwrites an existing
ProvenanceRecord.

### INV-P2: Provenance captures full reproducibility tuple

**Classification: UNCHANGED**

Every ProvenanceRecord includes: Tool identity (name + version), exact
parameters, Environment identity (all Modules with versions), input
Dataset identities, output Dataset identity, timestamp, exit outcome.
Under R14, the Environment identity in the ProvenanceRecord is the
uenv spec embedded in the Job script (not a cera-managed Environment
object). The fields are identical; the source of Environment identity
changes.

### INV-P3: Provenance exists before consumption

**Classification: UNCHANGED**

A Dataset may not be consumed until its ProvenanceRecord exists. Under
FirecREST, ProvenanceRecords are written via filesystem endpoints
(F-INV-7). The gating logic is identical.

### INV-P4: Provenance survives Session end

**Classification: UNCHANGED**

ProvenanceRecords persist beyond the Session that created them. Under
R14, records are on the HPC filesystem (accessed via FirecREST), not
on the laptop. The laptop Session can end without affecting
ProvenanceRecords. Identical.

---

## C7 — Agent Interaction / Workflow

### INV-W1: Step inputs exist before step starts

**Classification: UNCHANGED**

A WorkflowStep may not begin until all its declared input Datasets
exist and have Provenance. Under FirecREST, "exist" is verified via
the FirecREST stat endpoint, and Provenance is verified via FirecREST
filesystem endpoints. The gating logic is identical.

### INV-W2: Failure halts downstream

**Classification: UNCHANGED**

If a WorkflowStep fails (non-success ExitOutcome, or Job reaches a
non-COMPLETED terminal State), dependent downstream steps do not start
automatically. Identical under both backends — the ExitOutcome comes
from the Job result (via FirecREST in production, via local process in
dev).

### INV-W3: Workflow describes real dependencies

**Classification: UNCHANGED**

A WorkflowStep's declared input Datasets must actually be consumed by
the step's underlying Tool. Identical under both backends — this is a
domain-level invariant, not a transport concern.

### INV-W4: Session can outlive its Jobs' completion

**Classification: UNCHANGED**

A Session may end while Jobs it submitted are still RUNNING. The Jobs
are not cancelled. A later Session can become aware of those Jobs by
JobID. Under R14, the laptop Session can end while HPC Jobs are
running. The Jobs are discoverable via `FirecRESTSchedulingService.
queryJobsByUser()`. Identical.

---

## FirecREST Invariants (F-INV-1 through F-INV-7)

### F-INV-1: All HPC operations go through FirecREST

**Classification: RE-EVALUATED (elevated from backend-specific to
primary architecture invariant)**

Under ADR-011, F-INV-1 was a backend-specific invariant for the
FirecREST backend. Under R14, it is the **primary architecture
invariant** — every production HPC operation goes through FirecREST.
The local backend bypasses this invariant (dev only).

**New invariant ID:** FP-INV-1 (see below). F-INV-1 in
`specs/firecrest/invariants.md` is preserved for reference.

### F-INV-2: JWT token must be valid and not expired for every request

**Classification: PRODUCTION-ONLY**

Applies to the FirecREST backend. Not applicable in dev mode (no
FirecREST, no JWT). Under R14, this is the production authentication
mechanism.

### F-INV-3: Synchronous FirecREST calls have a 5-second timeout

**Classification: PRODUCTION-ONLY**

Applies to the FirecREST backend. Not applicable in dev mode. Under
R14, all synchronous FirecREST calls respect this timeout.

### F-INV-4: Large file transfers (>5MB) are asynchronous

**Classification: PRODUCTION-ONLY**

Applies to the FirecREST backend. Not applicable in dev mode (local
filesystem has no size limit). Under R14, all file transfers >5MB use
the async `/transfer/...` endpoints.

### F-INV-5: uenv is loaded in Job scripts, not by cera

**Classification: RE-EVALUATED (elevated from backend-specific to
primary production mechanism)**

Under ADR-011, F-INV-5 was a FirecREST-specific invariant. Under R14,
this is the **only production mechanism** for environment loading. The
EnvironmentService interface is removed from the production path.
INV-E1, INV-E2, INV-E3 are re-evaluated accordingly (see above).

**New invariant ID:** FP-INV-3 (see below). F-INV-5 in
`specs/firecrest/invariants.md` is preserved for reference.

### F-INV-6: All ToolInvocations are parallel (submitted as SLURM Jobs)

**Classification: RE-EVALUATED (elevated from backend-specific to
only production execution model)**

Under ADR-011, F-INV-6 was a FirecREST-specific invariant. Under R14,
the `executionModel: 'synchronous'` field is **ignored in
production**. There is no synchronous execution path in production.
All ToolInvocations are submitted as SLURM Jobs via FirecREST.

**New invariant ID:** FP-INV-5 (see below). F-INV-6 in
`specs/firecrest/invariants.md` is preserved for reference.

### F-INV-7: Provenance records are written to the HPC filesystem via FirecREST

**Classification: PRODUCTION-ONLY**

Applies to the FirecREST backend. In dev mode, ProvenanceRecords are
written to the local filesystem via `dsh-adapter.FilesystemGateway`.
Under R14, ProvenanceRecords are on the HPC filesystem, accessed via
FirecREST filesystem endpoints.

---

## NEW Invariants (FP-INV-1 through FP-INV-5)

### FP-INV-1: `--backend` defaults to `firecrest`
**Severity:** HIGH
**Aggregate:** cera startup
**Tag:** [NEW — R14.7]

Production deployments use the FirecREST backend. The `--backend`
flag defaults to `firecrest`. The `--backend dev` flag is for
development and testing only. There is no `--backend local` in
production — `dev` replaces `local` as the development mode
identifier.

> **Assertion:** The default value of `--backend` is `firecrest`.
> When `--backend` is not specified, cera starts with the
> `firecrest-adapter`. When `--backend dev` is specified, cera
> starts with the `dsh-adapter`.

### FP-INV-2: Local backend is not a production path
**Severity:** CRITICAL
**Aggregate:** cera backend
**Tag:** [NEW — R14.5]

The local backend (dsh-adapter wrapping local subprocess for
ShellExecutor, SubprocessRunner, FilesystemGateway) is for
development and testing only. It must not be documented, deployed, or
supported as a production option. User-facing documentation describes
only the FirecREST backend.

> **Assertion:** No production deployment uses `--backend dev`. No
> user-facing documentation mentions `--backend dev` as a production
> option. The `dsh-adapter` module is imported only by the dev
> backend factory and by dev-only tests.

### FP-INV-3: EnvironmentService interface is not used in production
**Severity:** CRITICAL
**Aggregate:** Environment Management (C5)
**Tag:** [NEW — R14.3]

The EnvironmentService interface (loadUenv, unloadUenv,
verifyEnvironment, checkUenvAvailability, detectConflicts) is not
used in the production path. The Environment types (Environment,
UenvSpec, Module, Conflict) are used by `tool-invocation` to
construct Job scripts, but the runtime EnvironmentService
implementation (uenv CLI commands via SubprocessRunner) is dev-only.

> **Assertion:** For backend "firecrest", no method in the system
> calls `EnvironmentService.loadUenv()`, `verifyEnvironment()`,
> `checkUenvAvailability()`, `detectConflicts()`, or
> `unloadUenv()`. The Environment types (UenvSpec, Module, Conflict)
> are used only for Job script construction, not for runtime
> environment management.

### FP-INV-4: SLURM CLI scheduling is not used in production
**Severity:** HIGH
**Aggregate:** Scheduling (C4)
**Tag:** [NEW — R14.6]

The SLURM CLI scheduling implementation (sbatch, squeue, scancel via
SubprocessRunner) is not used in the production path. The
SchedulingService interface is implemented by
`FirecRESTSchedulingService` in production. The CLI implementation
remains for dev mode only.

> **Assertion:** For backend "firecrest", the `SchedulingService`
> instance is `FirecRESTSchedulingService`. No method in the system
> calls `SubprocessRunner.execute("sbatch", ...)` or
> `SubprocessRunner.execute("squeue", ...)` in production.

### FP-INV-5: Default ResourceRequest for formerly-synchronous ToolInvocations
**Severity:** MEDIUM
**Aggregate:** ToolInvocation (C1)
**Tag:** [NEW — R14.4, resolves FCREST-05]

Under R14, formerly-synchronous ToolInvocations (which have no
`resourceRequest`) must be submitted as SLURM Jobs. A default
`ResourceRequest` (1 node, 1 core, minimal memory, short wall time,
default partition/QoS) is supplied by the FirecREST backend when the
ToolInvocation's `resourceRequest` is absent. The default is
configurable in `FirecrestConfig.defaultResourceRequest`.

> **Assertion:** For backend "firecrest", if
> `request.resourceRequest` is `undefined` (formerly-synchronous
> ToolInvocation), cera supplies `FirecrestConfig.
> defaultResourceRequest` and submits the Job. No ToolInvocation is
> rejected solely because `resourceRequest` is absent.

---

## Summary Table

| ID | Context | Classification | Short |
|----|---------|---------------|-------|
| INV-T1 | C1 | RE-EVALUATED | Environment loaded before invocation (now in Job script) |
| INV-T2 | C1 | UNCHANGED | Single exit outcome per invocation |
| INV-T3 | C1 | UNCHANGED | Output registration gated on success |
| INV-T4 | C1 | UNCHANGED | Input immutability during invocation |
| INV-T5 | C1 | RE-EVALUATED | Signal vs. exit-code (via SLURM/FirecREST) |
| INV-T6 | C1 | UNCHANGED | Submit requires built Case |
| INV-T7 | C1 | UNCHANGED | One running Job per Case |
| INV-T8 | C1 | UNCHANGED | Run length bounded by Wall Time |
| INV-T9 | C1 | UNCHANGED | Output tree location known pre-submit |
| INV-D1 | C3 | UNCHANGED | Dataset immutability |
| INV-D2 | C3 | UNCHANGED | One Format, one Grid per Dataset |
| INV-D3 | C3 | UNCHANGED | Provenance before consumption |
| INV-D4 | C3 | RE-EVALUATED | Location resolves (via FirecREST stat) |
| INV-S1 | C4 | RE-EVALUATED | Scheduler authoritative (via FirecREST) |
| INV-S2 | C4 | UNCHANGED | Resource Request immutable |
| INV-S3 | C4 | UNCHANGED | Unique JobID |
| INV-S4 | C4 | UNCHANGED | Terminal state is final |
| INV-E1 | C5 | RE-EVALUATED | One active Environment per Job (not cera process) |
| INV-E2 | C5 | RE-EVALUATED | Conflict detection in Job (not by cera) |
| INV-E3 | C5 | REMOVED (DEV-ONLY) | Module availability verified (removed from prod) |
| INV-P1 | C6 | UNCHANGED | ProvenanceRecord immutability |
| INV-P2 | C6 | UNCHANGED | Full reproducibility tuple |
| INV-P3 | C6 | UNCHANGED | Provenance before consumption |
| INV-P4 | C6 | UNCHANGED | Provenance survives Session end |
| INV-W1 | C7 | UNCHANGED | Step inputs exist before start |
| INV-W2 | C7 | UNCHANGED | Failure halts downstream |
| INV-W3 | C7 | UNCHANGED | Workflow describes real dependencies |
| INV-W4 | C7 | UNCHANGED | Session outlives Jobs |
| F-INV-1 | (firecrest) | RE-EVALUATED (primary) | All HPC ops through FirecREST |
| F-INV-2 | (firecrest) | PRODUCTION-ONLY | JWT token valid for every request |
| F-INV-3 | (firecrest) | PRODUCTION-ONLY | 5-second timeout on sync calls |
| F-INV-4 | (firecrest) | PRODUCTION-ONLY | Large files async |
| F-INV-5 | (firecrest) | RE-EVALUATED (primary) | uenv in Job scripts (only prod mechanism) |
| F-INV-6 | (firecrest) | RE-EVALUATED (primary) | All ToolInvocations parallel (only exec model) |
| F-INV-7 | (firecrest) | PRODUCTION-ONLY | Provenance via FirecREST filesystem |
| FP-INV-1 | (startup) | NEW | `--backend` defaults to `firecrest` |
| FP-INV-2 | (backend) | NEW | Local backend is not a production path |
| FP-INV-3 | C5 | NEW | EnvironmentService not used in production |
| FP-INV-4 | C4 | NEW | SLURM CLI scheduling not used in production |
| FP-INV-5 | C1 | NEW | Default ResourceRequest for formerly-sync ToolInvocations |

**Summary counts:**
- UNCHANGED: 17
- RE-EVALUATED: 11 (INV-T1, INV-T5, INV-D4, INV-S1, INV-E1, INV-E2, F-INV-1, F-INV-5, F-INV-6, + 2 elevated)
- REMOVED from production (DEV-ONLY): 1 (INV-E3)
- PRODUCTION-ONLY: 4 (F-INV-2, F-INV-3, F-INV-4, F-INV-7)
- NEW: 5 (FP-INV-1 through FP-INV-5)
