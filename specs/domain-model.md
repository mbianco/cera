# Domain Model — cera

> Domain-level model. Describes entities, their attributes, aggregates
> (consistency boundaries), and bounded contexts. Does **not** prescribe
> module boundaries, interfaces, or code structure — that is the
> architect's responsibility.
>
> Entity attributes are described at the domain level (what they are
> and what they mean), not as implementation fields.

---

## Bounded Contexts

Seven bounded contexts. Each has its own ubiquitous language subset
and its own consistency rules. Cross-context contracts are documented
in `cross-context/interactions.md`.

### C1 — Tool Invocation
**Concern:** Executing legacy CLI and Python tools (CDO, NCO, healpix,
ICON tools, opengrads if feasible) to transform Datasets. Synchronous
execution is the default; parallel execution delegates to Scheduling.

**Owned entities:** Tool, CLI Tool, Python Tool, Operator invocation,
Exit outcome (exit code vs. signal).

**Key language:** Operator (CDO), Operator (NCO), CLI Tool,
Python Tool, Exit Code, Signal.

**Consistency boundary:** A single Tool invocation. Once started, it
either completes (exit code) or is terminated (signal) — no partial
output is treated as authoritative.

### C2 — Model Execution (COLLAPSED into C1 per R1, ADR-001)
**Concern:** ~~Running CESM.~~ CESM is a Model Tool in C1. The Case
aggregate (create → configure → build → submit → monitor →
post-process) lives in C1 as a specialized ToolInvocation lifecycle.
This context is retained for historical reference only — all
entities, invariants, and interactions have been moved to C1.

**Do not add new content here. Use C1.**

### C3 — Data Management
**Concern:** Datasets as artifacts — their format, grid, variables,
and location on the filesystem. Tracking what exists, where it lives,
and what format/grid it is in. Does not own transformation (that is
Tool Invocation's job) but owns the descriptions tools rely on.

**Owned entities:** Dataset, Format, Grid, Variable, Location.

**Key language:** Dataset, Format, Grid, Variable, NetCDF, ZARR,
GRIB2, lat-lon, ICON, healpix.

**Consistency boundary:** A single Dataset's metadata. A Dataset's
Format and Grid cannot change without producing a new Dataset
(immutability rule — see invariants).

### C4 — Scheduling
**Concern:** Submitting Jobs to the Scheduler (SLURM on Alps),
querying their State, and cancelling them. Abstracted over multiple
scheduler backends in principle; SLURM is the only one in scope
today.

**Owned entities:** Job, Job ID, Resource Request, Partition, QoS,
Job State.

**Key language:** Job, Scheduler, Partition, QoS, Resource Request,
State (Job), SLURM.

**Consistency boundary:** A single Job. State transitions are
authoritative only as reported by the Scheduler; the Agent does not
infer completion from file existence alone.

### C5 — Environment Management
**Concern:** The software stack — loaded Modules, compiler, MPI
runtime, library versions — required to make a specific Tool
executable. Resolving conflicts between incompatible stacks.

**Owned entities:** Environment, Module, Compiler Stack.

**Key language:** Environment, Module, Compiler Stack, MPI.

**Consistency boundary:** A single Environment at a time per
execution context. Two Environments with conflicting compiler stacks
cannot be simultaneously loaded — there is one `PATH` and one set of
library links.

### C6 — Provenance
**Concern:** Recording what was run, with what parameters, in what
Environment, on what inputs, producing what outputs. Enabling
re-execution and scientific audit.

**Owned entities:** Provenance record (one per Dataset produced and
one per Job outcome).

**Key language:** Provenance, Reproducibility.

**Consistency boundary:** A single Provenance record. Must be written
before its Dataset is consumed downstream (see invariants).

### C7 — Agent Interaction
**Concern:** The LLM-facing surface — translating a User's scientific
intent into a Workflow, maintaining Session state, and presenting
results.

**Owned entities:** Session, User, Workflow (the expression of
intent), Workflow State (CANDIDATE).

**Key language:** Agent, Session, User, Workflow.

**Consistency boundary:** A single Session. Workflow state within a
Session is consistent; cross-Session coordination is out of scope
unless the domain expert requires it.

---

## Entities and Aggregates

### Aggregate: Tool Invocation (root: ToolInvocation)
- **ToolInvocation** (aggregate root) — one execution of a Tool
  with specific parameters on specific input Datasets, producing
  output Datasets. References a Tool, an Environment, and input
  Datasets by identity.
- **ExitOutcome** — either an Exit Code (integer) or a Signal
  (name + number). Mutually exclusive.
- **Tool** (referenced, not owned) — the capability being invoked.
- **Environment** (referenced, not owned) — the stack under which
  the Tool runs.

**Invariants (aggregate-scoped):**
- A ToolInvocation cannot start until its Tool's Environment is loaded.
- A ToolInvocation has exactly one ExitOutcome once it terminates.
- Output Datasets are not registered as valid until ExitOutcome
  indicates success.

### Aggregate: Case (root: Case)
- **Case** (aggregate root) — one CESM experiment configuration.
  Has a name, Compset, resolution, machine target, and run length.
- **CaseState** — one of: CREATED, CONFIGURED, BUILT, SUBMITTED,
  RUNNING, COMPLETED, FAILED, CANCELLED. (CANDIDATE — exact names
  pending domain-expert confirmation of whether to mirror CESM's
  own state machine or define an agent-level one.)
- **Job** (referenced) — the SLURM Job created by `case.submit`.

**Invariants:**
- Cannot submit a Case that is not in BUILT state.
- A Case has at most one running Job at a time.
- Re-submission (resubmit) requires the previous Job to have reached
  a terminal state.

### Aggregate: Dataset (root: Dataset)
- **Dataset** (aggregate root) — a scientific data artifact.
  Has exactly one Format, exactly one Grid, one or more Variables,
  and one Location (filesystem path or ZARR URI).
- **Format** — value object: NetCDF | ZARR | GRIB2.
- **Grid** — value object: lat-lon | ICON | healpix | GRIB2-native
  (and possibly others).
- **Variable** — value object: name, units, dimensions.
- **Location** — value object: path or URI plus the filesystem/
  store it resides on.

**Invariants:**
- A Dataset is immutable: transformation produces a new Dataset with
  its own identity and Provenance, never modifies the original.
- A Dataset's Format and Grid cannot change after creation. (A
  "format conversion" or "grid conversion" produces a new Dataset.)
