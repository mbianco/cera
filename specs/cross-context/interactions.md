# Cross-Context Interactions — cera

> How the seven bounded contexts (C1–C7) interact: what flows between
> them, what contracts must hold, and what happens when a downstream
> context is unavailable, out-of-order, duplicated, or slow.
>
> Contexts: C1 Tool Invocation, C2 Model Execution, C3 Data Management,
> C4 Scheduling, C5 Environment Management, C6 Provenance, C7 Agent
> Interaction.
>
> Each interaction is numbered. The "downstream" context is the one
> being called (the provider); the "upstream" context is the caller
> (the consumer of the service).

---

## Interaction Registry

| ID  | Upstream | Downstream | Summary |
|-----|----------|------------|---------|
| X1  | C1 | C5 | Tool requires Environment; must load+verify before invocation |
| X2  | C1 | C4 | Parallel tool delegates to Scheduling; synchronous does not |
| X3  | C1 | C3 | Tools consume and produce Datasets |
| X4  | C1 | C6 | Every ToolInvocation produces a ProvenanceRecord |
| X5  | C2 | C4 | CESM case.submit creates a Job |
| X6  | C2 | C3 | CESM output tree becomes Datasets |
| X7  | C3 | C6 | Dataset not consumable until ProvenanceRecord exists |
| X8  | C4 | C7 | Session can outlive Jobs; Job discoverable across Sessions |
| X9  | C5 | C2 | CESM has specific compiler/MPI requirements |
| X10 | C7 | C1 | Agent translates User intent into ToolInvocations |
| X11 | C7 | C2 | Agent translates User intent into CESM Case lifecycle |
| X12 | C7 | C3 | Agent queries, references, and registers Datasets |
| X13 | C6 | C7 | Agent queries ProvenanceRecords on behalf of User |
| X14 | C5 | C1 | Environment verifies Tool binary is available before load |

---

## X1 — C1 (Tool Invocation) ↔ C5 (Environment)

**Flow:** Before a ToolInvocation starts, C1 queries C5 to load and
verify an Environment matching the Tool's requirements. C5 returns an
active Environment identity (Modules + versions) or a rejection
(conflict, module not found).

**Direction of call:** C1 → C5 (load request), C5 → C1 (Environment
identity or rejection).

**Entities flowing:** Tool (with environmentRequirements) →
Environment (with Modules, Compiler Stack, MPI runtime).

**Contract that must hold:**
- The Environment is loaded and verified conflict-free BEFORE the
  ToolInvocation enters the RUNNING phase (INV-T1, INV-E2).
- The Environment identity recorded in the ProvenanceRecord (via X4)
  must exactly match the Environment that was active at invocation
  time.
- If C5 rejects the load, C1 must not start the ToolInvocation.

**When C5 (downstream) is unavailable:**
- The module system (`module avail`, `module load`) does not respond
  or errors out.
- C1 must not start the ToolInvocation. The Agent reports to C7 that
  the Environment could not be loaded.
- The ToolInvocation is not created or is created in a NOT_STARTED
  state and immediately rejected.
- Severity: CRITICAL. Without a verified Environment, the Tool cannot
  run safely — a missing library would cause a segfault or linker
  error at runtime, violating INV-E2.

**When C5 is out-of-order:**
- The Environment was loaded successfully at T0, but by T1 (when C1
  starts the ToolInvocation) the Environment has been purged or
  replaced by another process.
- C1 must re-verify the Environment immediately before invocation. If
  the Environment no longer matches, C1 rejects the ToolInvocation.
- The Agent must not assume the Environment persists across
  ToolInvocations without re-verification.

**When C5 is duplicated:**
- Two Sessions or processes attempt to load conflicting Environments
  in the same execution context (same login node, same shell).
- Only one Environment may be active per execution context (INV-E1).
  The second load is rejected if it conflicts.
- The Agent detects the conflict via C5 and notifies the User in C7.
- The Agent does not attempt to merge conflicting Environments.

