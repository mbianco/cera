# Module Graph — cera

> Derived from `domain-model.md` (updated per `resolutions.md` R1–R13),
> `cross-context/interactions.md`, and `ubiquitous-language.md`.
>
> C2 (Model Execution) is **collapsed into C1** per R1. CESM is a Model
> Tool subtype, not a peer entity. There are **6 bounded contexts**.

---

## Overview

| Module | Bounded context | dsh mount point | Internal deps |
|--------|----------------|-----------------|---------------|
| `dsh-adapter` | (infrastructure) | all (wraps) | none (external: dsh) |
| `scheduling` | C4 — Scheduling | `ctx.jobs`, `ctx.subprocess` | `dsh-adapter` |
| `environment-management` | C5 — Environment Management | `ctx.subprocess`, `ctx.fs` | `dsh-adapter` |
| `provenance` | C6 — Provenance | `ctx.fs` | `dsh-adapter` |
| `data-management` | C3 — Data Management | `ctx.fs` | `provenance`, `dsh-adapter` |
| `tool-invocation` | C1 — Tool Invocation (incl. CESM) | `ctx.tools`, `ctx.shell`, `ctx.subprocess`, `ctx.sandbox` | `environment-management`, `data-management`, `provenance`, `scheduling`, `dsh-adapter` |
| `agent-interaction` | C7 — Agent Interaction (incl. Experiment, Workflow) | `ctx.tools`, `ctx.commands` | `tool-invocation`, `data-management`, `provenance`, `scheduling`, `dsh-adapter` |

**No cyclic dependencies.** The dependency graph is acyclic (see
`dependency-graph.md`).

---

## Module Details

### 1. `dsh-adapter` — dsh Isolation Layer

**Not a bounded context.** Infrastructure module that wraps dsh's
volatile extension points into stable cera-internal interfaces. This
is the mitigation for A1 (dsh developer-preview, breaking-change risk)
and the subject of ADR-005.

**Owned entities:** None.

**Dependencies:** dsh (external, pinned version). No internal cera
dependencies.

**Public surface:**
- `ShellExecutor` — wraps `ctx.shell` for CLI tool execution
- `SubprocessRunner` — wraps `ctx.subprocess` for fine-grained process control
- `SandboxRunner` — wraps `ctx.sandbox` for process confinement
- `FilesystemGateway` — wraps `ctx.fs` for filesystem access/validation
- `JobBackend` — wraps `ctx.jobs` for background work submission
- `ToolRegistry` — wraps `ctx.tools` for model-facing capability registration
- `CommandRegistry` — wraps `ctx.commands` for human-command dispatch

**dsh extension point:** All (`ctx.shell`, `ctx.subprocess`, `ctx.sandbox`,
`ctx.fs`, `ctx.jobs`, `ctx.tools`, `ctx.commands`). This is the **only**
module that imports dsh directly. All other modules import
`dsh-adapter` instead.

**Spec references:** `assumptions.md` A1; `resolutions.md` R9 (uenv
requires subprocess and fs access); `failure-modes.md` FM-X3 (dsh
breaking change).

---

### 2. `scheduling` — C4 Scheduling (SLURM)

**Owned entities:** Job, JobID, ResourceRequest, JobState, Partition,
QoS.

**Ubiquitous language:** Job, Scheduler (SLURM), Partition, QoS,
Resource Request, State (Job), Job ID.

**Dependencies:**
- `dsh-adapter` — for subprocess execution of `sbatch`, `squeue`,
  `scancel`, `sacct`.

**Public surface:**
- `submitJob(request: SubmitJobInput): Promise<Job>` — submits to SLURM
  via `sbatch`; returns Job with scheduler-assigned JobID (INV-S3).
- `queryJob(jobId: JobId): Promise<Job>` — queries via `squeue` or
  `sacct` depending on job liveness.
- `queryJobsByUser(username: string): Promise<Job[]>` — queries all
  Jobs for a User (for proactive reporting, R7).
