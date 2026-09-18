# Domain Expert Resolutions — R14 (FirecREST-Only Primary)

> Recorded 2026-09-17. This document supplements `resolutions.md` (R1–R13)
> and supersedes ADR-011 insofar as ADR-011 described FirecREST as a
> "second backend" alongside the local backend. Under R14, FirecREST is
> the **only** production HPC transport. The local backend is demoted
> to dev-only. ADR-012 records this decision.
>
> The existing `resolutions.md` is unchanged. This file adds R14.

---

## R14: FirecREST is the only supported HPC transport

**Resolution:** FirecREST is the only production HPC transport. The
local backend (dsh-adapter wrapping local subprocess for ShellExecutor,
SubprocessRunner, FilesystemGateway) is demoted to `--backend dev` for
testing only. dsh runs on the laptop (frontend). All HPC operations go
through FirecREST's REST API. uenv is always loaded in Job scripts, not
by cera. All ToolInvocations are parallel — submitted as SLURM Jobs via
FirecREST.

### R14.1: dsh runs on the laptop (frontend)

The agent loop, LLM adapter, session management, and tool registration
all happen locally on the scientist's laptop. The scientist talks to
the LLM directly on their machine. cera never runs on the HPC login
node in production.

**Impact:**
- The `Login Node` ubiquitous-language entry is re-evaluated: in
  production, cera does not run on a login node. The login node is
  only relevant in dev mode (`--backend dev`).
- FM-X2 (login node network loss) is DEV-ONLY. The production
  equivalent is laptop network loss, which manifests as FirecREST
  unavailability (FM-F-4) and LLM unavailability (FM-A4) occurring
  simultaneously.
- The LLM runs on the laptop, not on the HPC. LLM latency is
  determined by the laptop's network to the LLM API, not by HPC
  network conditions.

### R14.2: FirecREST is the only production HPC transport

No SSH, no VPN, no login-node subprocess for HPC operations. All HPC
operations — Job submission, Job state query, Job cancellation, file
listing, file read/write, file stat, directory creation — go through
FirecREST's REST API.

**Impact:**
- F-INV-1 (all HPC operations through FirecREST) is elevated from a
  backend-specific invariant to the **primary architecture invariant**.
  See `invariants-firecrest-primary.md` FP-INV-1.
- The `--backend` flag defaults to `firecrest`. See R14.7.
- The local backend's ShellExecutor, SubprocessRunner, FilesystemGateway
  (wrapping `ctx.shell`, `ctx.subprocess`, `ctx.fs`) are NOT used in
  production. They remain for dev mode only.
- FM-S2 (SLURM daemon unavailable) is DEV-ONLY — in production, SLURM
  is accessed via FirecREST, not locally. The production equivalent is
  FM-F-4 (FirecREST server unavailable) and FM-F-5 (SSH connection from
  FirecREST to HPC failed).

### R14.3: uenv is always loaded in Job scripts

The EnvironmentService interface (uenv mount/unmount, verifyEnvironment,
checkUenvAvailability, detectConflicts) is removed from the production
path. cera never calls `uenv mount`, `uenv status`, or any uenv CLI
command directly in production. Instead, cera embeds `uenv start <spec>
--` in the Job script submitted via FirecREST.

**Impact:**
- INV-E1 (one active Environment per execution context) is
  RE-EVALUATED: the "execution context" is now the SLURM Job, not the
  cera process. Each Job has exactly one Environment (the uenv
  specified in the script).