**When C5 is slow:**
- `module load` takes an extended time (Lmod spider on a slow NFS
  mount, large module tree).
- C1 waits for the load to complete or time out. The ToolInvocation
  does not start until C5 confirms the Environment is active.
- The Agent may notify C7 that the Environment load is taking longer
  than expected, but does not proceed without confirmation.

---

## X2 — C1 (Tool Invocation) ↔ C4 (Scheduling)

**Flow:** A ToolInvocation that requires parallel execution (large
CDO remapping, NCO averaging across many files, any CESM run)
delegates to C4 by submitting a Job. C4 returns a JobID. C1 then
monitors the Job's state via C4. Synchronous ToolInvocations (short
CLI calls on login nodes) do not interact with C4 at all.

**Direction of call:** C1 → C4 (submit Job, query JobState, cancel
Job).

**Entities flowing:** ResourceRequest → C4 → Job (with JobID,
JobState).

**Contract that must hold:**
- The decision to delegate to C4 is made by C1 based on the Tool's
  execution model (synchronous CLI vs. parallel Job). This is a
  per-Tool property.
- If delegated, C1 does not report success until C4 reports a
  terminal JobState (INV-S1, INV-S4).
- The ResourceRequest is immutable after submission (INV-S2).
- C1 does not generate JobIDs — the Scheduler assigns them (INV-S3).

**When C4 (downstream) is unavailable:**
- SLURM is unreachable: `sbatch`, `squeue`, `scancel` return
  connection errors.
- C1 cannot submit the Job. The ToolInvocation is blocked or failed
  depending on the Workflow policy.
- If the Job was already submitted and C4 becomes unreachable, C1
  marks the JobState as UNKNOWN — not COMPLETED, not RUNNING (INV-S1
  caveat). C1 does not promote the Job based on file existence.
- The Agent notifies C7 that the Scheduler is unreachable. Retries
  with backoff.
- Severity: HIGH for synchronous tools (not affected), CRITICAL for
  parallel tools (cannot proceed).

**When C4 is out-of-order:**
- The Job was submitted and reached RUNNING, but C4 reports states in
  a non-sequential order (e.g., COMPLETED reported before a stale
  PENDING from a previous query).
- C1 trusts the most recent authoritative report from C4. Terminal
  states are final (INV-S4) — once COMPLETED is reported, a stale
  RUNNING from an older query does not demote the Job.
- The Agent does not reconcile C4's reports with file existence or
  elapsed time.

**When C4 is duplicated:**
- The Agent or User accidentally submits the same Job twice (e.g.,
  double-click, retry on a slow response).
- C4 assigns two distinct JobIDs — the Agent does not deduplicate at
  C4's level.
- The Agent detects the duplicate submission (same Case, same
  ResourceRequest, same inputs) and notifies the User. One of the
  Jobs may be cancelled via `scancel`.
- For CESM: INV-M2 prohibits two RUNNING Jobs per Case. The second
  submission is rejected if the first is still RUNNING.

**When C4 is slow:**
- `squeue` returns slowly (large queue, scheduler under load).
- C1 waits for the response or times out. On timeout, C1 marks the
  JobState as UNKNOWN and retries.
- The Agent may reduce query frequency to avoid overloading the
  Scheduler.
- The Workflow is not advanced based on stale or absent data.

---

## X3 — C1 (Tool Invocation) ↔ C3 (Data Management)

**Flow:** A ToolInvocation consumes input Datasets (referenced from
C3) and produces output Datasets (registered in C3). C1 queries C3
for input Dataset metadata (Format, Grid, Variables, Location) to
validate compatibility with the Tool. After successful execution, C1
registers new output Datasets in C3.

**Direction of call:** C1 → C3 (query input Dataset metadata,
register output Dataset), C3 → C1 (Dataset metadata, Location
resolution).

**Entities flowing:** Dataset (input, referenced) → C1 → Dataset
(output, registered).