- `cancelJob(jobId: JobId): Promise<void>` — cancels via `scancel`.
- `reconcileViaSacct(jobIds: JobId[]): Promise<Job[]>` — reconciles
  unknown states using historical data (FM-S2, R13).

**dsh extension point:** `ctx.jobs` (via `dsh-adapter.JobBackend`),
`ctx.subprocess` (via `dsh-adapter.SubprocessRunner` for SLURM CLI).

**Key design decisions:**
- SLURM-only, no scheduler abstraction (R8, ADR-004). The module exposes
  a clean interface for testability (mock SLURM CLI), but the domain
  types are SLURM-specific.
- Job states come only from the Scheduler (INV-S1). The module never
  infers states from file existence.
- When SLURM is unreachable, Jobs are marked `UNKNOWN` (not promoted/
  demoted). Retries with backoff. `UNKNOWN` is acceptable for up to 30
  minutes (R13).
- ResourceRequest is immutable after submission (INV-S2).
- Terminal states are final (INV-S4).

**Spec references:** `domain-model.md` C4; `invariants.md` INV-S1–S4;
`resolutions.md` R8 (SLURM only), R13 (UNKNOWN acceptable);
`cross-context/interactions.md` X2, X5 (now C1↔C4), X8;
`failure-modes.md` FM-S1–S4; `features/job-management.feature`.

---

### 3. `environment-management` — C5 Environment Management (uenv)

**Owned entities:** Environment, UenvMount, CompilerStack.

**Ubiquitous language:** Environment, Module (now uenv component),
Compiler Stack, MPI, uenv.

**Dependencies:**
- `dsh-adapter` — for uenv CLI commands (mount/unmount/list) via
  `SubprocessRunner`, and for filesystem path verification via
  `FilesystemGateway`.

**Public surface:**
- `checkUenvAvailability(name: string, version: string): Promise<boolean>`
  — checks the uenv registry (INV-E3). Replaces `module avail`/
  `module spider`.
- `loadUenv(request: LoadUenvInput): Promise<Environment>` — mounts a
  uenv (squashfs) at its prescribed path, verifies the mount is
  conflict-free (INV-E1, INV-E2), and returns an active Environment.
- `unloadUenv(environmentId: EnvironmentId): Promise<void>` — unmounts
  a uenv.
- `verifyEnvironment(environmentId: EnvironmentId): Promise<boolean>`
  — re-verifies an Environment is still active and conflict-free
  (for re-verification before invocation, per X1 "out-of-order" case).
- `detectConflicts(uenvSpecs: UenvSpec[]): Promise<Conflict[]>` —
  detects filesystem path conflicts between uenvs (INV-E2, updated for
  uenv: path-level, not soname-level).
- `getActiveEnvironment(): Environment | null` — returns the currently
  active Environment, if any.

**dsh extension point:** `ctx.subprocess` (via `dsh-adapter` for uenv
CLI commands), `ctx.fs` (via `dsh-adapter` for mount path verification).

**Key design decisions:**
- uenv, not Lmod (R9, ADR-003). Environments are squashfs mounts at
  prescribed paths, not `module load` operations.
- Conflict detection is at the filesystem path level: two uenvs
  conflict if they provide different versions of the same library at
  paths that would both appear in `LD_LIBRARY_PATH` or `PATH`.
  (INV-E2 re-evaluated for uenv.)
- Availability check uses the uenv registry/mount system, not
  `module avail`/`module spider` (INV-E3 updated).
- INV-E1 (one active Environment per execution context): with uenv,
  multiple uenvs **may** be mounted simultaneously if complementary
  (no path conflicts), but only one logical Environment (the set of
  active mount paths in `PATH`/`LD_LIBRARY_PATH`) is active at a time.
  If two uenvs have path conflicts, the second load is rejected.