- INV-E2 (conflict detection before execution) is RE-EVALUATED:
  conflict detection still happens before the Tool command runs, but
  inside the Job script (uenv's own mount-time conflict detection),
  not by cera's `detectConflicts()` before Job submission. cera may
  do static validation of uenv specs but cannot do runtime conflict
  detection.
- INV-E3 (Module availability verified before load) is REMOVED from
  the production path. cera cannot verify uenv availability before Job
  submission (no FirecREST endpoint for uenv registry). Availability is
  tested at Job runtime — if the uenv doesn't exist, the Job fails
  with a clear error (FM-F-9).
- The `environment-management` module's runtime service implementation
  (environment-service.ts, uenv-parser.ts, conflict-detector.ts) becomes
  dev-only. The domain types (Environment, UenvSpec, Module, Conflict)
  stay and are used by `tool-invocation` to construct Job scripts.
- ADR-003 (uenv not Lmod) is re-evaluated: uenv is still the mechanism,
  but the loading location changes from cera (login node) to the Job
  script (compute node).
- F-INV-5 (uenv in Job scripts) is elevated from a backend-specific
  invariant to the primary production mechanism.

### R14.4: All ToolInvocations are parallel

Every Tool that executes on the HPC is submitted as a SLURM Job via
FirecREST. The `executionModel: 'synchronous'` field is ignored in
production — there is no "run command and wait for output" endpoint in
FirecREST. cera polls the Job state (GET /compute/.../jobs/{id}) until
a terminal state is reached, then derives the ExitOutcome from the Job's
terminal state and exit code.

**Impact:**
- INV-T1 (Environment loaded before invocation) is RE-EVALUATED: the
  Environment is loaded inside the Job (via `uenv start <spec> --`),
  not by cera. The invariant still holds (the Tool's required
  Environment is loaded before the Tool command runs), but the
  enforcement mechanism changes from cera's `verifyEnvironment()` to
  uenv's own loading inside the Job script.
- F-INV-6 (all ToolInvocations are parallel) is elevated from a
  backend-specific invariant to the only production execution model.
- The `executionModel` field on `ToolInvocationRequest` is ignored in
  production. It remains for dev mode (where synchronous execution is
  possible via `ShellExecutor`).
- A default `ResourceRequest` (1 node, 1 core, minimal memory, short
  wall time, default partition/QoS) is supplied by the FirecREST
  backend when a formerly-synchronous ToolInvocation has no
  `resourceRequest`. This resolves finding FCREST-05.
- F-A-1 (all ToolInvocations become parallel) is elevated from a
  FirecREST-specific assumption to a primary architecture assumption.

### R14.5: Local backend is dev-only

The local backend (dsh-adapter wrapping local subprocess for
ShellExecutor, SubprocessRunner, FilesystemGateway) is demoted to
`--backend dev` for testing only. It is NOT a production path and
should not be documented as such in user-facing documentation.

**Impact:**
- User-facing documentation describes only the FirecREST backend.
  The `--backend dev` flag is mentioned in developer documentation
  only.
- The `dsh-adapter` module remains for dev mode. Its interfaces
  (ShellExecutor, SubprocessRunner, FilesystemGateway, SchedulingService,
  ToolRegistry, CommandRegistry) are unchanged.
- Tests that exercise the local backend remain but are tagged or
  organized to indicate they are dev-only tests. No tests are removed
  — they are reclassified.
- ADR-011 point 6 ("No modification to existing modules") is
  superseded. Under R14, `tool-invocation` and `environment-management`
  must be modified to support the FirecREST-only primary. See
  `impact-analysis.md` for details.

### R14.6: SLURM CLI implementation replaced by FirecRESTSchedulingService in production

The scheduling module's SLURM CLI implementation (sbatch, squeue,
scancel via SubprocessRunner) is replaced by FirecRESTSchedulingService
in production. The SchedulingService interface stays — it is
implemented by FirecRESTSchedulingService in production and by the CLI
implementation in dev mode. The CLI implementation remains for dev
mode only.

**Impact:**
- The `scheduling` module's public interface (submitJob, queryJob,
  queryJobsByUser, cancelJob, reconcileViaSacct) is unchanged. The
  implementation is selected by the `--backend` flag.
- INV-S1 (Scheduler is authoritative for Job State) is RE-EVALUATED:
  the source of authority changes from SLURM CLI (squeue/sacct) to
  SLURM via FirecREST REST API (GET /compute/.../jobs/{id}). The
  invariant is the same (Agent doesn't infer Job State from indirect
  evidence) but the transport changes.
- FM-S1 (SLURM job rejection at submission) is RE-EVALUATED: the
  rejection manifests as an HTTP error from FirecREST, not from the
  local `sbatch` command.
