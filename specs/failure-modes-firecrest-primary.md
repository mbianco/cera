# Failure Modes — FirecREST-Only Primary Architecture

> This document classifies every failure mode from `failure-modes.md`
> (FM-T1–T5, FM-M1–M5, FM-D1–D5, FM-S1–S4, FM-E1–E3, FM-P1–P3,
> FM-A1–A4, FM-X1–X5) and every failure mode from
> `specs/firecrest/failure-modes.md` (FM-F-1 through FM-F-9) under the
> FirecREST-only primary architecture (R14, ADR-012).
>
> Each failure mode is classified as:
> - **UNCHANGED** — the failure mode and recovery are the same.
> - **PRODUCTION-ONLY** — the failure mode only exists under FirecREST.
> - **DEV-ONLY** — the failure mode only exists under the local backend
>   (e.g., SLURM daemon unavailable on login node — under FirecREST,
>   SLURM is accessed via REST, not locally).
> - **RE-EVALUATED** — the failure mode still exists but the recovery
>   changes.
> - **REMOVED** — the failure mode no longer applies.
>
> For each RE-EVALUATED or DEV-ONLY failure mode, this document
> explains why it changes, what replaces it, and whether existing
> tests need to be modified, reclassified to dev-only, or removed.
>
> The existing `failure-modes.md` and `specs/firecrest/failure-modes.md`
> are NOT deleted or modified. This file supplements and supersedes
> them for the production path.

---

## C1 — Tool Invocation

### FM-T1: Tool segfault (SIGSEGV, SIGBUS)

**Classification: RE-EVALUATED**

**Original:** A legacy CLI Tool crashes due to a malformed input file,
a library incompatibility, or a Tool bug. The Agent detects the
Signal from the local OS process status, captures stderr, and marks
the ToolInvocation as FAILED.

**Under R14:** The segfault happens inside a SLURM Job on the HPC.
The Job reaches FAILED state. The Agent detects the failure via Job
polling (`GET /compute/{system}/jobs/{id}`). The stderr is retrieved
via FirecREST filesystem endpoints (from the Job's output files or
the output tree). The signal information may be in the Job's exit
code (POSIX convention: negative exit code indicates signal) or in
the stderr.

**Recovery:** Unchanged — fatal (stop and notify user). The Agent
reports the Signal (INV-T5, re-evaluated), captures stderr (via
FirecREST), and marks the ToolInvocation as FAILED. No output Dataset
is registered (INV-T3). The Workflow is halted (INV-W2).

**What replaces it:** The same failure mode, but the detection
mechanism changes from local OS process status to SLURM Job state via
FirecREST. The recovery is identical.

**Tests:**
- Tests that simulate local process crash (SIGSEGV via
  `SubprocessRunner.execute()` with a crashing binary) →
  **reclassify as `@dev-only`**.
- Tests that simulate Job reaching FAILED with signal in exit code or
  stderr (via FirecREST scheduling mock) → **production tests** (add
  if not present).
- Tests that verify the Agent reports the Signal (not a synthetic exit
  code) → **unchanged** (behavior is the same; only the mock changes).

### FM-T2: Tool killed by OOM (SIGKILL, OUT_OF_MEMORY)

**Classification: RE-EVALUATED**

**Original:** A Tool exceeds available memory and is killed by the OS
or SLURM. The Agent detects SIGKILL from the local process.

**Under R14:** The Job reaches OUT_OF_MEMORY state (detected via
FirecREST compute endpoint). The Agent reports the Job state and
suggests a larger memory allocation or chunked processing.

**Recovery:** Unchanged — fatal (stop and notify user). The Agent
additionally suggests a larger memory allocation or chunked
processing.

**What replaces it:** The same failure mode, but the detection
mechanism changes from local SIGKILL to SLURM OUT_OF_MEMORY state via
FirecREST. Additionally, a formerly-synchronous ToolInvocation may
fail with OUT_OF_MEMORY if the default `ResourceRequest` (FP-INV-5)
provides insufficient memory. In that case, the Agent suggests a
larger `ResourceRequest` for the next attempt.

**Tests:**
- Tests that simulate local SIGKILL → **reclassify as `@dev-only`**.
- Tests that simulate Job reaching OUT_OF_MEMORY (via FirecREST
  scheduling mock) → **production tests** (add if not present).
- Tests that verify the Agent reports OUT_OF_MEMORY (not a synthetic
  exit code) → **unchanged** (behavior is the same).

### FM-T3: Non-zero exit code for warnings (CDO-specific)

**Classification: UNCHANGED**

The exit code comes from the Job result (via FirecREST in production,
via local process in dev). The recovery is identical: under R4,
strict is the default (any non-zero exit code blocks output
registration). Permissive mode is opt-in per ToolInvocation via
`permissiveExitCodes`.

**Tests:** Tests that check exit codes are adapted to check Job exit
codes (via FirecREST scheduling mock) for production. The logic is
the same; only the source of the exit code changes. Local tests
remain for dev mode.

### FM-T4: Invalid operator chain (CDO)

**Classification: UNCHANGED**

The Tool still fails with a non-zero exit code and stderr. The
failure is detected from the Job result (via FirecREST in
production). The recovery is identical: the Agent captures the error,
reports it to the User, and does not register an output Dataset.

