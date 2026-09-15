# Invariants — cera

> Every invariant below is expressible as a testable assertion.
> Each is tagged with the bounded context that owns it, the
> aggregate it constrains, and a severity: **CRITICAL** (violation
> corrupts data or scientific validity), **HIGH** (violation breaks
> a workflow or blocks progress), **MEDIUM** (violation degrades
> but does not halt).
>
> Tag legend: **[INFERRED]** — derived from the domain expert's
> stated requirements; needs explicit confirmation. **[EXPLICIT]**
> — directly stated or trivially implied.

---

## C1 — Tool Invocation

### INV-T1: Environment loaded before invocation
**Severity:** CRITICAL
**Aggregate:** ToolInvocation
**Tag:** [EXPLICIT]

A ToolInvocation may not begin executing until the Tool's required
Environment (all Modules, Compiler Stack, MPI runtime) is loaded and
verified conflict-free.

> **Assertion:** For any ToolInvocation `t` that has entered the
> RUNNING phase, there exists a verified Environment `e` such that
> `e` satisfies `t.tool.environmentRequirements` and `e` was
> confirmed active immediately prior to `t`'s start.

### INV-T2: Single exit outcome per invocation
**Severity:** HIGH
**Aggregate:** ToolInvocation
**Tag:** [INFERRED]

A ToolInvocation that has terminated has exactly one ExitOutcome:
either an integer Exit Code (including 0) or a Signal, never both,
never neither.

> **Assertion:** Once `t.state ∈ {COMPLETED, FAILED}`, exactly one
> of `t.exitCode` or `t.signal` is non-null.

### INV-T3: Output registration gated on success
**Severity:** CRITICAL
**Aggregate:** ToolInvocation
**Tag:** [INFERRED]

A Dataset produced by a ToolInvocation is not registered as
available for downstream consumption unless the ToolInvocation's
ExitOutcome indicates success (Exit Code 0, or a Tool-specific
non-error code documented in advance).

> **Assertion:** For any Dataset `d` registered in C3 with
> `d.producer = t`, `t.exitOutcome` indicates success.
>
> **Open question:** Do any tools in scope use non-zero exit codes
> for success? (CDO reportedly returns 1 for some warnings.)
> The "documented in advance" clause needs a per-Tool success
> definition. Flagged in assumptions.md.

### INV-T4: Input immutability during invocation
**Severity:** CRITICAL
**Aggregate:** ToolInvocation
**Tag:** [INFERRED]

A ToolInvocation's input Datasets must not be modified (by another
process, user, or workflow) for the duration of the invocation. The
Agent does not own the HPC filesystem's concurrency guarantees, but
it must not invite mutation by handing out write handles to inputs.

> **Assertion:** The Agent never opens an input Dataset for writing,
> and never recommends that the User or another Tool modify an
> input Dataset while a consuming ToolInvocation is RUNNING.

### INV-T5: Signal vs. exit-code distinction preserved
**Severity:** HIGH
**Aggregate:** ToolInvocation
**Tag:** [EXPLICIT]

A process terminated by a Signal (SIGSEGV, SIGKILL, SIGTERM) is
reported as a Signal, not as an Exit Code. The Agent must not map
signal death to a synthetic exit code.

> **Assertion:** If the OS reports a signal, the ExitOutcome carries
> the signal name and number; `exitCode` is null.

### INV-T6: Submit requires built Case (formerly INV-M1)
**Severity:** CRITICAL
**Aggregate:** Case (C1 — CESM is a Model Tool, R1/ADR-001)
**Tag:** [INFERRED → VALIDATED]

A Case may not be submitted (via `case.submit` or equivalent) unless
it is in BUILT state. Submitting an unbuilt Case is a defect, not a
retry-able error.

> **Assertion:** `submit(c)` is rejected if `c.state ≠ BUILT`.

### INV-T7: One running Job per Case (formerly INV-M2)
**Severity:** HIGH
**Aggregate:** Case (C1)
**Tag:** [INFERRED → VALIDATED]

A Case has at most one RUNNING Job at any time. Resubmission
requires the prior Job to have reached a terminal state
(COMPLETED, FAILED, TIMEOUT, CANCELLED).