**Contract that must hold:**
- Input Datasets must exist and have a ProvenanceRecord before
  consumption (INV-W1, INV-D3 — enforced jointly with C6).
- Output Datasets are registered only if the ToolInvocation's
  ExitOutcome indicates success (INV-T3).
- The Agent opens input Datasets for reading only — never for writing
  (INV-T4, INV-D1).
- A Dataset's Location must resolve to an existing, readable path (for
  inputs) or a writable path (for outputs) at the time of use
  (INV-D4).

**When C3 (downstream) is unavailable:**
- C3's storage (the filesystem or the Dataset registry) is
  unreachable.
- C1 cannot validate input Dataset metadata or register output
  Datasets.
- The ToolInvocation is blocked. If the input Dataset's Location
  cannot be resolved, the ToolInvocation is rejected (INV-D4).
- If the ToolInvocation has already completed but C3 is unavailable
  for output registration, the output Dataset is held in an
  unregistered state — it is NOT available for downstream
  consumption until C3 recovers and registration completes.

**When C3 is out-of-order:**
- An input Dataset was registered at T0, but by T1 (when the
  ToolInvocation starts) the Dataset's Location no longer resolves
  (file deleted, moved, or permissions changed).
- C1 re-validates the Location immediately before use (INV-D4). If
  the Location does not resolve, the ToolInvocation is rejected.
- The Agent notifies C7 that the input Dataset is no longer at its
  registered Location.

**When C3 is duplicated:**
- Two Datasets with the same content but different identities (e.g.,
  copied by the user) exist in C3.
- This is not a conflict — each Dataset has its own identity,
  Location, and ProvenanceRecord. The ToolInvocation consumes the
  specific Dataset referenced by identity, not by content.
- The Agent does not deduplicate Datasets based on content.

**When C3 is slow:**
- The filesystem (Lustre, GPFS) is under heavy load and metadata
  operations (stat, open) are slow.
- C1 waits for Location resolution. If resolution times out, the
  ToolInvocation is rejected (INV-D4).
- For output registration: if the filesystem is slow but writable,
  the ToolInvocation may proceed. The output Dataset is registered
  once the write completes and the ProvenanceRecord is written.
- The Agent may advise the User to stage data on a faster filesystem
  (local scratch vs. Lustre) if operations are consistently slow.

---

## X4 — C1 (Tool Invocation) ↔ C6 (Provenance)

**Flow:** Every ToolInvocation, upon completion (success or failure),
produces a ProvenanceRecord in C6. The record captures the full
reproducibility tuple: Tool identity, parameters, Environment,
inputs, output, timestamp, ExitOutcome.

**Direction of call:** C1 → C6 (create ProvenanceRecord).

**Entities flowing:** ToolInvocation result → ProvenanceRecord.

**Contract that must hold:**
- A ProvenanceRecord is created for every ToolInvocation, including
  failures (INV-P2). For failed ToolInvocations, the output field is
  null and the ExitOutcome is non-success.
- The ProvenanceRecord is created BEFORE the output Dataset is
  registered as available for downstream consumption (INV-T3, INV-P3,
  INV-D3 — jointly owned by C1, C3, C6).
- The ProvenanceRecord is immutable once written (INV-P1).
- The ProvenanceRecord must contain all fields of the reproducibility
  tuple — none may be null (INV-P2).

**When C6 (downstream) is unavailable:**
- The Provenance store is unreachable or the write fails.
- C1 must not register the output Dataset as available (the
  ProvenanceRecord does not exist — INV-D3 is violated if
  registration proceeds).
- The Agent retries the ProvenanceRecord write with backoff. If all
  retries fail, the User is notified and the output Dataset is held
  in an unregistered state.
- Severity: CRITICAL. Without Provenance, the Dataset is not
  scientifically valid — it cannot be audited or reproduced.

**When C6 is out-of-order:**
- A ProvenanceRecord was written at T0, but by T1 the record is
  corrupted, partially written, or missing.