**Tests:** Tests that simulate local Tool failure are adapted to
simulate Job failure (via FirecREST scheduling mock) for production.
The logic is the same. Local tests remain for dev mode.

### FM-T5: Missing input file

**Classification: RE-EVALUATED**

**Original:** A Dataset's Location does not resolve at invocation time
(violates INV-D4). The file was deleted, moved, or the path is wrong.
Enforcement: `data-management.validateLocation()` checks
`FilesystemGateway.exists()` (local `fs.existsSync()`).

**Under R14:** File existence is checked via
`GET /filesystem/{system}/stat/{path}` (FirecREST stat endpoint).
A 404 response means the file does not exist.

**Recovery:** Unchanged — recoverable (User provides correct path).
The Agent reports the missing path and suggests alternatives.

**What replaces it:** The same failure mode, but the existence check
uses the FirecREST stat endpoint instead of the local filesystem.

**Tests:**
- Tests that mock `dsh-adapter.FilesystemGateway.exists()` returning
  false → **reclassify as `@dev-only`** for transport-specific tests.
- Tests that mock FirecREST stat endpoint returning 404 →
  **production tests** (add if not present).
- Tests that verify `validateLocation()` is called before
  `invokeTool()` → **unchanged** (interface-level).

---

## C2 — Model Execution (CESM)

### FM-M1: CESM build failure

**Classification: RE-EVALUATED**

**Original:** `case.build` fails due to a missing compiler,
incompatible MPI runtime, missing library, or source code error. The
build runs on the login node (or locally). The Agent detects the
failure from the local process.

**Under R14:** The build happens as a Job on the HPC (submitted via
FirecREST). The build failure is detected from the Job state (FAILED)
and Job output (retrieved via FirecREST filesystem endpoints). The
stderr may include uenv errors (if the uenv specified in the Job
script doesn't provide the required compiler).

**Recovery:** Unchanged — recoverable (User fixes
configuration/environment). The Case remains in CONFIGURED state (not
BUILT). The build log is captured (via FirecREST filesystem
endpoints). The Agent reports the failure and suggests Environment
corrections (load a different uenv, etc.).

**Tests:**
- Tests that simulate local build failure → **reclassify as
  `@dev-only`**.
- Tests that simulate Job build failure (via FirecREST scheduling +
  filesystem mock) → **production tests** (add if not present).

### FM-M2: CESM runtime crash (MPI abort)

**Classification: RE-EVALUATED**

**Original:** CESM aborts at runtime due to a domain decomposition
error, time step instability, I/O failure, or MPI communication
error. SLURM reports the Job as FAILED. The Agent captures the Job's
stderr (from the output tree or `case.err`).

**Under R14:** The Job reaches FAILED state (detected via FirecREST
compute endpoint). The Agent retrieves stderr via FirecREST
filesystem endpoints. The Case is marked FAILED. Downstream Workflow
steps do not start (INV-W2).

**Recovery:** Unchanged — fatal (stop and notify user). The Agent
must not automatically resubmit.

**Tests:**
- Tests that simulate local MPI abort → **reclassify as `@dev-only`**.
- Tests that simulate Job reaching FAILED with MPI abort in stderr
  (via FirecREST mock) → **production tests** (add if not present).

### FM-M3: Wall time exceeded (TIMEOUT)

**Classification: RE-EVALUATED**

**Original:** The CESM run does not finish within the requested Wall
Time. SLURM sends SIGTERM then SIGKILL. Job state is TIMEOUT.

**Under R14:** The Job reaches TIMEOUT state (detected via FirecREST
compute endpoint polling). The Agent reports the state and suggests
resubmission with a longer Wall Time.

**Recovery:** Unchanged — recoverable (resubmit with longer wall
time). The Agent must not resubmit with the same Wall Time.

**Tests:**
- Tests that simulate local timeout → **reclassify as `@dev-only`**.
- Tests that simulate Job reaching TIMEOUT (via FirecREST mock) →
  **production tests** (add if not present).

### FM-M4: Node failure mid-run (NODE_FAIL)

**Classification: RE-EVALUATED**

**Original:** A compute node fails during a CESM run. SLURM reports
NODE_FAIL. The Agent identifies the failed node (from SLURM) and
suggests resubmission with `--exclude`.

**Under R14:** The Job reaches NODE_FAIL state (detected via
FirecREST compute endpoint). The Agent may identify the failed node
from the Job detail response (if FirecREST exposes it). The Agent
suggests resubmission with `--exclude` for the failed node.

**Recovery:** Unchanged — recoverable (resubmit, possibly with
`--exclude`). The Agent must not automatically resubmit without
informing the User.

**Tests:**
- Tests that simulate local NODE_FAIL → **reclassify as `@dev-only`**.
- Tests that simulate Job reaching NODE_FAIL (via FirecREST mock) →
  **production tests** (add if not present).

### FM-M5: CESM configure failure

**Classification: UNCHANGED in principle**

The configuration error is detected from the Job result (via
FirecREST in production). The Case remains in CREATED state. The
recovery is identical.

**Tests:** Tests adapted to use Job results (via FirecREST mock) for
production. Local tests remain for dev mode.

---

## C3 — Data Management

### FM-D1: Filesystem quota exceeded

**Classification: RE-EVALUATED**

**Original:** The HPC filesystem reports that the User's quota has
been exceeded. Tool output writes fail with `ENOSPC` or a quota
error. Detected locally.

**Under R14:** The quota error is detected from either:
1. A Job failure (if the Job writes output and hits the quota —
   Job reaches FAILED with ENOSPC in stderr).
2. A FirecREST filesystem operation failure (if cera writes via
   FirecREST filesystem endpoints — HTTP error indicating quota
   exceeded).

The error manifests as an HTTP error from FirecREST (instead of local
`ENOSPC`).

**Recovery:** Unchanged — fatal (stop and notify user — User must
clean up or request more quota). The Agent must not silently delete
old Datasets to make space.

**Tests:**
- Tests that simulate local `ENOSPC` → **reclassify as `@dev-only`**.
- Tests that simulate FirecREST filesystem error (quota exceeded) or
  Job failure with ENOSPC → **production tests** (add if not
  present).

### FM-D2: Lustre/GPFS slowdown

**Classification: RE-EVALUATED**

**Original:** The parallel filesystem is under heavy load. Metadata
operations and reads/writes are slow but not failing. Detected by
local filesystem operations timing out.

**Under R14:** Filesystem slowness manifests as higher latency on
FirecREST filesystem API calls (stat, list, download, upload). The
Agent's timeout thresholds need to account for FirecREST's own
timeouts (5 seconds per F-INV-3) plus filesystem latency. A
FirecREST call that times out may be due to filesystem slowness
(FM-F-1) rather than FirecREST itself being slow.

**Recovery:** Unchanged — degradable (advise staging, reduce I/O).
The Agent advises the User to stage data on a faster filesystem or
reduce I/O. Timeout thresholds must be generous for HPC filesystems
accessed via FirecREST.

**Tests:**
- Tests that simulate local filesystem slowness → **reclassify as
  `@dev-only`**.
- Tests that simulate FirecREST API latency (with backoff) →
  **production tests** (add if not present).

### FM-D3: File not found / permission denied

**Classification: RE-EVALUATED**

**Original:** A Dataset's Location does not resolve (file deleted,
moved, or permissions changed) at invocation time. Detected by local
`fs.existsSync()` / `fs.accessSync()`.

