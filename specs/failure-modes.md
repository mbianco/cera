# Failure Modes — cera

> For each component: how it fails, blast radius, desired degradation,
> and what is unacceptable even in failure. Each entry is tagged with
> severity (**CRITICAL** / **HIGH** / **MEDIUM** / **LOW**), blast radius
> (single tool / single workflow / entire session / scientific
> integrity), and recovery class: **recoverable** (retry), **degradable**
> (partial service), or **fatal** (stop and notify user).

---

## C1 — Tool Invocation

### FM-T1: Tool segfault (SIGSEGV, SIGBUS)
**Severity:** HIGH
**Blast radius:** single tool (output Dataset not produced)
**Recovery class:** fatal (stop and notify user)
**How:** A legacy CLI Tool (CDO, NCO) crashes due to a malformed input
file, a library incompatibility, or a Tool bug.
**Desired degradation:** The Agent reports the Signal (INV-T5), captures
stderr, and marks the ToolInvocation as FAILED. No output Dataset is
registered (INV-T3). The Workflow is halted (INV-W2).
**Unacceptable:** The Agent retries the same ToolInvocation
automatically without User intervention — a segfault indicates a real
defect, not a transient error. The Agent must not map the signal to a
synthetic exit code (INV-T5).

### FM-T2: Tool killed by OOM (SIGKILL, OUT_OF_MEMORY)
**Severity:** HIGH
**Blast radius:** single tool (or single Job node if parallel)
**Recovery class:** fatal (stop and notify user)
**How:** A Tool (especially Python Tools processing large arrays:
healpy, ICON tools, zarr) exceeds available memory and is killed by the
OS or SLURM.
**Desired degradation:** Same as FM-T1 — report the Signal, mark
FAILED, halt Workflow. The Agent additionally suggests a larger memory
allocation or a chunked processing approach.
**Unacceptable:** Silent loss. The Agent must distinguish SIGKILL from
a normal exit and report it as a Signal, not an exit code.

### FM-T3: Non-zero exit code for warnings (CDO-specific)
**Severity:** MEDIUM
**Blast radius:** single tool
**Recovery class:** degradable (output may be usable with a warning flag)
**How:** CDO returns exit code 1 for some warnings (metadata
inconsistencies, non-fatal data issues). See U3 in assumptions.md.
**Desired degradation:** If the domain expert confirms exit code 1 is
non-error for specific CDO operations, the Agent registers the output
Dataset with a warning flag and proceeds. If strict (any non-zero is
failure), the output is not registered (INV-T3).
**Unacceptable:** Registering output without recording the warning. The
ProvenanceRecord must capture the non-zero exit code regardless of
whether the output is registered.

### FM-T4: Invalid operator chain (CDO)
**Severity:** MEDIUM
**Blast radius:** single tool
**Recovery class:** recoverable (User corrects the chain)
**How:** The User or Agent constructs a CDO operator chain that is
syntactically valid but semantically wrong (e.g., `-remapcon2` before
`-selvar`, incompatible operators).
**Desired degradation:** CDO fails with a non-zero exit code and stderr
message. The Agent captures the error, reports it to the User, and does
not register an output Dataset.
**Unacceptable:** The Agent silently corrects the chain without User
confirmation — the correction may not be what the User intended.

### FM-T5: Missing input file
**Severity:** HIGH
**Blast radius:** single tool
**Recovery class:** recoverable (User provides correct path)
**How:** A Dataset's Location does not resolve at invocation time
(violates INV-D4). The file was deleted, moved, or the path is wrong.
**Desired degradation:** The ToolInvocation is rejected before
execution. The Agent reports the missing path and suggests alternatives
if available in the Dataset registry.
**Unacceptable:** The Agent creates a placeholder or empty output. The
Agent must not invoke a Tool whose input does not resolve.

---

## C2 — Model Execution (CESM)