> **Assertion:** At any time, the number of Jobs with
> `job.caseId = c.id ∧ job.state = RUNNING` is ≤ 1.

### INV-T8: Run length bounded by Wall Time (formerly INV-M3)
**Severity:** CRITICAL
**Aggregate:** Case (C1)
**Tag:** [EXPLICIT]

A CESM run's requested run length must not exceed the Job's Wall
Time. If it does, the model will be killed mid-run by the Scheduler.

> **Assertion:** `c.runLength ≤ c.job.resourceRequest.wallTime`.
> Violation is a configuration defect caught at submission, not at
> runtime.

### INV-T9: Output tree location is known before submission (formerly INV-M4)
**Severity:** HIGH
**Aggregate:** Case (C1)
**Tag:** [INFERRED → VALIDATED (R5)]

The filesystem location where a CESM run will write its output tree
is determined at Case creation time and does not change (R5). The
Agent records it at creation, not after the fact.

> **Assertion:** `createCase(input)` sets `c.outputTreeLocation`
> based on CESM's fixed output path. `submit(c)` requires
> `c.outputTreeLocation` to be non-null and writable.

---

## C3 — Data Management

### INV-D1: Dataset immutability
**Severity:** CRITICAL
**Aggregate:** Dataset
**Tag:** [EXPLICIT]

A Dataset, once created, is not modified in place. Transformation
(format conversion, grid conversion, aggregation, selection) produces
a new Dataset with its own identity. The original Dataset's bytes
are not altered.

> **Assertion:** No operation registered in C6 (Provenance) modifies
> a Dataset that was created by a prior operation.
>
> **Caveat:** The Agent cannot enforce this at the OS level if a
> user manually edits a file. The invariant bounds the Agent's own
> behavior; flagging the gap in failure-modes.md under "external
> mutation."

### INV-D2: One Format, one Grid per Dataset
**Severity:** HIGH
**Aggregate:** Dataset
**Tag:** [INFERRED]

A Dataset has exactly one Format and exactly one Grid at all times.
A change of Format or Grid is, by definition, the creation of a new
Dataset.

> **Assertion:** `d.format` and `d.grid` are non-null and immutable
> for the lifetime of `d`.

### INV-D3: Provenance before consumption
**Severity:** CRITICAL
**Aggregate:** Dataset
**Tag:** [EXPLICIT]

A Dataset may not be consumed as input by any ToolInvocation or
WorkflowStep until a ProvenanceRecord for that Dataset exists in C6.

> **Assertion:** For any WorkflowStep `s` and any input Dataset `d`
> of `s`, a ProvenanceRecord for `d` exists at the time `s` starts.

### INV-D4: Location resolves to a real path before use
**Severity:** HIGH
**Aggregate:** Dataset
**Tag:** [EXPLICIT]

A Dataset's Location must resolve to an existing, readable path (for
inputs) or a writable path (for outputs) at the time the Dataset is
used. The Agent must not hand a Dataset to a Tool whose Location
does not resolve.

> **Assertion:** Immediately before a ToolInvocation reads or writes
> `d.location`, the path resolves per the required access mode.

---

## C4 — Scheduling

### INV-S1: Scheduler is authoritative for Job State
**Severity:** CRITICAL
**Aggregate:** Job
**Tag:** [INFERRED]

The Agent does not infer a Job's State from indirect evidence
(output files existing, process gone, elapsed time exceeded). State
transitions are taken from the Scheduler's reports (`squeue`,
`sacct`).

> **Assertion:** Every Job State transition in C4 corresponds to a
> Scheduler-reported state, not an inference.
>
> **Caveat:** If the Scheduler is unreachable, the Agent may mark a
> Job as UNKNOWN — that is itself a state. It must not silently
> promote to RUNNING or COMPLETED.

### INV-S2: Resource Request immutable after submission
**Severity:** HIGH
**Aggregate:** Job
**Tag:** [EXPLICIT]

A Job's ResourceRequest (nodes, cores, memory, wall time, Partition,
QoS) is immutable once the Job is submitted. Changing resources
requires cancelling and resubmitting.

> **Assertion:** After `submit(j)` returns a JobID, all subsequent
> observations of `j.resourceRequest` equal the value at submission.