**Spec references:** `domain-model.md` C5; `invariants.md` INV-E1–E3
(re-evaluated for uenv per R9); `resolutions.md` R9 (uenv not Lmod),
R10 (opengrads not mandatory); `assumptions.md` A4 (updated to uenv);
`cross-context/interactions.md` X1, X9 (now C5↔C1), X14;
`failure-modes.md` FM-E1–E3; `features/environment-management.feature`.

> **SPEC GAP:** `environment-management.feature` still references Lmod
> commands (`module load`, `module avail`, `module spider`) and has an
> `@lmod` tag. R9 supersedes this with uenv. See
> `specs/escalations/001-environment-feature-needs-uenv-rewrite.md`.

---

### 4. `provenance` — C6 Provenance

**Owned entities:** ProvenanceRecord.

**Ubiquitous language:** Provenance, Reproducibility, Provenance Record.

**Dependencies:**
- `dsh-adapter` — for filesystem persistence of ProvenanceRecords.

**Public surface:**
- `writeProvenanceRecord(input: WriteProvenanceInput): Promise<ProvenanceRecord>`
  — writes an immutable ProvenanceRecord (INV-P1). All fields must be
  non-null (INV-P2).
- `queryProvenanceRecord(datasetId: DatasetId): Promise<ProvenanceRecord | null>`
  — queries the ProvenanceRecord for a Dataset.
- `queryProvenanceForJob(jobId: JobId): Promise<ProvenanceRecord | null>`
  — queries the ProvenanceRecord for a Job outcome.
- `queryLineage(datasetId: DatasetId): Promise<ProvenanceRecord[]>`
  — queries the full lineage chain for a Dataset.
- `verifyProvenance(datasetId: DatasetId): Promise<boolean>`
  — verifies a ProvenanceRecord exists and is valid for a Dataset
  (INV-D3, INV-P3).
- `reconstructProvenanceRecord(input: ReconstructInput): Promise<ProvenanceRecord | null>`
  — attempts to reconstruct a corrupted/missing ProvenanceRecord from
  available metadata.
- `quarantineDataset(datasetId: DatasetId, reason: string): Promise<void>`
  — quarantines a Dataset whose ProvenanceRecord is corrupted (R11:
  local, not systemic).

**dsh extension point:** `ctx.fs` (via `dsh-adapter.FilesystemGateway`
for persistence).

**Key design decisions:**
- ProvenanceRecords are immutable once written (INV-P1). Corrections
  create a new record linked to the original via a "corrects"
  relationship.
- ProvenanceRecords persist across Sessions (INV-P4). The store is
  filesystem-based on the HPC system.
- Corrupted ProvenanceRecord is a **local** issue (R11): quarantine the
  affected Dataset only, not the entire store. Other Datasets with
  valid records remain available.
- A ProvenanceRecord must be written **before** its output Dataset is
  registered as available (INV-T3, INV-D3, INV-P3 — jointly enforced
  by tool-invocation, data-management, and provenance).

**Spec references:** `domain-model.md` C6; `invariants.md` INV-P1–P4;
`resolutions.md` R11 (local corruption); `cross-context/interactions.md`
X4, X7; `failure-modes.md` FM-P1–P3; `features/provenance.feature`.

---

### 5. `data-management` — C3 Data Management

**Owned entities:** Dataset, Format, Grid, Variable, Location.

**Ubiquitous language:** Dataset, Format, Grid, Variable, Location,
NetCDF, ZARR, GRIB2, lat-lon, ICON, healpix.

**Dependencies:**
- `provenance` — X7: a Dataset is not consumable until its
  ProvenanceRecord exists. `data-management` calls `provenance.
  verifyProvenance()` before marking a Dataset as consumable.
- `dsh-adapter` — for filesystem access and Location validation.

**Public surface:**
- `registerDataset(input: RegisterDatasetInput): Promise<Dataset>`
  — registers a new Dataset with its Format, Grid, Variables, and
  Location. The Dataset is not consumable until its ProvenanceRecord
  exists (INV-D3).