### FM-M1: CESM build failure
**Severity:** HIGH
**Blast radius:** single Case
**Recovery class:** recoverable (User fixes configuration/environment)
**How:** `case.build` fails due to a missing compiler, incompatible MPI
runtime, missing library, or source code error.
**Desired degradation:** The Case remains in CREATED or CONFIGURED
state (not BUILT). The build log is captured. The Agent reports the
failure and suggests Environment corrections (load a different compiler
Module, resolve conflicts via C5).
**Unacceptable:** Submitting an unbuilt Case (INV-M1 violation).

### FM-M2: CESM runtime crash (MPI abort)
**Severity:** CRITICAL
**Blast radius:** entire Job (all nodes), possibly the Workflow
**Recovery class:** fatal (stop and notify user)
**How:** CESM aborts at runtime due to a domain decomposition error,
time step instability, I/O failure, or MPI communication error.
**Desired degradation:** SLURM reports the Job as FAILED. The Agent
captures the Job's stderr (typically in the output tree or
`case.err`). The Case is marked FAILED. Downstream Workflow steps do
not start (INV-W2).
**Unacceptable:** Automatically resubmitting the Case without User
intervention — an MPI abort indicates a real configuration or
numerical problem, not a transient error.

### FM-M3: Wall time exceeded (TIMEOUT)
**Severity:** HIGH
**Blast radius:** entire Job
**Recovery class:** recoverable (resubmit with longer wall time)
**How:** The CESM run does not finish within the requested Wall Time.
SLURM sends SIGTERM then SIGKILL (SLURM convention).
**Desired degradation:** SLURM reports the Job as TIMEOUT. The Agent
reports the Signal (INV-T5) and suggests resubmission with a longer
Wall Time (INV-M3 — must not exceed wall time again).
**Unacceptable:** The Agent resubmits with the same Wall Time. The
Agent must not infer completion from partial output files.

### FM-M4: Node failure mid-run (NODE_FAIL)
**Severity:** HIGH
**Blast radius:** entire Job
**Recovery class:** recoverable (resubmit, possibly with `--exclude`)
**How:** A compute node fails (hardware, kernel panic, network loss)
during a CESM run. SLURM reports NODE_FAIL.
**Desired degradation:** The Agent reports the failure, identifies the
failed node (from SLURM), and suggests resubmission with `--exclude`
for the failed node. CESM's restart mechanism (if configured) may allow
resuming from the last checkpoint.
**Unacceptable:** The Agent automatically resubmits without informing
the User — the User should decide whether to resume from a checkpoint
or restart from scratch.

### FM-M5: CESM configure failure
**Severity:** MEDIUM
**Blast radius:** single Case
**Recovery class:** recoverable (User fixes configuration)
**How:** `case.setup` or XML configuration changes fail due to
incompatible compset/resolution/machine combinations or invalid
configuration values.
**Desired degradation:** The Case remains in CREATED state. The
configuration error is captured. The Agent reports the specific
validation failure and suggests valid alternatives.
**Unacceptable:** The Agent proceeds to build with invalid
configuration.

---

## C3 — Data Management

### FM-D1: Filesystem quota exceeded
**Severity:** HIGH
**Blast radius:** entire session (all output operations affected)
**Recovery class:** fatal (stop and notify user — User must clean up
or request more quota)
**How:** The HPC filesystem (Lustre, GPFS) reports that the User's
quota has been exceeded. Tool output writes fail with `ENOSPC` or a
quota error.
**Desired degradation:** The ToolInvocation fails. The Agent reports
the quota error and suggests cleanup (old Datasets, temporary files)
or requesting more quota. No partial output is registered.
**Unacceptable:** The Agent silently deletes old Datasets to make
space — that destroys scientific provenance. The Agent must not retry
writes without User intervention.