- A Dataset is not consumable until its Provenance record exists.

### Aggregate: Job (root: Job)
- **Job** (aggregate root) — a unit of submitted work.
- **JobID** — value object: scheduler-assigned identifier.
- **ResourceRequest** — value object: nodes, cores-per-node,
  memory, wall time, Partition, QoS.
- **JobState** — value object: PENDING | RUNNING | COMPLETED |
  FAILED | TIMEOUT | CANCELLED | OUT_OF_MEMORY | NODE_FAIL
  (and possibly other SLURM states).

**Invariants:**
- State transitions are authoritative only as reported by the
  Scheduler. The Agent does not promote a Job to COMPLETED based
  on output-file existence.
- A Job's ResourceRequest is immutable after submission.
- A Job has exactly one terminal state in its final record.

### Aggregate: Environment (root: Environment)
- **Environment** (aggregate root) — a loaded software stack.
  Has a set of Modules, a Compiler Stack, and (if applicable) an
  MPI runtime.
- **Module** — value object: name, version, prefix.

**Invariants:**
- At most one Environment is active per execution context at a time.
- Two Modules that provide conflicting libraries (same soname,
  different version) cannot coexist in one Environment. Conflicts
  must be detected before the Tool runs, not at runtime.

### Aggregate: Workflow (root: Workflow)
- **Workflow** (aggregate root) — an ordered sequence of
  ToolInvocations and/or Case submissions, with data dependencies.
- **WorkflowStep** — one Tool invocation or Case submission, with
  explicit input Datasets (referenced) and output Datasets
  (produced).
- **WorkflowState** (CANDIDATE) — NOT_STARTED | IN_PROGRESS |
  BLOCKED | COMPLETE | FAILED.

**Invariants:**
- A WorkflowStep may not start until all its input Datasets exist
  and have Provenance.
- A WorkflowStep's input Datasets are immutable for the duration of
  the step (the step takes a reference, not a mutable handle).
- If a WorkflowStep fails, downstream steps that depend on its
  outputs do not start automatically; the User must be notified.

### Aggregate: Provenance Record (root: ProvenanceRecord)
- **ProvenanceRecord** (aggregate root) — immutable record of one
  Dataset's origin or one Job's execution.
- Fields: Tool identity (name + version), exact parameters,
  Environment identity (modules + versions), input Dataset
  identities, output Dataset identity, timestamp, exit outcome.

**Invariants:**
- A ProvenanceRecord is immutable once written.
- A ProvenanceRecord must exist before its output Dataset is
  consumed by any downstream WorkflowStep.

### Aggregate: Session (root: Session)
- **Session** (aggregate root) — one User's interaction context.
  References the current Workflow (if any), loaded Environments,
  and referenced Datasets.
- **User** — value object: identity, HPC account, SLURM username.

**Invariants:**
- A Session's state is local to that Session; cross-Session
  coordination is out of scope (CANDIDATE — needs confirmation).
- A Session may end before its Jobs complete; the system must
  preserve a path to resume awareness of those Jobs.

---

## Entity Reference Summary

| Entity | Aggregate root | Bounded context |
|---|---|---|
| ToolInvocation | ToolInvocation | C1 |
| Tool | (referenced by C1) | C1 (description), C5 (requires) |
| ExitOutcome | ToolInvocation | C1 |
| Case | Case | C2 |
| Compset | Case | C2 |
| Dataset | Dataset | C3 |
| Format | Dataset | C3 |
| Grid | Dataset | C3 |
| Variable | Dataset | C3 |
| Location | Dataset | C3 |
| Job | Job | C4 |
| JobID | Job | C4 |
| ResourceRequest | Job | C4 |
| JobState | Job | C4 |
| Partition | Job | C4 |
| QoS | Job | C4 |
| Environment | Environment | C5 |
| Module | Environment | C5 |
| Compiler Stack | Environment | C5 |
| ProvenanceRecord | ProvenanceRecord | C6 |
| Workflow | Workflow | C7 |
| WorkflowStep | Workflow | C7 |
| WorkflowState | Workflow | C7 |
| Session | Session | C7 |
| User | Session | C7 |

---

## Open Modeling Questions (ALL RESOLVED)

All questions from the initial analyst pass have been resolved by
the domain expert. See `resolutions.md` for details.

1. **Is Workflow a first-class entity with persisted state?**
   RESOLVED: Yes (R6, ADR-006).
2. **Is CESM a Tool or a peer entity?** RESOLVED: Complex Tool in
   C1 (R1, ADR-001).
3. **Does the agent need to model an "Experiment" above Workflow?**
   RESOLVED: Yes (R2, ADR-002).
4. **Does a Session need to resume awareness of Jobs started in a
   previous Session?** RESOLVED: Yes, proactively (R7, ADR-007).
5. **Is the "Operator" term too overloaded?** RESOLVED: Use "Action"
   for the agent-level concept (R3).