- C1 (via C3's check) detects that no valid ProvenanceRecord exists
  for the Dataset. The Dataset is quarantined — not available for
  downstream consumption.
- The Agent attempts to reconstruct the ProvenanceRecord from
  available metadata (ToolInvocation logs, Environment state). If
  reconstruction fails, the User is notified.

**When C6 is duplicated:**
- Two ProvenanceRecords are written for the same Dataset (e.g.,
  retry after a partial write, or a bug).
- ProvenanceRecords are immutable and identified by their own
  identity. The Agent detects the duplicate (same Dataset identity,
  same Tool, same timestamp) and flags it. One record is designated
  as authoritative; the other is linked as a duplicate.
- The Dataset remains available as long as at least one valid
  ProvenanceRecord exists.

**When C6 is slow:**
- ProvenanceRecord writes are slow (storage under load, network
  latency to a remote provenance store).
- C1 waits for the write to complete before registering the output
  Dataset. The ToolInvocation is not considered complete until the
  ProvenanceRecord is written.
- If the write times out, C1 retries with backoff. The output Dataset
  is held in an unregistered state until the ProvenanceRecord
  succeeds.

---

## X5 — C2 (Model Execution) ↔ C4 (Scheduling)

**Flow:** CESM's `case.submit` creates a Job in C4 by submitting to
SLURM via `sbatch`. C4 returns a JobID. C2 monitors the Job's state
via C4 (`squeue`, `sacct`) until a terminal state is reached.

**Direction of call:** C2 → C4 (submit Job, query JobState, cancel
Job).

**Entities flowing:** Case (with ResourceRequest) → C4 → Job (with
JobID, JobState).

**Contract that must hold:**
- The Case must be in BUILT state before submission (INV-M1).
- The Case's run length must not exceed the Job's Wall Time (INV-M3).
- The Case's output tree Location must be determined and recorded
  before submission (INV-M4).
- The Case has at most one RUNNING Job at a time (INV-M2).
- Resubmission requires the prior Job to have reached a terminal
  state (INV-M2).
- JobState transitions are authoritative only as reported by C4
  (INV-S1).

**When C4 (downstream) is unavailable:**
- SLURM is unreachable at submission time: `case.submit` fails. The
  Case remains in BUILT state. The User is notified. No Job is
  created. The Agent does not retry automatically (the User should
  decide when to retry).
- SLURM becomes unreachable while the Job is RUNNING: C2 queries C4
  via `squeue` and gets a connection error. C2 marks the JobState as
  UNKNOWN — not COMPLETED, not RUNNING. The Case state is not
  advanced. The Agent retries with backoff. When C4 recovers, the
  actual JobState is queried via `sacct`.
- Severity: CRITICAL. A CESM run represents days to weeks of compute.
  Losing track of a running Job's state is unacceptable — the Agent
  must never assume completion based on file existence.

**When C4 is out-of-order:**
- The Job transitions from RUNNING to TIMEOUT, but a stale squeue
  query still shows RUNNING.
- C2 trusts the most recent authoritative report. Once `sacct` shows
  TIMEOUT, the Job is in terminal state (INV-S4). A stale squeue
  showing RUNNING does not demote it.
- The Case state advances to FAILED (or allows resubmission per
  User action).

**When C4 is duplicated:**
- The User or Agent accidentally calls `case.submit` twice for the
  same Case while the first Job is still RUNNING.
- C2 rejects the second submission (INV-M2 — at most one RUNNING Job
  per Case). The User is notified that the Case already has a
  RUNNING Job.
- If the first Job has reached a terminal state, the second
  submission is allowed and creates a new Job with a new JobID.

**When C4 is slow:**
- `squeue` is slow due to a large queue or scheduler load.
- C2 waits for the response or times out. On timeout, C2 marks the
  JobState as UNKNOWN and retries with backoff.
- The Agent may reduce query frequency (e.g., from every 30 seconds
  to every 5 minutes) to avoid overloading the Scheduler.
- The Case state is not advanced based on stale or absent data.

---

## X6 — C2 (Model Execution) ↔ C3 (Data Management)

**Flow:** After a CESM Job reaches COMPLETED, the output tree at the
recorded Location is scanned and registered as one or more Datasets
in C3. Each Dataset has a Format (NetCDF), a Grid (typically lat-lon
for CESM output), and one or more Variables.

**Direction of call:** C2 → C3 (register output Datasets from output
tree).

**Entities flowing:** Output tree (Location) → C3 → Dataset (one per
output file or logical group).

**Contract that must hold:**
- The output tree Location must be determined and recorded before
  submission (INV-M4).
- Each output Dataset is registered only after the Job reaches
  COMPLETED (not based on file existence while the Job is RUNNING).
- Each registered Dataset must have a ProvenanceRecord (via X4/C6)
  before it is consumable downstream (INV-D3).
- The output Datasets are new entities — they do not modify the
  Case's input Datasets (INV-D1).

**When C3 (downstream) is unavailable:**
- The filesystem where the output tree resides is unreachable, or the
  Dataset registry is down.
- C2 cannot register the output Datasets. The Job is still COMPLETED
  (as reported by C4), but the output Datasets are not yet available
  for downstream consumption.
- The Agent retries registration when C3 recovers. The output tree
  itself is on the filesystem and is not lost.
- Severity: HIGH. The Job completed successfully but downstream steps
  cannot proceed until Datasets are registered.

**When C3 is out-of-order:**
- The output tree was expected at Location X, but CESM wrote to a
  different Location (e.g., a runtime configuration override).
- C2 must not guess the output Location after the fact (INV-M4). If
  the expected Location is empty but files appear elsewhere, the
  Agent investigates and asks the User to confirm.
- This scenario is flagged as UNKNOWN in assumptions.md: does CESM's
  `case.submit` fix the output location, or can it vary?

**When C3 is duplicated:**
- The same output tree is registered twice (e.g., after a retry).
- Each registration creates distinct Dataset entities. The Agent
  detects the duplicate (same Location, same content) and flags it.
  One set is designated as authoritative; the other is marked as a
  duplicate reference.
- The ProvenanceRecord for the duplicate references the same Job.

**When C3 is slow:**
- The output tree is large (terabytes) and scanning it for Dataset
  registration is slow.
- C2 registers Datasets incrementally as they are identified. The
  User is notified of progress.
- Downstream steps that depend on specific output Datasets can start
  once those specific Datasets are registered (with Provenance), even
  if the full tree scan is not complete.

---

## X7 — C3 (Data Management) ↔ C6 (Provenance)

**Flow:** A Dataset in C3 is not consumable (by any ToolInvocation or
WorkflowStep) until a ProvenanceRecord for that Dataset exists in C6.
C3 queries C6 to verify Provenance before allowing consumption.

**Direction of call:** C3 → C6 (verify ProvenanceRecord exists),
C6 → C3 (confirmation or denial).

**Entities flowing:** Dataset identity → C6 → ProvenanceRecord (or
null).

**Contract that must hold:**
- A ProvenanceRecord must exist before a Dataset is consumed (INV-D3,
  INV-P3 — jointly owned by C3 and C6).
- The ProvenanceRecord must contain the full reproducibility tuple
  (INV-P2).
- The ProvenanceRecord is immutable once written (INV-P1).
- ProvenanceRecords survive Session end (INV-P4) — a Dataset produced
  in Session `s1` is consumable in Session `s2` because its
  ProvenanceRecord persists.

**When C6 (downstream) is unavailable:**
- C3 cannot verify Provenance. No Dataset may be consumed.
- All WorkflowSteps that depend on Datasets are blocked (INV-W1).
- The Agent notifies C7 that the Provenance store is unreachable.
  Retries with backoff.
- Severity: CRITICAL. Without Provenance verification, scientific
  integrity is at risk — a Dataset without provenance cannot be
  audited or reproduced.

**When C6 is out-of-order:**
- A ProvenanceRecord was written but is now corrupted, partially
  written, or missing.
- C3's verification fails. The Dataset is quarantined — not available
  for consumption.
- The Agent attempts to reconstruct the ProvenanceRecord from
  available metadata (ToolInvocation logs, Environment state). If
  reconstruction fails, the User is notified and the Dataset remains
  quarantined.

**When C6 is duplicated:**
- Two ProvenanceRecords exist for the same Dataset.
- C3's verification succeeds (at least one valid ProvenanceRecord
  exists). The Agent flags the duplicate and designates one as
  authoritative.