**Under R14:** File existence and permissions are checked via
FirecREST stat endpoint (`GET /filesystem/{system}/stat/{path}`). A
404 means not found; a 403 means permission denied.

**Recovery:** Unchanged — recoverable (User provides correct path or
permissions). The Agent reports the specific error (404 vs. 403, via
FirecREST error response) and suggests alternatives.

**Tests:**
- Tests that mock local file errors (ENOENT, EACCES) →
  **reclassify as `@dev-only`** for transport-specific tests.
- Tests that mock FirecREST HTTP errors (404, 403) → **production
  tests** (add if not present).

### FM-D4: Concurrent write conflict

**Classification: UNCHANGED**

The conflict detection is the same — C7 detects the duplicate (same
Tool, parameters, inputs, output Location) and refuses the second
ToolInvocation before it starts. The write itself goes through
FirecREST in production, but the detection mechanism is
domain-level and transport-agnostic.

**Tests:** Unchanged. The detection logic is the same; only the
write mechanism differs (and the test doesn't need to exercise the
actual write).

### FM-D5: Corrupted ZARR store

**Classification: UNCHANGED in principle**

The corruption is detected when a Tool tries to read the ZARR store.
Under FirecREST, the Tool runs as a Job and the error (ImportError
or Zarr-specific error) is in the Job's stderr. The Agent retrieves
the error via FirecREST filesystem endpoints.

**Recovery:** Unchanged — fatal (stop and notify user — Dataset is
unusable). The Agent reports the corruption and marks the Dataset as
quarantined.

**Tests:** Tests adapted to use Job results (via FirecREST mock) for
production. Local tests remain for dev mode.

---

## C4 — Scheduling (SLURM)

### FM-S1: SLURM job rejection at submission

**Classification: RE-EVALUATED**

**Original:** `sbatch` rejects the Job due to invalid ResourceRequest
(exceeding partition limits, invalid QoS, missing account). Detected
from the local `sbatch` command's exit code and stderr.

**Under R14:** Submission is via `POST /compute/{system}/jobs`
(through `FirecRESTSchedulingService`). The rejection manifests as
an HTTP error (400 or similar) from FirecREST, with an error message
indicating the specific rejection reason. The Job is not created (no
JobID).

**Recovery:** Unchanged — recoverable (User corrects ResourceRequest).
The Agent captures the FirecREST error message and reports the
specific rejection reason. The Agent suggests corrections (different
partition, lower resource request, different QoS).

**Tests:**
- Tests that mock local `sbatch` rejection → **reclassify as
  `@dev-only`**.
- Tests that mock FirecREST `POST /compute/.../jobs` returning 400 →
  **production tests** (add if not present).

### FM-S2: SLURM daemon unavailable

**Classification: DEV-ONLY**

**Original:** The SLURM controller (`slurmctld`, `slurmd`) is
unreachable on the login node. `sbatch`, `squeue`, `scancel`,
`sacct` return connection errors. This is a local failure — the
Agent is running on the login node and cannot reach SLURM locally.