### FM-D2: Lustre/GPFS slowdown
**Severity:** MEDIUM
**Blast radius:** single tool (or entire session if filesystem is
system-wide slow)
**Recovery class:** degradable (advise staging, reduce I/O)
**How:** The parallel filesystem is under heavy load. Metadata
operations (stat, open) and reads/writes are slow but not failing.
**Desired degradation:** The Agent advises the User to stage data on a
faster filesystem (local scratch) or to reduce I/O (chunked
processing, fewer concurrent operations). The ToolInvocation may
proceed but with longer timeout thresholds.
**Unacceptable:** The Agent times out and marks the Dataset as missing
when the filesystem is merely slow. Timeout thresholds must be
generous for HPC filesystems.

### FM-D3: File not found / permission denied
**Severity:** HIGH
**Blast radius:** single tool
**Recovery class:** recoverable (User provides correct path or
permissions)
**How:** A Dataset's Location does not resolve (file deleted, moved,
or permissions changed) at invocation time. Violates INV-D4.
**Desired degradation:** The ToolInvocation is rejected. The Agent
reports the specific error (ENOENT vs. EACCES) and suggests
alternatives from the Dataset registry.
**Unacceptable:** The Agent proceeds with a fallback Dataset without
User confirmation.

### FM-D4: Concurrent write conflict
**Severity:** HIGH
**Blast radius:** single tool (or two tools if both write to the same
Location)
**Recovery class:** fatal (stop and notify user)
**How:** Two ToolInvocations (in the same Session or different
Sessions) attempt to write to the same output Location simultaneously.
**Desired degradation:** C7 detects the duplicate (same Tool,
parameters, inputs, output Location — see X10 in cross-context) and
refuses the second ToolInvocation before it starts.
**Unacceptable:** Both writes proceed and corrupt each other's output.
The Agent must not write to the same output Location from two
ToolInvocations simultaneously.

### FM-D5: Corrupted ZARR store
**Severity:** HIGH
**Blast radius:** single Dataset (or multiple if the store holds
multiple arrays)
**Recovery class:** fatal (stop and notify user — Dataset is
unusable)
**How:** A ZARR store is corrupted — missing chunks, damaged
metadata, incomplete write (e.g., a previous ToolInvocation was killed
mid-write).
**Desired degradation:** The ToolInvocation that reads the ZARR store
fails with a clear error (ImportError or Zarr-specific error). The
Agent reports the corruption and marks the Dataset as quarantined. The
ProvenanceRecord (if it exists) identifies the ToolInvocation that
created the store, enabling investigation.
**Unacceptable:** The Agent silently skips corrupted chunks and
returns partial data without warning.

---

## C4 — Scheduling (SLURM)

### FM-S1: SLURM job rejection at submission
**Severity:** HIGH
**Blast radius:** single Job (or single Case for CESM)
**Recovery class:** recoverable (User corrects ResourceRequest)
**How:** `sbatch` rejects the Job due to invalid ResourceRequest
(exceeding partition limits, invalid QoS, missing account).
**Desired degradation:** The Agent captures the SLURM error message
and reports the specific rejection reason. The Job is not created
(no JobID). The Agent suggests corrections (different partition, lower
resource request, different QoS).
**Unacceptable:** The Agent retries with the same ResourceRequest.

### FM-S2: SLURM daemon unavailable
**Severity:** CRITICAL
**Blast radius:** entire session (no new Jobs, no state queries)
**Recovery class:** degradable (synchronous tools still work; running
Jobs continue on compute nodes)
**How:** The SLURM controller (`slurmctld`, `slurmd`) is unreachable
on the login node. `sbatch`, `squeue`, `scancel`, `sacct` return
connection errors.
**Desired degradation:**
- Synchronous ToolInvocations (short CLI calls on login nodes) are NOT
  affected — they do not use SLURM.
- Running Jobs continue on compute nodes (SLURM's daemon being
  unreachable on the login node does not kill running Jobs).
- The Agent marks all Job states as UNKNOWN (not COMPLETED, not
  RUNNING — INV-S1 caveat).
- The Agent retries `squeue`/`sacct` with backoff. When SLURM
  recovers, the Agent reconciles Job states via `sacct` (historical
  data includes Jobs that completed during the outage).