- `queryDataset(id: DatasetId): Promise<Dataset | null>`
  — queries a Dataset by identity.
- `listDatasets(filter?: DatasetFilter): Promise<Dataset[]>`
  — lists Datasets, optionally filtered by Format, Grid, or Variable.
- `validateLocation(location: Location, mode: 'read' | 'write'): Promise<boolean>`
  — validates that a Location resolves to an existing, readable path
  (for inputs) or a writable path (for outputs) at the time of use
  (INV-D4).
- `markConsumable(datasetId: DatasetId): Promise<void>`
  — marks a Dataset as available for downstream consumption. Only
  called after `provenance.verifyProvenance()` returns true.
- `quarantineDataset(datasetId: DatasetId, reason: string): Promise<void>`
  — quarantines a Dataset (corrupted, missing Provenance, etc.).

**dsh extension point:** `ctx.fs` (via `dsh-adapter.FilesystemGateway`
for filesystem access and Location validation).

**Key design decisions:**
- Dataset immutability (INV-D1): a Dataset, once created, is not
  modified in place. The module never provides write handles to input
  Datasets. The Agent's own behavior never modifies a created Dataset
  (external mutation is flagged, see FM-X5).
- One Format, one Grid per Dataset (INV-D2): these are immutable for
  the lifetime of the Dataset. A format or grid conversion produces a
  new Dataset with its own identity.
- Provenance before consumption (INV-D3): `markConsumable()` can only
  be called after `provenance.verifyProvenance()` returns true. This
  is the joint enforcement point with C6.
- Location validation (INV-D4): `validateLocation()` is called
  immediately before a ToolInvocation reads or writes a Dataset's
  Location.

**Spec references:** `domain-model.md` C3; `invariants.md` INV-D1–D4;
`cross-context/interactions.md` X3, X6 (now C1↔C3), X7, X12;
`failure-modes.md` FM-D1–D5; `features/zarr-io.feature`,
`features/grid-conversion.feature`.

---

### 6. `tool-invocation` — C1 Tool Invocation (including CESM)

**Owned entities:** Tool, CLITool, PythonTool, ModelTool (CESM),
ToolInvocation, ExitOutcome, Case, CaseState, Compset.

**Ubiquitous language:** Tool, CLI Tool, Python Tool, Model Tool,
ToolInvocation, Exit Code, Signal, Case (CESM), Compset, Forward Model,
Wall Time, Action (via C7).

**Dependencies:**
- `environment-management` (X1, X9, X14) — must load and verify an
  Environment matching the Tool's requirements **before** a
  ToolInvocation enters the RUNNING phase (INV-T1, INV-E2). For CESM,
  the Environment must include the correct compiler and MPI runtime.
- `data-management` (X3, X6) — queries input Dataset metadata to
  validate compatibility, registers output Datasets after successful
  execution (INV-T3). For CESM, the output tree is registered as
  Datasets after the Job reaches COMPLETED.
- `provenance` (X4) — every ToolInvocation produces a ProvenanceRecord
  (success or failure) before its output Dataset is registered as
  available (INV-T3, INV-P3).
- `scheduling` (X2, X5) — parallel ToolInvocations (large CDO remaps,
  NCO averaging, **any CESM run**) delegate to Scheduling by
  submitting a Job. Synchronous ToolInvocations (short CLI calls on
  login nodes) do not interact with Scheduling.
- `dsh-adapter` — for shell execution, subprocess spawning, and
  process confinement.

**Public surface:**
- `invokeTool(request: ToolInvocationRequest): Promise<ToolInvocationResult>`
  — creates and executes a ToolInvocation. The lifecycle is: create →
  verify Environment (via `environment-management`) → verify input
  Datasets (via `data-management`) → start → monitor → complete/fail.
  If the Tool's execution model is `parallel`, delegates to
  `scheduling.submitJob()` and monitors via `scheduling.queryJob()`.