**Under R14:** cera runs on the laptop. cera does not access SLURM
directly — it goes through FirecREST. The SLURM daemon is on the HPC,
not on the laptop. The local SLURM daemon unavailability only
applies in **dev mode** (when cera runs on the login node with
`--backend dev`).

**What replaces it:** In production, the equivalent failures are:
- **FM-F-4** (FirecREST server unavailable, 503) — cera cannot reach
  FirecREST, which means it cannot reach SLURM.
- **FM-F-5** (SSH connection from FirecREST to HPC failed, 500) —
  FirecREST is running but cannot reach the HPC system via SSH.

Both are PRODUCTION-ONLY. The recovery is similar (mark Jobs as
UNKNOWN, retry with backoff, reconcile when the connection recovers).
R13 (UNKNOWN acceptable for 30 minutes) still applies.

**Tests:**
- Existing FM-S2 tests that test local SLURM daemon unavailability
  (mocking `squeue`/`sacct` connection errors) → **reclassify as
  `@dev-only`**.
- Tests that verify the Agent marks Jobs as UNKNOWN and retries with
  backoff → **unchanged** (behavior is the same; the mock changes
  from local CLI error to FirecREST HTTP error).
- Production tests use FM-F-4 and FM-F-5 (already present in
  `specs/firecrest/failure-modes.md`).

### FM-S3: Stale queue data

**Classification: RE-EVALUATED**

**Original:** `squeue` returns stale data (Job shows RUNNING but has
already TIMEOUT; or COMPLETED reported before a stale PENDING from a
previous query). Detected by comparing `squeue` and `sacct` output.

**Under R14:** Stale data comes from FirecREST's cached SLURM state
(returned by `GET /compute/{system}/jobs/{id}`). The FirecREST API
queries SLURM on the HPC, and the response may be stale if SLURM's
own state is stale or if FirecREST caches responses.

**Recovery:** Unchanged — recoverable (query authoritative data).
The Agent trusts the most recent FirecREST response. Terminal states
are final (INV-S4) — once a Job shows TIMEOUT, a stale response
showing RUNNING does not demote it. The Agent may issue a fresh
query (rather than relying on cached data) for authoritative state.

**What replaces it:** The same failure mode, but the stale data
comes from FirecREST's REST API response instead of `squeue` CLI
output. The reconciliation mechanism changes from `sacct` to a
fresh FirecREST job query.

**Tests:**
- Tests that mock stale `squeue` output → **reclassify as
  `@dev-only`**.
- Tests that mock stale FirecREST job query response → **production
  tests** (add if not present).
- Tests that verify terminal states are final (INV-S4) →
  **unchanged** (behavior is the same).

### FM-S4: Job timeout (wall time exceeded)

**Classification: RE-EVALUATED**

**Original:** SLURM sends SIGTERM then SIGKILL when the Job exceeds
its Wall Time. Job state is TIMEOUT. Detected by local SLURM
monitoring.

**Under R14:** The Job reaches TIMEOUT state (detected via FirecREST
compute endpoint polling). Same as FM-M3.

**Recovery:** Unchanged — recoverable (resubmit with longer wall
time). The ProvenanceRecord records TIMEOUT as the ExitOutcome.

**Tests:**
- Tests that simulate local SLURM timeout → **reclassify as
  `@dev-only`**.
- Tests that simulate Job reaching TIMEOUT (via FirecREST mock) →
  **production tests** (add if not present).

---

## C5 — Environment Management

### FM-E1: Module not found

**Classification: DEV-ONLY (replaced by FM-F-9 in production)**

**Original:** A Tool requires a Module (uenv) that does not exist on
the target system. cera's `environment-management` module calls
`checkUenvAvailability()` (which queries the uenv registry via
SubprocessRunner) and detects the missing Module before attempting
to load it.

**Under R14:** cera runs on the laptop and has no direct access to
the uenv registry. There is no FirecREST endpoint for uenv registry
queries. cera cannot verify uenv availability before Job submission.
In production, uenv availability is tested at Job runtime — if the
uenv doesn't exist, the Job fails with a clear error (FM-F-9). The
local `checkUenvAvailability()` only applies in **dev mode**.

**What replaces it:** FM-F-9 (uenv not available in Job script) is
the production failure mode. The Job runs `uenv start <spec> --`, the
uenv doesn't exist, and the Job fails with "uenv: not found" or a
similar error in stderr.

**Tests:**
- Existing FM-E1 tests that call `checkUenvAvailability()` and verify
  availability before `loadUenv()` → **reclassify as `@dev-only`**.
- Tests that verify the Job fails with a uenv error when the uenv
  doesn't exist (FM-F-9) → **production tests** (already present in
  `specs/firecrest/features/firecrest-backend.feature`).

### FM-E2: Conflicting Modules

**Classification: DEV-ONLY (replaced by FM-F-9 variant in production)**

**Original:** Two Modules (uenvs) in the Environment provide
conflicting libraries (same path, different version). cera's
`environment-management` module calls `detectConflicts()` (which
checks uenv paths via SubprocessRunner) and detects the conflict
before any Tool runs (INV-E2).

