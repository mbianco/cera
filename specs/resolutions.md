# Domain Expert Resolutions — cera

> Recorded 2026-09-14. These resolutions supersede any conflicting
> content in the original spec artifacts. The architect must read this
> file FIRST, then the updated spec artifacts.

---

## R1: CESM is a complex Tool, not a peer entity
**Resolution:** CESM is a Tool in C1 (Tool Invocation), not a peer
entity in its own bounded context. C2 (Model Execution) **collapses
into C1**.
**Impact:**
- The Case aggregate moves to C1. The Case lifecycle
  (create → configure → build → submit → monitor → post-process)
  is a ToolInvocation lifecycle variant, not a separate context.
- INV-M1 through INV-M4 remain valid but are renumbered as
  C1 invariants (INV-T6 through INV-T9).
- Cross-context interactions X5 (C2↔C4), X6 (C2↔C3), X9 (C5↔C2)
  become intra-context or C1↔C4, C1↔C3, C5↔C1.
- The Tool subtypes are: CLI Tool (CDO, NCO), Python Tool
  (healpy, ICON tools, zarr), and **Model Tool** (CESM) — a Tool
  with a multi-step lifecycle and parallel execution.

## R2: Experiment is a first-class entity
**Resolution:** Experiment is a [CORE] entity above Workflow. An
Experiment spans one or more Workflows and CESM Cases, tied together
by a research question.
**Impact:**
- New aggregate: **Experiment** (root: Experiment) in C7
  (Agent Interaction). Fields: name, research question, referenced
  Workflows, referenced Cases, creation timestamp.
- Invariant: a Workflow belongs to exactly one Experiment. A Case
  belongs to exactly one Experiment.
- The ubiquitous-language entry "Experiment" changes from
  [CANDIDATE] to [CORE].