### INV-S3: Unique JobID
**Severity:** HIGH
**Aggregate:** Job
**Tag:** [INFERRED]

Each Job has exactly one JobID, assigned by the Scheduler at
submission. The Agent does not generate JobIDs.

> **Assertion:** No two Jobs share a JobID; no Job has a null
> JobID after submission returns.

### INV-S4: Terminal state is final
**Severity:** HIGH
**Aggregate:** Job
**Tag:** [INFERRED]

A Job in a terminal State (COMPLETED, FAILED, TIMEOUT, CANCELLED,
OUT_OF_MEMORY, NODE_FAIL) does not transition to a non-terminal
State. The Agent must not treat reaped Jobs as still running.

> **Assertion:** If `j.state ∈ TERMINAL`, no subsequent observation
> places `j.state` outside TERMINAL.

---

## C5 — Environment Management

### INV-E1: One active Environment per execution context
**Severity:** CRITICAL
**Aggregate:** Environment
**Tag:** [INFERRED]

At most one Environment is active in a given execution context at a
time. Loading a new Environment replaces, not merges with, the prior
one (unless the module system explicitly supports stacking and the
result is verified conflict-free).

> **Assertion:** At any point in an execution context, the set of
> active Modules is a single consistent stack; no two Modules
> provide conflicting library sonames.

### INV-E2: Conflict detection before execution
**Severity:** CRITICAL
**Aggregate:** Environment
**Tag:** [INFERRED]

Environment conflicts (incompatible compiler versions, conflicting
MPI runtimes, conflicting library sonames) are detected before a
Tool runs, not at Tool runtime via a segfault or linker error.

> **Assertion:** If `load(e)` would produce a conflicting stack,
> the load is rejected before any Tool invocation begins under `e`.

### INV-E3: Module availability verified before load
**Severity:** HIGH
**Aggregate:** Environment
**Tag:** [EXPLICIT]

A Module's availability on the target system is verified before it
is loaded. The Agent must not attempt to load a Module that does not
exist on the host (this produces a noisy, low-signal error).

> **Assertion:** `load(m)` is preceded by a check that `m` exists
> in the module system's index.

---

## C6 — Provenance

### INV-P1: ProvenanceRecord immutability
**Severity:** CRITICAL
**Aggregate:** ProvenanceRecord
**Tag:** [EXPLICIT]

A ProvenanceRecord, once written, is not modified. Updates produce a
new record with a new identity, linked to the prior one.

> **Assertion:** No write operation in C6 modifies an existing
> ProvenanceRecord's fields.

### INV-P2: Provenance captures full reproducibility tuple
**Severity:** CRITICAL
**Aggregate:** ProvenanceRecord
**Tag:** [EXPLICIT]

Every ProvenanceRecord includes: Tool identity (name + version),
exact parameters, Environment identity (all Modules with versions),
input Dataset identities, output Dataset identity, timestamp, exit
outcome. A record missing any field is defective.

> **Assertion:** For any ProvenanceRecord `p`, all of
> {tool, params, environment, inputs, output, timestamp,
> exitOutcome} are non-null.

### INV-P3: Provenance exists before consumption (restated)
**Severity:** CRITICAL
**Aggregate:** ProvenanceRecord / Dataset
**Tag:** [EXPLICIT]

See INV-D3. Listed in both contexts because the invariant spans both
— it is jointly owned.

### INV-P4: Provenance survives Session end
**Severity:** HIGH
**Aggregate:** ProvenanceRecord
**Tag:** [INFERRED]

ProvenanceRecords persist beyond the Session that created them. A
scientist must be able to query provenance for Datasets produced in
prior Sessions.

> **Assertion:** A ProvenanceRecord written in Session `s1` is
> queryable in Session `s2 ≠ s1`.

---

## C7 — Agent Interaction / Workflow

### INV-W1: Step inputs exist before step starts
**Severity:** CRITICAL
**Aggregate:** Workflow
**Tag:** [EXPLICIT]

A WorkflowStep may not begin until all its declared input Datasets
exist and have Provenance.

> **Assertion:** At the moment `start(step)`, for each input Dataset
> `d` of `step`, `d` exists in C3 and a ProvenanceRecord for `d`
> exists in C6.