**Under R14:** cera cannot detect conflicts before Job submission (no
`uenv status` endpoint in FirecREST). In production, conflicts are
detected at uenv mount time inside the Job. If uenvs conflict, the
`uenv start` command fails, and the Job fails with a uenv conflict
error before the Tool command runs. This is a variant of FM-F-9
(uenv error in Job script). cera may do **static validation** of
uenv specs (type-level, using the `Conflict` type) but cannot do
runtime conflict detection.

**What replaces it:** A variant of FM-F-9 (uenv conflict error in Job
script). The Job fails with a uenv conflict error in stderr. cera
reports the conflict and asks the User to choose.

**Tests:**
- Existing FM-E2 tests that call `detectConflicts()` and verify
  conflict rejection → **reclassify as `@dev-only`**.
- Tests that verify the Job fails with a uenv conflict error when
  conflicting uenvs are specified → **production tests** (add if not
  present; related to FM-F-9).
- Tests that use the `Conflict` type for static validation of uenv
  specs → **production tests** (add if not present).

### FM-E3: Partial Environment load

**Classification: DEV-ONLY (replaced by FM-F-9 variant in production)**

**Original:** `uenv mount` partially succeeds — some Modules load,
others fail. The Environment is in an inconsistent state. cera's
`environment-management` module detects the partial load and purges
the Environment.

**Under R14:** There is no "partial Environment load" by cera in
production — the Environment is loaded inside the Job via
```
uenv start
<spec> --
```
. If `uenv start` partially fails (some uenvs mount, others
don't), the Job fails with an error. The local partial load only
applies in **dev mode**.

**What replaces it:** A variant of FM-F-9 (uenv partial mount error
in Job script). The Job fails with a uenv error indicating partial
mount failure.

**Tests:**
- Existing FM-E3 tests that simulate partial `uenv mount` and verify
  purging → **reclassify as `@dev-only`**.
- Tests that verify the Job fails with a uenv partial mount error →
  **production tests** (add if not present; related to FM-F-9).

---

## C6 — Provenance

### FM-P1: ProvenanceRecord write failure

**Classification: RE-EVALUATED**

**Original:** The Provenance store is unreachable or the write fails
(filesystem error, storage full, network issue). Detected locally.

**Under R14:** The write fails via FirecREST filesystem endpoints
(HTTP error instead of local filesystem error). The failure may be:
- 503 (FirecREST server unavailable — FM-F-4)
- 500 (FirecREST internal error — e.g., SSH to HPC failed, FM-F-5)
- 413 (payload too large — if the ProvenanceRecord exceeds 5MB and
  cera uses the synchronous endpoint instead of async)
- Timeout (FM-F-1)

**Recovery:** Unchanged — recoverable (retry with backoff); fatal if
all retries fail. C1 must not register the output Dataset as
available (INV-D3 violation if registration proceeds). The Agent
retries the ProvenanceRecord write with backoff. If all retries fail,
the User is notified and the output Dataset is held in an
unregistered state.

**What replaces it:** The same failure mode, but the write mechanism
changes from local filesystem to FirecREST HTTP. The retry logic is
the same (backoff), but the error detection changes from local
filesystem errors to HTTP errors.

**Tests:**
- Tests that mock local filesystem write failure → **reclassify as
  `@dev-only`** for transport-specific tests.
- Tests that mock FirecREST filesystem endpoint failure (503, 500,
  timeout) → **production tests** (add if not present).
- Tests that verify the Agent does not register the output Dataset
  without a ProvenanceRecord → **unchanged** (behavior is the same).

### FM-P2: Corrupted ProvenanceRecord

**Classification: UNCHANGED**

The corruption is detected when reading the record (via FirecREST
filesystem endpoint in production). The blast radius is single
Dataset (R11: local, not systemic). Recovery: quarantine the
affected Dataset, attempt reconstruction.

**Tests:** Tests adapted to use FirecREST filesystem mock for
production. Local tests remain for dev mode. The quarantine and
reconstruction logic is unchanged.

### FM-P3: Missing ProvenanceRecord before consumption

**Classification: UNCHANGED**

The detection is the same (verify before starting). Under FirecREST,
the verification uses FirecREST filesystem endpoints, but the gating
logic is identical.

**Tests:** Tests adapted to use FirecREST filesystem mock for
production. Local tests remain for dev mode.

---

## C7 — Agent Interaction

### FM-A1: LLM hallucinates Tool name

**Classification: UNCHANGED**

The LLM runs on the laptop (in both dev and production). The
validation against the Tool catalog is the same. The recovery (refuse
and ask — R12) is unchanged.

**Tests:** Unchanged. The validation logic is transport-agnostic.

### FM-A2: LLM hallucinates parameters

**Classification: UNCHANGED**

Same as FM-A1. The LLM runs on the laptop. The parameter validation
against the Tool's schema and input Dataset metadata is the same.
The recovery is unchanged.

**Tests:** Unchanged.

### FM-A3: Context window exceeded

**Classification: UNCHANGED**

The LLM's context window is determined by the LLM API, not by the
HPC transport. The recovery (summarize, compact, or start a new
Session) is unchanged. Running Jobs on the HPC are not affected
(they execute independently of the LLM).

**Tests:** Unchanged.

### FM-A4: Model (LLM) unavailable

**Classification: UNCHANGED**

The LLM is always a remote API (in both dev and production). Under
R14, the LLM runs on the laptop, but the API is still remote. Running
Jobs on the HPC are not affected (they execute on compute nodes,
independent of the laptop's LLM). The recovery (notify User, retry
with backoff) is unchanged.

**Tests:** Unchanged.

---

## Cross-Cutting Failure Scenarios

### FM-X1: Network partition on compute nodes

**Classification: UNCHANGED**

This is the expected state on Alps — compute nodes typically lack
outbound network. The Agent does not attempt to reach compute nodes
directly. All communication is through SLURM (via FirecREST in
production) and the shared filesystem (via FirecREST in production).
This is not a failure — it is the expected operating condition.

**Tests:** Unchanged.

### FM-X2: Login node network loss

**Classification: DEV-ONLY**

**Original:** The login node where the Agent is running loses network
connectivity. The Agent cannot reach the LLM API, the SLURM
controller, or remote Dataset stores. Recovery: fatal (stop and
notify user).

**Under R14:** cera runs on the **laptop**, not the login node. There
is no "login node network loss" that affects cera in production. The
equivalent failure is **laptop network loss**, which manifests as:
- FM-F-4 (FirecREST server unavailable) — cera cannot reach FirecREST.
- FM-A4 (LLM unavailable) — cera cannot reach the LLM API.

Both are PRODUCTION-ONLY and have their own recovery strategies
(degradable — running Jobs continue). The local FM-X2 (login node
network loss) only applies in **dev mode** (when cera runs on the
login node with `--backend dev`).

**What replaces it:** FM-F-4 and FM-A4 occurring simultaneously. The
recovery is degradable (not fatal) — running Jobs on the HPC continue.
The Agent detects the network loss (both FirecREST and LLM are
unreachable) and notifies the User. When network is restored, the
Agent queries Job states via FirecREST.

**Tests:**
- Existing FM-X2 tests that simulate login node network loss →
  **reclassify as `@dev-only`**.
- Tests that simulate simultaneous FirecREST and LLM unavailability
  (laptop network loss) → **production tests** (add if not present;
  can be composed from FM-F-4 and FM-A4 tests).

### FM-X3: dsh framework breaking change

**Classification: UNCHANGED**

The dsh-adapter still wraps dsh. The version is still pinned in
`package.json` / lockfile. The isolation layer (ADR-005) still
applies (for dev mode — dsh-adapter wraps dsh's volatile extension
points). In production, dsh's extension points are not used (the
FirecREST adapter replaces them), but dsh still provides the agent
loop, LLM adapter, session management, and tool registration.