- The Dataset is available for consumption as long as at least one
  valid ProvenanceRecord exists.

**When C6 is slow:**
- Provenance verification is slow (remote store, network latency).
- C3 waits for verification before allowing consumption. If
  verification times out, the Dataset is not consumable.
- The Agent may cache verification results within a Session to avoid
  repeated queries for the same Dataset. The cache is invalidated at
  Session end.

---

## X8 — C4 (Scheduling) ↔ C7 (Agent Interaction)

**Flow:** A Session in C7 may submit Jobs via C4 (through C1 or C2)
and may end before those Jobs complete. The Jobs are not cancelled
when the Session ends. A later Session can discover those Jobs by
JobID and query their state via C4.

**Direction of call:** C7 → C4 (via C1 or C2: submit, query, cancel),
C4 → C7 (JobState reports relayed to the User).

**Entities flowing:** Session (with User identity) → C4 → Job (with
JobID, JobState), discoverable across Sessions.

**Contract that must hold:**
- End-of-Session does not cause any RUNNING Job to be cancelled
  (INV-W4).
- A Job submitted in Session `s1` is discoverable in Session `s2` by
  its JobID (INV-W4).
- The Job's state in `s2` is queried from C4 (the Scheduler is
  authoritative — INV-S1), not inferred from file existence or
  Session-local state.