**Unacceptable:** The Agent promotes any Job to COMPLETED based on
file existence or elapsed time (INV-S1 violation).

### FM-S3: Stale queue data
**Severity:** MEDIUM
**Blast radius:** single Job state report
**Recovery class:** recoverable (query `sacct` for authoritative data)
**How:** `squeue` returns stale data (Job shows RUNNING but has
already TIMEOUT; or COMPLETED reported before a stale PENDING from a
previous query).
**Desired degradation:** The Agent trusts the most recent
authoritative report. Terminal states are final (INV-S4) — once
`sacct` shows TIMEOUT, a stale `squeue` RUNNING does not demote it.
**Unacceptable:** The Agent reconciles SLURM's reports with file
existence or elapsed time.

### FM-S4: Job timeout (wall time exceeded)
**Severity:** HIGH
**Blast radius:** entire Job
**Recovery class:** recoverable (resubmit with longer wall time — see
FM-M3)
**How:** SLURM sends SIGTERM then SIGKILL when the Job exceeds its
Wall Time. Job state is TIMEOUT.
**Desired degradation:** The Agent reports the Signal (INV-T5) and
JobState. The User is notified and may resubmit with a longer Wall
Time. The ProvenanceRecord records TIMEOUT as the ExitOutcome.
**Unacceptable:** The Agent automatically resubmits with the same Wall
Time.

---

## C5 — Environment Management

### FM-E1: Module not found
**Severity:** HIGH
**Blast radius:** single tool (cannot proceed)
**Recovery class:** recoverable (User loads alternative Module)
**How:** A Tool requires a Module that does not exist on the target
system (`module avail` returns nothing).
**Desired degradation:** The Agent verifies Module availability before
load (INV-E3). If the Module does not exist, the load is refused and
the User is notified with the specific Module name and version. The
Agent suggests alternative Modules or versions if available.
**Unacceptable:** The Agent attempts to load a non-existent Module
(produces a noisy, low-signal error). The Agent proceeds to invoke the
Tool without its Environment.

### FM-E2: Conflicting Modules
**Severity:** CRITICAL
**Blast radius:** entire execution context (all Tools in that context)
**Recovery class:** fatal (stop and notify user — User must choose)
**How:** Two Modules in the Environment provide conflicting libraries
(same soname, different version). Loading both would cause a linker
error or runtime segfault.
**Desired degradation:** C5 detects the conflict before any Tool runs
(INV-E2). The load is rejected. The Agent reports the specific conflict
(Module A vs. Module B, which soname conflicts) and asks the User to
choose.
**Unacceptable:** The Agent merges conflicting Environments or
proceeds with a partially loaded Environment.