- FM-S3 (stale queue data) is RE-EVALUATED: stale data comes from
  FirecREST's cached SLURM state, queried via REST instead of CLI.
- FM-S4 (job timeout) is RE-EVALUATED: the Job reaches TIMEOUT state
  via FirecREST polling, not via local SLURM monitoring.

### R14.7: `--backend` defaults to `firecrest`

The `--backend` flag defaults to `firecrest`. The `--backend dev` flag
is for development only. There is no `--backend local` flag in
production — `dev` replaces `local` as the development mode identifier.

**Impact:**
- New invariants FP-INV-1 (`--backend` defaults to `firecrest`) and
  FP-INV-2 (local backend is not a production path) are introduced.
- Existing code that selects the backend at startup must default to
  `firecrest`. The `dev` value selects the local dsh-adapter
  implementation.
- User-facing documentation and help text describe `--backend
  firecrest` as the default. `--backend dev` is mentioned only in
  developer documentation.

---

## Summary of spec status changes under R14

| Spec artifact | Was | Now | Reason |
|---|---|---|---|
| ADR-011 (FirecREST as second backend) | Accepted | Superseded by ADR-012 | R14 — FirecREST is the only production backend |
| ADR-003 (uenv not Lmod) | Accepted | Re-evaluated (loading location) | R14.3 — uenv in Job scripts, not by cera |
| ADR-005 (dsh isolation layer) | Accepted | Unchanged (dev mode) | R14.5 — dsh-adapter remains for dev |
| INV-E1 | Inferred | RE-EVALUATED (execution context = Job) | R14.3 |
| INV-E2 | Inferred | RE-EVALUATED (conflict detection in Job) | R14.3 |
| INV-E3 | Explicit | REMOVED from production path | R14.3 — no pre-submission availability check |
| INV-T1 | Explicit | RE-EVALUATED (Environment in Job script) | R14.4 |
| INV-S1 | Inferred | RE-EVALUATED (authority via FirecREST) | R14.6 |
| F-INV-1 | NEW (backend-specific) | Primary architecture invariant | R14.2 |
| F-INV-5 | DERIVED (backend-specific) | Primary production mechanism | R14.3 |
| F-INV-6 | DERIVED (backend-specific) | Only production execution model | R14.4 |
| F-A-1 | ACCEPTED (FirecREST-specific) | Primary architecture assumption | R14.4 |
| FM-S2 | CRITICAL / degradable | DEV-ONLY | R14.2 — SLURM accessed via FirecREST |
| FM-X2 | HIGH / fatal | DEV-ONLY | R14.1 — Agent runs on laptop, not login node |
| FM-E1, FM-E2, FM-E3 | C5 failure modes | DEV-ONLY (replaced by FM-F-9 in production) | R14.3 |

---

## Relationship to existing resolutions

| Resolution | Relationship to R14 |
|---|---|
| R1 (CESM is a Tool) | Unchanged. CESM is still a Model Tool in C1. |
| R2 (Experiment first-class) | Unchanged. |
| R3 (Action replaces Operator) | Unchanged. |
| R4 (Strict exit codes) | Unchanged. Exit codes come from the Job result. |
| R5 (CESM output location fixed) | Unchanged. Location verified via FirecREST stat. |
| R6 (Workflow first-class) | Unchanged. |
| R7 (Agent resumes Jobs) | Unchanged. Jobs queried via FirecREST compute endpoint. |
| R8 (SLURM only) | Unchanged. SLURM accessed via FirecREST. |
| R9 (uenv not Lmod) | Re-evaluated. uenv is still the mechanism, but loaded in Job scripts, not by cera. |
| R10 (opengrads not mandatory) | Unchanged. |
| R11 (Corrupted Provenance local) | Unchanged. |
| R12 (LLM hallucination — refuse) | Unchanged. |
| R13 (SLURM unavailability — UNKNOWN OK) | Re-evaluated. SLURM unavailability manifests as FirecREST unavailability (FM-F-4) in production. 30-minute UNKNOWN is still acceptable. |