- `createCase(input: CreateCaseInput): Promise<Case>`
  — creates a new CESM Case. The output tree Location is determined
  at Case creation (R5, INV-T9). Case state is CREATED.
- `configureCase(caseId: CaseId, config: CaseConfig): Promise<Case>`
  — configures the Case. Case state transitions to CONFIGURED. This
  is a ToolInvocation (CESM's `case.setup`).
- `buildCase(caseId: CaseId): Promise<Case>`
  — builds the Case. Case state transitions to BUILT on success,
  remains CONFIGURED on failure (FM-M1). This is a ToolInvocation
  (CESM's `case.build`).
- `submitCase(caseId: CaseId, resourceRequest: ResourceRequest): Promise<Case>`
  — submits the Case via `case.submit`, which creates a Job via
  `scheduling.submitJob()`. Validates: Case is in BUILT state
  (INV-T6), run length ≤ wall time (INV-T8), output tree Location is
  set and writable (INV-T9). Case state transitions to SUBMITTED.
- `monitorCase(caseId: CaseId): AsyncObservable<CaseState>`
  — monitors the Case's Job via `scheduling.queryJob()` until a
  terminal state is reached. Case state transitions to RUNNING,
  then COMPLETED/FAILED/TIMEOUT/CANCELLED.
- `registerCaseOutput(caseId: CaseId): Promise<Dataset[]>`
  — after the Job reaches COMPLETED, scans the output tree and
  registers Datasets via `data-management.registerDataset()`.
- `getToolCatalog(): Promise<Tool[]>`
  — returns the catalog of registered Tools (for LLM validation).
- `registerTool(tool: Tool): Promise<void>`
  — registers a Tool in the catalog.

**dsh extension point:** `ctx.tools` (via `dsh-adapter.ToolRegistry`
for tool registration), `ctx.shell` (via `dsh-adapter.ShellExecutor`
for CLI execution), `ctx.subprocess` (via `dsh-adapter.SubprocessRunner`
for subprocess execution), `ctx.sandbox` (via `dsh-adapter.SandboxRunner`
for process confinement).

**Key design decisions:**
- CESM is a Model Tool subtype, not a peer entity (R1, ADR-001). The
  Case aggregate lives in C1. The Case lifecycle (create → configure →
  build → submit → monitor → post-process) is a specialized
  ToolInvocation lifecycle.
- Strict exit codes (R4, ADR-008): any non-zero exit code blocks
  output registration (INV-T3). Permissive mode is opt-in per
  ToolInvocation via `permissiveExitCodes` field (User must explicitly
  override).
- Signal vs. exit-code distinction (INV-T5): a process terminated by
  a Signal is reported as a Signal, never mapped to a synthetic exit
  code.
- Input immutability (INV-T4): the module opens input Datasets for
  reading only, never for writing.
- Single exit outcome (INV-T2): a terminated ToolInvocation has
  exactly one ExitOutcome.
- CESM output location is fixed at Case creation (R5, INV-T9).

**Spec references:** `domain-model.md` C1, C2 (collapsed into C1);
`invariants.md` INV-T1–T9 (INV-M1–M4 renumbered as INV-T6–T9 per R1);
`resolutions.md` R1 (CESM is Tool), R4 (strict exit codes), R5 (output
location fixed); `cross-context/interactions.md` X1–X6, X9–X11, X14
(all collapsed into C1 interactions); `failure-modes.md` FM-T1–T5,
FM-M1–M5; `features/cdo-operations.feature`, `features/nco-operations.feature`,
`features/cesm-submission.feature`, `features/grid-conversion.feature`,
`features/zarr-io.feature`, `features/opengrads-evaluation.feature`.

---

### 7. `agent-interaction` — C7 Agent Interaction (incl. Experiment, Workflow)

**Owned entities:** Session, User, Workflow, WorkflowStep, WorkflowState,
Experiment, Action.

**Ubiquitous language:** Agent, Session, User, Workflow, Workflow Step,
Workflow State, Experiment, Action.

**Dependencies:**
- `tool-invocation` (X10, X11) — translates User intent into
  ToolInvocations (including CESM Cases). Validates requested Tools and
  parameters against the catalog before creating ToolInvocations (R12:
  refuse and ask if hallucinated).
- `data-management` (X12) — queries, references, and registers
  Datasets on behalf of the User.
- `provenance` (X13) — queries ProvenanceRecords on behalf of the User
  (cross-session provenance queries, INV-P4).
- `scheduling` (X8) — on Session start, proactively queries the
  Scheduler for Jobs belonging to the User and reports their states
  (R7). This is the default behavior, not on-demand.
- `dsh-adapter` — for `ctx.tools` (registering Actions as
  model-facing capabilities), `ctx.commands` (human-command dispatch).

**Public surface:**
- `startSession(user: User): Promise<Session>`
  — starts a new Session. On start, proactively queries `scheduling.
  queryJobsByUser()` and reports Job states to the User (R7).
- `endSession(sessionId: SessionId): Promise<void>`
  — ends the Session. Running Jobs are NOT cancelled (INV-W4). The
  Session's Workflow state is persisted (R6).
- `getSession(sessionId: SessionId): Promise<Session | null>`
  — retrieves a Session by identity.
- `reportJobStatus(sessionId: SessionId): Promise<JobStatusReport[]>`
  — reports current Job states (used both proactively on Session start
  and on-demand).
- `createWorkflow(input: CreateWorkflowInput): Promise<Workflow>`
  — creates a new Workflow belonging to an Experiment (R2). The
  Workflow has persisted state (R6, ADR-006).
- `addWorkflowStep(workflowId: WorkflowId, step: WorkflowStepInput): Promise<void>`
  — adds a step to a Workflow.
- `startWorkflow(workflowId: WorkflowId): Promise<void>`
  — starts the Workflow. Each step's inputs are verified to exist with
  Provenance before starting (INV-W1).
- `resumeWorkflow(workflowId: WorkflowId): Promise<void>`
  — resumes a Workflow from its persisted state (R6). The Workflow
  may have been interrupted by Session end while waiting for a Job.
- `getWorkflowState(workflowId: WorkflowId): Promise<WorkflowState>`
  — returns the current WorkflowState.
- `createExperiment(input: CreateExperimentInput): Promise<Experiment>`
  — creates a new Experiment (R2). An Experiment groups Workflows and
  CESM Cases by a research question.
- `addWorkflowToExperiment(experimentId: ExperimentId, workflowId: WorkflowId): Promise<void>`
  — adds a Workflow to an Experiment.
- `addCaseToExperiment(experimentId: ExperimentId, caseId: CaseId): Promise<void>`
  — adds a Case to an Experiment.
- `queryExperiments(filter?: ExperimentFilter): Promise<Experiment[]>`
  — queries Experiments for the User.
- `registerAction(action: Action): Promise<void>`
  — registers an Action (LLM-facing concept, R3). Actions are exposed
  to the LLM via `ctx.tools`.
- `validateAction(request: ActionRequest): ActionResult`
  — validates an Action request against the Tool catalog and input
  Dataset metadata. If the Tool name or parameters are not in the
  catalog, the Agent refuses and asks the User for clarification
  (R12, ADR-010).

**dsh extension point:** `ctx.tools` (via `dsh-adapter.ToolRegistry` for
registering Actions as model-facing capabilities), `ctx.commands` (via
`dsh-adapter.CommandRegistry` for human-command dispatch). `ctx.agentTeams`
(experimental, for complex multi-step Workflows) and `ctx.webhookRuntime`
(for SLURM completion notifications) are potential future extension
points, not in the initial design.

**Key design decisions:**
- Experiment is a first-class entity above Workflow (R2, ADR-002). A
  Workflow belongs to exactly one Experiment. A Case belongs to
  exactly one Experiment.
- Workflow has persisted state that survives Session end (R6,
  ADR-006). A User can resume a Workflow across Sessions ("continue
  the analysis I started yesterday").
- Proactive Job reporting on Session start (R7, ADR-007). When a new
  Session begins, the Agent queries the Scheduler for all Jobs
  belonging to the User and reports their states. This is the default
  behavior, not on-demand.
- Action replaces "Operator (Agent)" (R3). An Action is a domain-level
  operation exposed to the LLM (e.g., "select variable", "compute time
  mean", "remap grid"). An Action may map to one or more CLI operators
  or Python calls.
- LLM hallucination policy: refuse and ask (R12, ADR-010). If the LLM
  generates a Tool name or parameters not in the catalog, the Agent
  refuses and asks the User for clarification. No best-effort attempts.
- Failure halts downstream (INV-W2): if a WorkflowStep fails,
  dependent downstream steps do not start automatically. The User is
  notified.
- Session can outlive Jobs (INV-W4): end-of-Session does not cancel
  running Jobs. Jobs are discoverable in later Sessions by JobID.

**Spec references:** `domain-model.md` C7; `invariants.md` INV-W1–W4;
`resolutions.md` R2 (Experiment first-class), R3 (Action replaces
Operator), R6 (Workflow persists), R7 (proactive Job reporting), R12
(refuse and ask); `cross-context/interactions.md` X8, X10–X13;
`failure-modes.md` FM-A1–A4; `features/workflow-execution.feature`,
`features/cesm-submission.feature` (cross-session recovery scenarios).

---

## Cross-Context Interactions (Updated for R1)

After R1 (C2 collapsed into C1), the interaction set is:

| ID | Contexts (after R1) | Summary | Subsumes |
|----|---------------------|---------|----------|
| X1 | C1↔C5 | Tool requires Environment; load+verify (incl. binary availability) before invocation | X9 (CESM env requirements), X14 (binary availability check) |
| X2 | C1↔C4 | Parallel tool delegates to Scheduling; CESM case.submit creates a Job | X5 (C2↔C4 → C1↔C4) |
| X3 | C1↔C3 | Tools consume and produce Datasets; CESM output tree becomes Datasets | X6 (C2↔C3 → C1↔C3) |
| X4 | C1↔C6 | Every ToolInvocation produces a ProvenanceRecord | — |
| X7 | C3↔C6 | Dataset not consumable until ProvenanceRecord exists | — |
| X8 | C4↔C7 | Session outlives Jobs; proactive Job reporting on Session start | — |
| X10 | C7↔C1 | Agent translates User intent into ToolInvocations (incl. CESM Cases) | X11 (C7↔C2 → C7↔C1) |
| X12 | C7↔C3 | Agent queries, references, and registers Datasets | — |
| X13 | C6↔C7 | Agent queries ProvenanceRecords on behalf of User | — |

**X5, X6, X9, X11, X14 are subsumed** into the remaining interactions.
The original cross-context interactions document (`cross-context/
interactions.md`) still references C2. See escalation
`002-cross-context-interactions-need-c2-collapse-update.md`.

---

## Feature-to-Module Mapping

Every Gherkin feature maps to exactly one primary module (cross-module
interactions noted):

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

---

## Naming Conformance

- **Action** (not "Operator") used for LLM-facing operations (R3).
- **Experiment** used for the first-class entity above Workflow (R2).
- **Case** (not "Model Run") used for the CESM aggregate, now in C1.
- **uenv** (not "Lmod" or "Module") used for environment loading
  (R9). The `Module` value object is retained as a uenv component
  descriptor, not a Lmod module.
- **SLURM** used directly, no `Scheduler` abstraction in domain types
  (R8).
- **ToolInvocation** (not "Operation" or "Command") for the
  C1 aggregate root.