### INV-W2: Failure halts downstream
**Severity:** HIGH
**Aggregate:** Workflow
**Tag:** [INFERRED]

If a WorkflowStep fails (non-success ExitOutcome, or Job reaches a
non-COMPLETED terminal State), dependent downstream steps do not
start automatically. The User is notified.

> **Assertion:** For any WorkflowStep `s` with a failed predecessor
> `p` (where `s` consumes `p`'s output), `s.state ≠ RUNNING`
> without explicit User action.

### INV-W3: Workflow describes real dependencies
**Severity:** MEDIUM
**Aggregate:** Workflow
**Tag:** [INFERRED]

A WorkflowStep's declared input Datasets must actually be consumed
by the step's underlying Tool. Declared-but-unused inputs and
used-but-undeclared inputs are both defects (the former is noise,
the latter breaks Provenance).

> **Assertion:** The set of Datasets declared as inputs to `step`
> equals the set of Datasets the underlying Tool invocation reads.

### INV-W4: Session can outlive its Jobs' completion
**Severity:** HIGH
**Aggregate:** Session
**Tag:** [INFERRED]

A Session may end while Jobs it submitted are still RUNNING. The
Jobs are not cancelled. A later Session can become aware of those
Jobs by JobID.

> **Assertion:** End-of-Session does not cause any RUNNING Job to
> be cancelled. A Job submitted in `s1` is discoverable in `s2` by
> its JobID.

---

## Summary Table

| ID | Context | Severity | Tag | Short |
|----|---------|----------|-----|-------|
| INV-T1 | C1 | CRITICAL | EXPLICIT | Environment loaded before invocation |
| INV-T2 | C1 | HIGH | INFERRED | Single exit outcome |
| INV-T3 | C1 | CRITICAL | INFERRED | Output registration gated on success |
| INV-T4 | C1 | CRITICAL | INFERRED | Input immutability during invocation |
| INV-T5 | C1 | HIGH | EXPLICIT | Signal vs. exit-code preserved |
| INV-T6 | C1 | CRITICAL | VALIDATED | Submit requires built Case (fmr INV-M1) |
| INV-T7 | C1 | HIGH | VALIDATED | One running Job per Case (fmr INV-M2) |
| INV-T8 | C1 | CRITICAL | EXPLICIT | Run length bounded by Wall Time (fmr INV-M3) |
| INV-T9 | C1 | HIGH | VALIDATED | Output tree location known pre-submit (fmr INV-M4) |
| INV-D1 | C3 | CRITICAL | EXPLICIT | Dataset immutability |
| INV-D2 | C3 | HIGH | INFERRED | One Format, one Grid per Dataset |
| INV-D3 | C3 | CRITICAL | EXPLICIT | Provenance before consumption |
| INV-D4 | C3 | HIGH | EXPLICIT | Location resolves before use |
| INV-S1 | C4 | CRITICAL | INFERRED | Scheduler authoritative for State |
| INV-S2 | C4 | HIGH | EXPLICIT | Resource Request immutable |
| INV-S3 | C4 | HIGH | INFERRED | Unique JobID |
| INV-S4 | C4 | HIGH | INFERRED | Terminal state is final |
| INV-E1 | C5 | CRITICAL | INFERRED | One active Environment per context |
| INV-E2 | C5 | CRITICAL | INFERRED | Conflict detection before execution |
| INV-E3 | C5 | HIGH | EXPLICIT | Module availability verified |
| INV-P1 | C6 | CRITICAL | EXPLICIT | ProvenanceRecord immutable |
| INV-P2 | C6 | CRITICAL | EXPLICIT | Full reproducibility tuple |
| INV-P3 | C6 | CRITICAL | EXPLICIT | Provenance before consumption |
| INV-P4 | C6 | HIGH | INFERRED | Provenance survives Session end |
| INV-W1 | C7 | CRITICAL | EXPLICIT | Step inputs exist before start |
| INV-W2 | C7 | HIGH | INFERRED | Failure halts downstream |
| INV-W3 | C7 | MEDIUM | INFERRED | Workflow describes real dependencies |
| INV-W4 | C7 | HIGH | INFERRED | Session outlives Jobs |