### FM-E3: Partial Environment load
**Severity:** HIGH
**Blast radius:** single tool (or entire execution context)
**Recovery class:** fatal (stop and notify user)
**How:** `module load` partially succeeds — some Modules load, others
fail (network issue, corrupt module file). The Environment is in an
inconsistent state.
**Desired degradation:** C5 detects the partial load (the Environment
does not match the Tool's requirements). The Agent purges the
Environment and reports which Modules loaded and which failed. The
User is asked to retry or choose an alternative Environment.
**Unacceptable:** The Agent proceeds with a partial Environment. The
Agent must not invoke a Tool under an Environment that has not been
verified conflict-free.

---

## C6 — Provenance

### FM-P1: ProvenanceRecord write failure
**Severity:** CRITICAL
**Blast radius:** scientific integrity (Dataset not auditable)
**Recovery class:** recoverable (retry with backoff); fatal if all
retries fail
**How:** The Provenance store is unreachable or the write fails
(filesystem error, storage full, network issue).
**Desired degradation:** C1 must not register the output Dataset as
available (INV-D3 violation if registration proceeds). The Agent
retries the ProvenanceRecord write with backoff. If all retries fail,
the User is notified and the output Dataset is held in an unregistered
state — it is NOT available for downstream consumption.
**Unacceptable:** Registering the output Dataset without a
ProvenanceRecord. Scientific integrity is at risk — a Dataset without
provenance cannot be audited or reproduced.

### FM-P2: Corrupted ProvenanceRecord
**Severity:** CRITICAL
**Blast radius:** single Dataset (or multiple if corruption is
systemic)
**Recovery class:** degradable (quarantine affected Dataset);
fatal if corruption is systemic
**How:** A ProvenanceRecord that was written is now corrupted, partially
written, or missing.
**Desired degradation:** C3's verification fails. The Dataset is
quarantined — not available for consumption. The Agent attempts to
reconstruct the ProvenanceRecord from available metadata
(ToolInvocation logs, Environment state). If reconstruction fails, the
User is notified and the Dataset remains quarantined.
**Unacceptable:** Consuming a Dataset without a valid
ProvenanceRecord. Treating one corrupted record as a systemic issue
without investigation (or vice versa — see open question in
assumptions.md: what is the blast radius of a corrupted
ProvenanceRecord?).

### FM-P3: Missing ProvenanceRecord before consumption
**Severity:** CRITICAL
**Blast radius:** single WorkflowStep (or entire Workflow if the
Dataset is a critical input)
**Recovery class:** fatal (stop and notify user)
**How:** A WorkflowStep is about to start, but one of its input
Datasets has no ProvenanceRecord (violates INV-W1, INV-D3).
**Desired degradation:** The WorkflowStep does not start. The Agent
reports which Dataset is missing Provenance. The User is notified and
may provide the missing Provenance manually (if available) or
regenerate the Dataset.
**Unacceptable:** Starting the WorkflowStep without Provenance.

---

## C7 — Agent Interaction

### FM-A1: LLM hallucinates Tool name
**Severity:** HIGH
**Blast radius:** single WorkflowStep (or entire Workflow if
uncaught)
**Recovery class:** recoverable (Agent asks User for clarification)
**How:** The LLM, translating User intent into a ToolInvocation,
generates a Tool name that does not exist in the Tool catalog (e.g.,
"cdo_remap" instead of "cdo -remapcon2").
**Desired degradation:** C7 (via X10 contract) checks the Tool name
against the catalog before creating the ToolInvocation. If the name is
not found, the Agent asks the User for clarification rather than
guessing (per X10 contract: "if a requested Tool or parameter is not
in the Tool catalog, the Agent asks the User for clarification rather
than guessing").
**Unacceptable:** The Agent invokes a non-existent Tool (produces a
noisy error). The Agent silently substitutes a different Tool without
User confirmation.

### FM-A2: LLM hallucinates parameters
**Severity:** HIGH
**Blast radius:** single ToolInvocation (incorrect output or crash)
**Recovery class:** recoverable (Agent validates parameters against
Tool schema)
**How:** The LLM generates parameters that are syntactically valid but
semantically wrong (e.g., a grid file path that doesn't exist, a
variable name that's not in the Dataset, a CDO operator chain that's
incompatible).
**Desired degradation:** The Agent validates parameters against the
Tool's schema and the input Dataset's metadata before invocation. If
validation fails, the Agent asks the User for clarification.
**Unacceptable:** The Agent invokes a Tool with unvalidated parameters.
For climate science, incorrect parameters may produce plausible-looking
but wrong output — this is worse than a crash.

### FM-A3: Context window exceeded
**Severity:** MEDIUM
**Blast radius:** single Session (Agent loses context)
**Recovery class:** degradable (summarize, compact, or start a new
Session)
**How:** A long Session with many ToolInvocations, Datasets, and
Workflow steps exceeds the LLM's context window.
**Desired degradation:** The Agent summarizes or compacts the Session
context (e.g., replace ToolInvocation details with summaries, keep
only recent Datasets and ProvenanceRecords). The User is notified that
context was compacted. Alternatively, the Agent suggests starting a new
Session, leveraging INV-W4 (Jobs persist across Sessions) and INV-P4
(Provenance persists across Sessions).
**Unacceptable:** The Agent silently drops context without notifying
the User. The Agent loses track of running Jobs.

### FM-A4: Model (LLM) unavailable
**Severity:** HIGH
**Blast radius:** entire Session (no new interactions)
**Recovery class:** degradable (running Jobs continue; User notified)
**How:** The LLM API is unreachable, rate-limited, or returns errors.
**Desired degradation:** Running Jobs and ToolInvocations are NOT
affected — they execute on the HPC system independently of the LLM.
The Agent notifies the User that the model is unavailable and that
running Jobs will continue. The Agent retries the LLM with backoff.
**Unacceptable:** The Agent cancels running Jobs because the LLM is
unavailable. The Agent loses track of running Jobs.

---

## Cross-Cutting Failure Scenarios

### FM-X1: Network partition on compute nodes
**Severity:** MEDIUM
**Blast radius:** running Jobs (no outbound network on compute nodes
is normal, not a failure)
**Recovery class:** N/A (this is the expected state, not a failure)
**How:** Compute nodes on Alps typically lack outbound network. This
is not a failure — it is the expected operating condition.
**Desired degradation:** The Agent does not attempt to reach compute
nodes directly. All communication is through SLURM (submission, state
queries, cancellation) and the shared filesystem (input/output
Datasets).
**Unacceptable:** The Agent attempts to run a Tool on a compute node
that requires outbound network (e.g., fetching a remote Dataset).

### FM-X2: Login node network loss
**Severity:** HIGH
**Blast radius:** entire Session (Agent cannot reach LLM, SLURM, or
remote Datasets)
**Recovery class:** fatal (stop and notify user)
**How:** The login node where the Agent is running loses network
connectivity. The Agent cannot reach the LLM API, the SLURM
controller (if on a different node), or remote Dataset stores.
**Desired degradation:** Running Jobs continue on compute nodes (they
don't depend on the login node's network). The Agent detects the
network loss and notifies the User (if possible — e.g., via a local
terminal). The Agent does not make assumptions about Job states.
**Unacceptable:** The Agent marks all Jobs as FAILED due to network
loss on the login node.

### FM-X3: dsh framework breaking change
**Severity:** CRITICAL
**Blast radius:** entire system (all plugins, tools, jobs)
**Recovery class:** fatal (stop, pin to previous version, do not
upgrade without full test suite)
**How:** A dsh upgrade introduces a breaking change in a Cordis
extension point (`ctx.tools`, `ctx.shell`, `ctx.subprocess`,
`ctx.sandbox`, `ctx.fs`, `ctx.jobs`) that cera's plugins depend on.
**Desired degradation:** The dsh version is pinned in `package.json` /
lockfile (A1 in assumptions.md). The isolation layer between dsh and
cera's domain interfaces absorbs the change. The full test suite (Tier
3) is run against real services before merging any dsh upgrade.
**Unacceptable:** Auto-updating dsh. Upgrading dsh without running the
full test suite. Designing cera's domain specs to depend on dsh-
specific implementation details.

### FM-X4: opengrads build failure (if attempted)
**Severity:** MEDIUM (opengrads is not a required Tool)
**Blast radius:** single Tool (opengrads not available)
**Recovery class:** recoverable (record failure, exclude opengrads)
**How:** The opengrads build fails on Alps due to missing X11
libraries, incompatible compiler, stale CVS source, or missing
dependencies. See `features/opengrads-evaluation.feature` and the
dedicated evaluation section in `assumptions.md`.
**Desired degradation:** The Agent records the build failure and its
cause. opengrads is excluded from the Tool catalog. The go/no-go
decision framework (5 criteria) is applied — if buildability fails,
the decision is "no-go." The User is notified and alternative tools
(matplotlib, cartopy, xarray) are suggested.
**Unacceptable:** The Agent silently excludes opengrads without
recording the evaluation. The Agent spends excessive time attempting
to build opengrads before flagging the issue.

### FM-X5: External mutation of Dataset
**Severity:** HIGH
**Blast radius:** scientific integrity (Dataset no longer matches its
ProvenanceRecord)
**Recovery class:** fatal (stop and notify user — Dataset is
untrustworthy)
**How:** A user or external process manually edits a Dataset file
that was created by a ToolInvocation. The Dataset's bytes no longer
match what the ProvenanceRecord describes.
**Desired degradation:** The Agent cannot enforce this at the OS level
(INV-D1 caveat). The Agent's own behavior never modifies a created
Dataset. If the Agent detects a mismatch (e.g., file modification time
does not match the ProvenanceRecord timestamp), the Dataset is flagged
as untrustworthy and the User is notified.
**Unacceptable:** The Agent treats a modified Dataset as if it were
the original. The Agent uses a Dataset with a mismatched
ProvenanceRecord for downstream operations without warning.

---

## Summary Table

| ID | Component | Severity | Blast Radius | Recovery |
|----|-----------|----------|--------------|----------|
| FM-T1 | C1 Tool | HIGH | single tool | fatal |
| FM-T2 | C1 Tool | HIGH | single tool/node | fatal |
| FM-T3 | C1 Tool | MEDIUM | single tool | degradable |
| FM-T4 | C1 Tool | MEDIUM | single tool | recoverable |
| FM-T5 | C1 Tool | HIGH | single tool | recoverable |
| FM-M1 | C2 CESM | HIGH | single Case | recoverable |
| FM-M2 | C2 CESM | CRITICAL | entire Job/Workflow | fatal |
| FM-M3 | C2 CESM | HIGH | entire Job | recoverable |
| FM-M4 | C2 CESM | HIGH | entire Job | recoverable |
| FM-M5 | C2 CESM | MEDIUM | single Case | recoverable |
| FM-D1 | C3 Data | HIGH | entire session | fatal |
| FM-D2 | C3 Data | MEDIUM | single tool/session | degradable |
| FM-D3 | C3 Data | HIGH | single tool | recoverable |
| FM-D4 | C3 Data | HIGH | single/two tools | fatal |
| FM-D5 | C3 Data | HIGH | single Dataset | fatal |
| FM-S1 | C4 SLURM | HIGH | single Job/Case | recoverable |
| FM-S2 | C4 SLURM | CRITICAL | entire session | degradable |
| FM-S3 | C4 SLURM | MEDIUM | single Job state | recoverable |
| FM-S4 | C4 SLURM | HIGH | entire Job | recoverable |
| FM-E1 | C5 Environment | HIGH | single tool | recoverable |
| FM-E2 | C5 Environment | CRITICAL | entire exec context | fatal |
| FM-E3 | C5 Environment | HIGH | single tool/context | fatal |
| FM-P1 | C6 Provenance | CRITICAL | scientific integrity | recoverable→fatal |
| FM-P2 | C6 Provenance | CRITICAL | single Dataset→systemic | degradable→fatal |
| FM-P3 | C6 Provenance | CRITICAL | single WorkflowStep | fatal |
| FM-A1 | C7 Agent | HIGH | single WorkflowStep | recoverable |
| FM-A2 | C7 Agent | HIGH | single ToolInvocation | recoverable |
| FM-A3 | C7 Agent | MEDIUM | single Session | degradable |
| FM-A4 | C7 Agent | HIGH | entire Session | degradable |
| FM-X1 | Cross-cutting | MEDIUM | running Jobs | N/A (expected) |
| FM-X2 | Cross-cutting | HIGH | entire Session | fatal |
| FM-X3 | Cross-cutting | CRITICAL | entire system | fatal |
| FM-X4 | Cross-cutting | MEDIUM | single Tool | recoverable |
| FM-X5 | Cross-cutting | HIGH | scientific integrity | fatal |