- The User's HPC account and SLURM username are consistent across
  Sessions (they identify the User, not the Session).

**When C4 (downstream) is unavailable:**
- A Session ends while Jobs are RUNNING. Later, a new Session begins
  but C4 is unreachable.
- The new Session cannot query Job states. All Jobs from the prior
  Session are marked UNKNOWN — not COMPLETED, not RUNNING.
- The Agent notifies the User that the Scheduler is unreachable and
  Job states are unknown. The Agent retries with backoff.
- When C4 recovers, the actual Job states are queried via `sacct` for
  Jobs that may have completed during the outage.
- Severity: HIGH. The Jobs are still running on the cluster (SLURM
  does not cancel them), but the Agent has lost visibility.

**When C4 is out-of-order:**
- A Job submitted in Session `s1` reached a terminal state (e.g.,
  COMPLETED) during the gap between Sessions. The new Session `s2`
  queries `squeue` and gets nothing (the Job is no longer in the
  active queue).
- The Agent must query `sacct` (historical job data) to discover the
  terminal state. If `sacct` is also unavailable, the Job state
  remains UNKNOWN until `sacct` recovers.
- The Agent must not infer COMPLETED from output file existence
  (INV-S1).

**When C4 is duplicated:**
- Two Sessions (same User, different sessions) both query the same
  Job. This is not a conflict — both Sessions receive the same
  authoritative JobState from C4.
- If both Sessions attempt to cancel the same Job, the first
  `scancel` succeeds; the second gets an error (Job already
  cancelled). The Agent handles this gracefully.

**When C4 is slow:**
- Job state queries are slow (large queue, scheduler under load).
- The Session waits for the response or times out. On timeout, the
  Job state is marked UNKNOWN and retried.
- The Agent may reduce query frequency for long-running Jobs (e.g.,
  CESM runs that last weeks do not need 30-second polling).

---

## X9 — C5 (Environment Management) ↔ C2 (Model Execution)

**Flow:** CESM has specific compiler and MPI requirements (e.g.,
Intel compiler with Intel MPI, or GCC with OpenMPI). C2 queries C5
to load the correct Environment before building or submitting a CESM
Case. C5 must verify that the Environment satisfies CESM's
requirements.