The full test suite (Tier 3) is still run against real services
before merging any dsh upgrade. The failure mode and recovery are
identical.

**Tests:** Unchanged.

### FM-X4: opengrads build failure (if attempted)

**Classification: UNCHANGED**

opengrads is not a required Tool (R10). The build failure and
go/no-go decision framework are unchanged. Under FirecREST, the
build would be a Job on the HPC (if attempted), but the evaluation
framework is the same.

**Tests:** Unchanged.

### FM-X5: External mutation of Dataset

**Classification: UNCHANGED**

The Agent cannot enforce Dataset immutability at the OS level (INV-D1
caveat). The Agent's own behavior never modifies a created Dataset.
If the Agent detects a mismatch (e.g., file modification time does
not match the ProvenanceRecord timestamp), the Dataset is flagged as
untrustworthy. Under FirecREST, file modification times are
retrieved via the stat endpoint, but the detection and recovery are
the same.

**Tests:** Unchanged.

---

## FirecREST Failure Modes (FM-F-1 through FM-F-9)

All FM-F failure modes are **PRODUCTION-ONLY**. Under R14, they are
the active failure modes for the production path. In dev mode (with
`--backend dev`), none of these apply.

### FM-F-1: FirecREST 5-second timeout on synchronous call

**Classification: PRODUCTION-ONLY**

Unchanged from `specs/firecrest/failure-modes.md`. Under R14, this
is the primary timeout failure mode for synchronous FirecREST calls
(stat, list, small file download/upload, job query).

### FM-F-2: JWT token expired or invalid (401)

**Classification: PRODUCTION-ONLY**

Unchanged from `specs/firecrest/failure-modes.md`. Under R14, this
is the primary authentication failure mode.

### FM-F-3: FirecREST rate limit exceeded (429)

**Classification: PRODUCTION-ONLY**

Unchanged from `specs/firecrest/failure-modes.md`. Under R14, this
is the primary rate-limiting failure mode.

### FM-F-4: FirecREST server unavailable (503)

**Classification: PRODUCTION-ONLY (replaces FM-S2 and FM-X2 in
production)**

Unchanged from `specs/firecrest/failure-modes.md`. Under R14, this
is the production equivalent of FM-S2 (SLURM daemon unavailable) and
FM-X2 (login node network loss). Running Jobs on the HPC continue.
The Agent marks all Job states as UNKNOWN and retries with backoff.
R13 (UNKNOWN acceptable for 30 minutes) still applies.

### FM-F-5: SSH connection from FirecREST to HPC failed (500)

**Classification: PRODUCTION-ONLY**