## R3: "Action" replaces "Operator (Agent)"
**Resolution:** The agent-level concept is **Action** — a domain-level
operation exposed to the LLM (e.g., "select variable", "compute time
mean", "remap grid"). An Action may map to one or more CLI operators
or Python calls.
**Impact:**
- Ubiquitous-language entry "Operator (Agent) [CANDIDATE]" is
  replaced by **Action [CORE]**.
- "Operator" without qualification refers to legacy CDO/NCO operators
  only.

## R4: Strict exit codes
**Resolution:** Any non-zero exit code blocks output registration
(INV-T3). The Agent does not treat non-zero exit codes as non-errors
unless the User explicitly asks for permissive behavior for a specific
Tool.
**Impact:**
- INV-T3 is confirmed as strict by default. The "documented in
  advance" clause becomes: non-zero exit codes are errors unless the
  User explicitly overrides for a specific ToolInvocation.
- FM-T3 (non-zero exit code for warnings) is downgraded: the default
  is failure. Permissive mode is an opt-in per invocation.
- U3 in assumptions.md moves from UNKNOWN to VALIDATED (strict
  default). The broader question (do other Tools use non-zero for
  success?) remains UNKNOWN but does not block — strict applies to
  all Tools by default.

## R5: CESM output location is always the same
**Resolution:** CESM's `case.submit` fixes the output location. It
does not vary based on runtime configuration.
**Impact:**
- INV-M4 (now INV-T9) is confirmed: the output tree location is
  determined at Case creation time and does not change.
- The Agent records the output location at Case creation, not at
  submission. INV-M4 is satisfied trivially.
- U4 in assumptions.md moves from UNKNOWN to VALIDATED.

## R6: Workflow is first-class with persisted state
**Resolution:** Workflow is a first-class entity with persisted state
(survives Session end). A User can resume a Workflow across Sessions
("continue the analysis I started yesterday").
**Impact:**
- WorkflowState (NOT_STARTED, IN_PROGRESS, BLOCKED, COMPLETE,
  FAILED) is confirmed as a real state, not CANDIDATE.
- U5 in assumptions.md moves from UNKNOWN to VALIDATED.
- The architect must design Workflow persistence.

## R7: Agent resumes awareness of Jobs from previous Sessions
**Resolution:** Yes. A new Session proactively reports on the status
of Jobs submitted in previous Sessions.
**Impact:**
- INV-W4 is confirmed. The mechanism (how Job awareness is persisted
  and discovered) is the architect's responsibility.
- U7 in assumptions.md moves from UNKNOWN to VALIDATED.
- The C4↔C7 interaction (X8) is updated: on Session start, the Agent
  proactively queries C4 for Jobs belonging to the User and reports
  their states. This is not on-demand — it is the default behavior.

## R8: SLURM is the only scheduler — defer abstraction
**Resolution:** SLURM is the choice. No other schedulers are in scope.
The multi-infrastructure abstraction can be deferred.
**Impact:**
- U2 in assumptions.md moves from UNKNOWN to ACCEPTED (deferred).
  The domain model treats the Scheduler as SLURM directly, not as
  an abstraction with multiple backends.
- The architect may still design a clean Scheduler interface for
  testability, but the domain specs do not require multi-scheduler
  abstraction.

## R9: Alps uses uenv (user environments), not Lmod
**Resolution:** Alps uses "user environments" (uenv) — squashfs mounts
in a prescribed place with the required dependencies. This is NOT Lmod.
**Impact:**
- A4 in assumptions.md is updated. The module system on Alps is uenv,
  not Lmod. `module load`, `module avail`, `module spider` are NOT
  the right commands.
- The Environment entity (C5) is reworked: an Environment is a uenv
  mount (squashfs at a prescribed path), not a set of Lmod Modules.
- The Compiler Stack concept may still apply (uenv can contain a
  compiler), but the loading mechanism is mount-based, not
  module-load-based.
- The architect must understand uenv's mount lifecycle, conflict
  detection (can two uenvs be mounted simultaneously?), and how
  the Agent loads a uenv before invoking a Tool.
- INV-E1, INV-E2, INV-E3 must be re-evaluated for uenv semantics:
  - INV-E1: can multiple uenvs be active simultaneously? (squashfs
    mounts are typically stackable, unlike module loads)
  - INV-E2: conflict detection changes — uenv conflicts are at the
    filesystem path level, not soname level
  - INV-E3: availability check changes from `module avail` to uenv
    registry/mount check

## R10: opengrads is not mandatory
**Resolution:** opengrads has not been built on HPC before. It is not
a mandatory Tool. The go/no-go evaluation can proceed but opengrads
is not on the critical path.
**Impact:**
- U1 in assumptions.md remains UNKNOWN but is downgraded from
  [CRITICAL] to [MEDIUM] (not mandatory).
- The architect should not design opengrads as a first-class
  concern. If opengrads is later approved, it is added as a Tool
  plugin like any other.
- The opengrads evaluation feature and assumptions section remain
  for reference but are not blocking.

## R11: Corrupted ProvenanceRecord is local
**Resolution:** A corrupted ProvenanceRecord is a local issue —
quarantine the affected Dataset, not the entire Provenance store.
**Recovery class:** degradable (partial service — other Datasets
remain available).
**Impact:**
- FM-P2 is updated: blast radius is single Dataset, not systemic.
  The Agent quarantines the affected Dataset and continues. Other
  Datasets with valid ProvenanceRecords remain available.
- The open question in assumptions.md (Layer 5, question 2) is
  resolved.

## R12: LLM hallucination — refuse and ask
**Resolution:** When the LLM hallucinates a Tool name or parameters,
the Agent refuses and asks the User for clarification. No best-effort
attempts.
**Impact:**
- FM-A1 and FM-A2 are confirmed: recovery class is "refuse and ask."
- The C7↔C1 contract (X10) is confirmed: if a requested Tool or
  parameter is not in the catalog, the Agent asks the User rather
  than guessing.
- The open question in assumptions.md (Layer 5, question 3) is
  resolved.

## R13: SLURM unavailability — UNKNOWN acceptable
**Resolution:** UNKNOWN state is acceptable for 30 minutes during a
weeks-long CESM run. The Agent does not need a heartbeat mechanism
beyond SLURM's own reporting.
**Impact:**
- The open question in assumptions.md (Layer 5, question 1) is
  resolved. FM-S2's "degradable" classification is confirmed.
  The Agent retries squeue/sacct with backoff (e.g., every 30
  seconds initially, backing off to every 5 minutes) and reconciles
  via sacct when SLURM recovers.

---

## Summary of spec status changes

| Original ID | Was | Now | Reason |
|---|---|---|---|
| U1 (opengrads) | UNKNOWN [CRITICAL] | UNKNOWN [MEDIUM] | Not mandatory (R10) |
| U2 (multi-scheduler) | UNKNOWN [CRITICAL] | ACCEPTED (deferred) | SLURM only (R8) |
| U3 (CDO exit codes) | UNKNOWN [HIGH] | VALIDATED (strict default) | R4 |
| U4 (CESM output location) | UNKNOWN [HIGH] | VALIDATED | R5 |
| U5 (Workflow first-class) | UNKNOWN [HIGH] | VALIDATED | R6 |
| U6 (Experiment needed) | UNKNOWN [MEDIUM] | VALIDATED (yes) | R2 |
| U7 (resume Jobs) | UNKNOWN [HIGH] | VALIDATED (yes, proactive) | R7 |
| U8 (Operator term) | UNKNOWN [MEDIUM] | VALIDATED ("Action") | R3 |
| U9 (CESM peer vs Tool) | UNKNOWN [MEDIUM] | VALIDATED (complex Tool) | R1 |
| A4 (module system) | ACCEPTED (Lmod) | ACCEPTED (uenv) | R9 — significant |
| L5-Q1 (SLURM unavailability) | UNKNOWN | VALIDATED (30 min OK) | R13 |
| L5-Q2 (corrupted Provenance) | UNKNOWN | VALIDATED (local) | R11 |
| L5-Q3 (LLM hallucination) | UNKNOWN | VALIDATED (refuse and ask) | R12 |