**Direction of call:** C2 → C5 (load Environment with specific
compiler/MPI requirements), C5 → C2 (Environment identity or
rejection).

**Entities flowing:** CESM (with compiler/MPI requirements) → C5 →
Environment (with Modules, Compiler Stack, MPI runtime).

**Contract that must hold:**
- The Environment loaded for CESM must include the correct compiler
  (e.g., `intel/2021.4`), MPI runtime (e.g., `intel-mpi/2021.4`), and
  any CESM-specific Modules (e.g., `craype/2.7.10`).
- The Environment must be verified conflict-free before building
  (INV-E2).
- The Environment identity must be recorded in the ProvenanceRecord
  for the CESM Job (via X4/X5).
- If the Environment does not match CESM's requirements, the build or
  submission is rejected.

**When C5 (downstream) is unavailable:**
- The module system is unreachable. C2 cannot load the CESM
  Environment.
- The CESM build or submission is blocked. The Case state is not
  advanced.
- The Agent notifies C7 that the required Environment could not be
  loaded.
- Severity: CRITICAL for build (cannot proceed), HIGH for submission
  (build is done, but submission may require the Environment for
  runtime configuration).

**When C5 is out-of-order:**
- The Environment was loaded for building, but by submission time the
  Environment has changed (another process loaded a different stack).
- C2 must re-verify the Environment before submission. If the
  Environment no longer matches CESM's requirements, the submission
  is rejected.
- The Agent must not assume the Environment persists between build and
  submit phases without re-verification.

**When C5 is duplicated:**
- Two CESM Cases require the same Environment. This is not a conflict
  — both can load the same Environment (same Modules, same Compiler
  Stack) as long as they are in the same execution context.
- If they require different Environments (e.g., one needs Intel, one
  needs GCC), they cannot share an execution context (INV-E1). The
  Agent loads one Environment, completes that Case's build/submit,
  then purges and loads the other.

**When C5 is slow:**
- `module load` for the CESM Environment (many Modules, complex
  dependencies) is slow.
- C2 waits for the load to complete or times out. The build or
  submission does not proceed until C5 confirms the Environment is
  active and conflict-free.

---

## X10 — C7 (Agent Interaction) ↔ C1 (Tool Invocation)

**Flow:** The Agent in C7 translates the User's scientific intent
(expressed in natural language) into a sequence of ToolInvocations
in C1. C7 manages the Workflow, while C1 executes individual
ToolInvocations.

**Direction of call:** C7 → C1 (create ToolInvocation with Tool,
parameters, input Datasets), C1 → C7 (ExitOutcome, output Dataset
identity).

**Entities flowing:** User intent → C7 → Workflow (with
WorkflowSteps) → C1 → ToolInvocation → C7 (ExitOutcome, output
Dataset).

**Contract that must hold:**
- The Agent does not invoke Tools directly — it creates
  ToolInvocations that reference Tools, Environments, and input
  Datasets.
- The Agent must verify that each ToolInvocation's Environment is
  loaded (via X1) and input Datasets exist with Provenance (via X3,
  X7) before starting the ToolInvocation.
- The Agent must not hallucinate Tool names or parameters — if a
  requested Tool or parameter is not in the Tool catalog, the Agent
  asks the User for clarification rather than guessing.

**When C1 (downstream) is unavailable:**
- A Tool binary is not loaded (the Environment is missing the Tool's
  Module). C1 rejects the ToolInvocation before execution (INV-T1).
- C7 is notified and offers to load the required Environment (via X1)
  or asks the User to confirm the correct Tool.

**When C1 is out-of-order:**
- A ToolInvocation is RUNNING but the underlying process is
  unresponsive (e.g., stuck on I/O, infinite loop).
- C1 must distinguish between a slow process and a hung process.
  C1 does not kill the process without User confirmation (unless the
  Job is cancelled via C4).
- C7 notifies the User of the unresponsive ToolInvocation.