Unchanged from `specs/firecrest/failure-modes.md`. Under R14, this
is the production failure mode for FirecREST-to-HPC connectivity
issues.

### FM-F-6: Large file transfer job failed (async, FAILED state)

**Classification: PRODUCTION-ONLY**

Unchanged from `specs/firecrest/failure-modes.md`. Under R14, this
is the production failure mode for large file transfer failures
(>5MB async transfer).

### FM-F-7: FirecREST not configured for the target system (404)

**Classification: PRODUCTION-ONLY**

Unchanged from `specs/firecrest/failure-modes.md`. Under R14, this
is the production failure mode for misconfigured target system.

### FM-F-8: File too large for synchronous download (>5MB)

**Classification: PRODUCTION-ONLY**

Unchanged from `specs/firecrest/failure-modes.md`. Under R14, this
is the production failure mode for exceeding the synchronous file
transfer size limit.

### FM-F-9: uenv not available in Job script (CESM build/run fails)

**Classification: PRODUCTION-ONLY (replaces FM-E1, FM-E2, FM-E3 in
production)**

Unchanged from `specs/firecrest/failure-modes.md`. Under R14, this
is the production failure mode for uenv availability and conflict
issues. It replaces:
- FM-E1 (Module not found) — uenv availability is tested at Job
  runtime, not before Job submission.
- FM-E2 (Conflicting Modules) — uenv conflicts are detected at mount
  time inside the Job.
- FM-E3 (Partial Environment load) — partial uenv mount failures are
  detected inside the Job.

---

## NEW Failure Modes (FP-FM-1, FP-FM-2)

### FP-FM-1: Default ResourceRequest too small for formerly-synchronous Tool
**Severity:** MEDIUM
**Blast radius:** single Job (formerly-synchronous ToolInvocation)
**Recovery class:** recoverable (Agent suggests larger ResourceRequest)
**Introduced by:** R14.4, FP-INV-5

**How:** Under R14, formerly-synchronous ToolInvocations (e.g., a
CDO command that previously ran as a 2-second local subprocess) are
submitted as SLURM Jobs with a default `ResourceRequest` (FP-INV-5).
If the Tool requires more memory than the default (e.g., a large CDO
remap that needs 8GB but the default is 1GB), the Job fails with
OUT_OF_MEMORY.

**Desired degradation:** The Agent detects the OUT_OF_MEMORY state
(via FirecREST compute endpoint), reports the failure to the User,
and suggests a larger `ResourceRequest` (more memory, more nodes)
for the next attempt. The Agent does not automatically resubmit with
a guessed larger `ResourceRequest` — the User should confirm.

**Unacceptable:** The Agent retries with the same default
`ResourceRequest` (it will fail again). The Agent silently increases
the `ResourceRequest` without User confirmation.

**Tests:** New tests needed:
- Given a formerly-synchronous ToolInvocation with default
  ResourceRequest, When the Job fails with OUT_OF_MEMORY, Then the
  Agent reports the failure and suggests a larger ResourceRequest.
- Given a formerly-synchronous ToolInvocation with default
  ResourceRequest, When the Job succeeds, Then the output Dataset is
  registered (the default is sufficient).

### FP-FM-2: Laptop power loss or crash during Job polling
**Severity:** MEDIUM
**Blast radius:** single Session (Agent loses track of Jobs being
polled; Jobs continue on HPC)
**Recovery class:** degradable (Jobs continue on HPC; Agent resumes
on next Session start via proactive Job reporting, R7)
**Introduced by:** R14.1 (Agent runs on laptop)

**How:** Under R14, cera runs on the laptop. If the laptop crashes,
loses power, or the cera process is killed while polling a Job's
state, the Agent loses track of the in-flight Job. The Job continues
on the HPC (it is independent of the laptop).

**Desired degradation:** On the next Session start, the Agent
proactively queries `FirecRESTSchedulingService.queryJobsByUser()`
(R7, INV-W4) and discovers the Job by its JobID. The Agent reports
the Job's current state to the User. If the Job has completed, the
Agent retrieves the output and registers Datasets. If the Job is
still running, the Agent resumes polling.

**Unacceptable:** The Agent loses track of the Job permanently (no
recovery path). The Agent resubmits the Job (creating a duplicate).
The Agent cancels the Job on Session restart (the User did not ask
for cancellation).

**Tests:** New tests needed:
- Given a Job submitted in Session A, When Session A ends abruptly
  (laptop crash), Then the Job continues on the HPC and is
  discoverable in Session B via `queryJobsByUser()`.
- Given a Job that completed during a laptop crash, When the Agent
  starts a new Session, Then the Agent discovers the completed Job,
  retrieves the output via FirecREST, and registers Datasets.

---

## Summary Table

| ID | Component | Classification | Short |
|----|-----------|---------------|-------|
| FM-T1 | C1 Tool | RE-EVALUATED | Tool segfault (via Job FAILED + signal in stderr) |
| FM-T2 | C1 Tool | RE-EVALUATED | Tool OOM (via Job OUT_OF_MEMORY) |
| FM-T3 | C1 Tool | UNCHANGED | Non-zero exit code for warnings (from Job result) |
| FM-T4 | C1 Tool | UNCHANGED | Invalid operator chain (from Job result) |
| FM-T5 | C1 Tool | RE-EVALUATED | Missing input file (via FirecREST stat 404) |
| FM-M1 | C2 CESM | RE-EVALUATED | Build failure (via Job FAILED + stderr via FirecREST) |
| FM-M2 | C2 CESM | RE-EVALUATED | MPI abort (via Job FAILED + stderr via FirecREST) |
| FM-M3 | C2 CESM | RE-EVALUATED | Wall time exceeded (via Job TIMEOUT) |
| FM-M4 | C2 CESM | RE-EVALUATED | Node failure (via Job NODE_FAIL) |
| FM-M5 | C2 CESM | UNCHANGED | Configure failure (from Job result) |
| FM-D1 | C3 Data | RE-EVALUATED | Quota exceeded (via FirecREST HTTP error or Job FAILED) |
| FM-D2 | C3 Data | RE-EVALUATED | Lustre/GPFS slowdown (via FirecREST API latency) |
| FM-D3 | C3 Data | RE-EVALUATED | File not found/permission (via FirecREST 404/403) |
| FM-D4 | C3 Data | UNCHANGED | Concurrent write conflict (domain-level detection) |
| FM-D5 | C3 Data | UNCHANGED | Corrupted ZARR store (from Job result) |
| FM-S1 | C4 SLURM | RE-EVALUATED | Job rejection at submission (via FirecREST HTTP 400) |
| FM-S2 | C4 SLURM | DEV-ONLY | SLURM daemon unavailable (replaced by FM-F-4 in prod) |
| FM-S3 | C4 SLURM | RE-EVALUATED | Stale queue data (via FirecREST cached state) |
| FM-S4 | C4 SLURM | RE-EVALUATED | Job timeout (via FirecREST Job TIMEOUT) |
| FM-E1 | C5 Env | DEV-ONLY | Module not found (replaced by FM-F-9 in prod) |
| FM-E2 | C5 Env | DEV-ONLY | Conflicting Modules (replaced by FM-F-9 variant in prod) |
| FM-E3 | C5 Env | DEV-ONLY | Partial Environment load (replaced by FM-F-9 variant in prod) |
| FM-P1 | C6 Prov | RE-EVALUATED | Write failure (via FirecREST HTTP error) |
| FM-P2 | C6 Prov | UNCHANGED | Corrupted ProvenanceRecord |
| FM-P3 | C6 Prov | UNCHANGED | Missing ProvenanceRecord before consumption |
| FM-A1 | C7 Agent | UNCHANGED | LLM hallucinates Tool name |
| FM-A2 | C7 Agent | UNCHANGED | LLM hallucinates parameters |
| FM-A3 | C7 Agent | UNCHANGED | Context window exceeded |
| FM-A4 | C7 Agent | UNCHANGED | LLM unavailable |
| FM-X1 | Cross-cut | UNCHANGED | Network partition on compute nodes (expected) |
| FM-X2 | Cross-cut | DEV-ONLY | Login node network loss (replaced by FM-F-4 + FM-A4) |
| FM-X3 | Cross-cut | UNCHANGED | dsh framework breaking change |
| FM-X4 | Cross-cut | UNCHANGED | opengrads build failure |
| FM-X5 | Cross-cut | UNCHANGED | External mutation of Dataset |
| FM-F-1 | FirecREST | PRODUCTION-ONLY | 5-second timeout |
| FM-F-2 | FirecREST | PRODUCTION-ONLY | JWT token expired (401) |
| FM-F-3 | FirecREST | PRODUCTION-ONLY | Rate limit exceeded (429) |
| FM-F-4 | FirecREST | PRODUCTION-ONLY | Server unavailable (503) — replaces FM-S2, FM-X2 |
| FM-F-5 | FirecREST | PRODUCTION-ONLY | SSH connection to HPC failed (500) |
| FM-F-6 | FirecREST | PRODUCTION-ONLY | Large file transfer job failed |
| FM-F-7 | FirecREST | PRODUCTION-ONLY | System not configured (404) |
| FM-F-8 | FirecREST | PRODUCTION-ONLY | File too large for sync download |
| FM-F-9 | FirecREST | PRODUCTION-ONLY | uenv not available in Job script — replaces FM-E1/2/3 |
| FP-FM-1 | C1 (new) | NEW | Default ResourceRequest too small |
| FP-FM-2 | C7 (new) | NEW | Laptop crash during Job polling |

**Summary counts:**
- UNCHANGED: 15 (FM-T3, FM-T4, FM-M5, FM-D4, FM-D5, FM-P2, FM-P3,
  FM-A1, FM-A2, FM-A3, FM-A4, FM-X1, FM-X3, FM-X4, FM-X5)
- RE-EVALUATED: 14 (FM-T1, FM-T2, FM-T5, FM-M1, FM-M2, FM-M3, FM-M4,
  FM-D1, FM-D2, FM-D3, FM-S1, FM-S3, FM-S4, FM-P1)
- DEV-ONLY: 4 (FM-S2, FM-E1, FM-E2, FM-E3)
- PRODUCTION-ONLY: 9 (FM-F-1 through FM-F-9)
- NEW: 2 (FP-FM-1, FP-FM-2)

Total: 15 + 14 + 4 + 9 + 2 = 44 failure modes classified.