**When C1 is duplicated:**
- The Agent accidentally creates two ToolInvocations for the same
  operation on the same input Dataset.
- Both ToolInvocations run independently. If they write to the same
  output Location, the second write may fail or corrupt the first
  output.
- C7 should detect the duplicate (same Tool, same parameters, same
  inputs, same output Location) and refuse the second
  ToolInvocation.

**When C1 is slow:**
- A ToolInvocation takes longer than expected (large Dataset, slow
  filesystem).
- C1 waits for the ToolInvocation to complete. C7 is notified of the
  delay but does not interrupt the ToolInvocation.
- If the ToolInvocation was delegated to C4 (a Job), C7 monitors the
  JobState via C4 (X2, X8).

---

## Additional Cross-Cutting Scenarios

### SLURM unavailable

**Affected interactions:** X2 (C1↔C4), X5 (C2↔C4), X8 (C4↔C7).

When SLURM is completely unavailable:
- No new Jobs can be submitted. Synchronous ToolInvocations (short
  CLI calls on login nodes) are NOT affected — they do not use C4.
- Running Jobs continue on compute nodes (SLURM's daemon being
  unreachable on the login node does not kill running Jobs).
- The Agent cannot query Job states — all Jobs are marked UNKNOWN.
- The Agent must not promote any Job to COMPLETED based on file
  existence or elapsed time (INV-S1).
- The Agent retries squeue/sacct with backoff. When SLURM recovers,
  the Agent reconciles Job states via `sacct` (historical data
  includes Jobs that completed during the outage).
- The User is notified of the outage and its impact on running
  Workflows.
- Severity: CRITICAL for parallel Workflows, LOW for synchronous
  ToolInvocations.

### Tool binary not loaded

**Affected interactions:** X1 (C1↔C5), X14 (C5↔C1).

When a Tool binary is not in the current Environment:
- C1 checks C5 before invocation. If the Tool's Module is not loaded,
  the ToolInvocation is rejected (INV-T1).
- C5 verifies Module availability via `module avail` before
  attempting to load (INV-E3). If the Module does not exist on the
  host, the load is refused and the User is notified.
- The Agent offers to load the required Environment (purging the
  current one if necessary, per INV-E1) or to find an alternative
  Tool.
- The Agent must not attempt to invoke a Tool whose binary is not in
  `PATH` — this produces a noisy, low-signal error that is
  indistinguishable from a Tool bug.
- Severity: HIGH. The ToolInvocation cannot proceed, but the system
  is not corrupted. The Agent provides actionable guidance.

### Data on a different filesystem

**Affected interactions:** X3 (C1↔C3), X6 (C2↔C3).

When an input Dataset resides on a different filesystem than the
output Location (e.g., input on `/store` (tape-backed), output on
`/scratch` (SSD)):
- C1 must validate that the input Dataset's Location resolves to a
  readable path and the output Location resolves to a writable path
  (INV-D4).
- The Agent should respect data locality: rather than shuffling large
  Datasets between filesystems, the Agent should prefer to run Tools
  close to the data (on nodes with direct access to the filesystem
  where the data resides).
- If the input is on a slow filesystem (tape, cold Lustre), the
  Agent may advise staging the data to a faster filesystem (local
  scratch, hot Lustre) before processing. Staging is itself a
  ToolInvocation that produces a new Dataset (with its own
  ProvenanceRecord).
- CESM output (X6) is typically written to the Case's run directory
  on the filesystem specified at submission time (INV-M4). If this
  filesystem is different from where downstream Tools expect their
  inputs, the Agent handles the Location transition explicitly —
  no implicit copying.
- Concurrent writes to the same output Location on a parallel
  filesystem (Lustre, GPFS) are the filesystem's responsibility, not
  the Agent's. The Agent must not write to the same output Location
  from two ToolInvocations simultaneously.
- Severity: MEDIUM for performance (slow filesystem), HIGH for
  correctness (wrong filesystem path, permission denied).
