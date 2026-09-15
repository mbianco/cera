# Assumptions Log — cera

> Every assumption is classified as **VALIDATED** (confirmed by the
> domain expert or by existing specs), **ACCEPTED** (acknowledged
> risk, mitigation in place), or **UNKNOWN** (needs investigation).
> UNKNOWN entries are the highest priority for the next interrogation
> round.
>
> Tag legend: [CRITICAL] — architecture-invalidating if wrong.
> [HIGH] — affects multiple features. [MEDIUM] — affects a single
> feature or edge case.

---

## VALIDATED

These assumptions are confirmed by the existing specs (domain
model, invariants, ubiquitous language) and by the domain expert's
stated requirements.

### V1: Seven bounded contexts cover the domain
**Status:** VALIDATED
**Source:** `domain-model.md`, domain expert
The seven contexts (C1 Tool Invocation, C2 Model Execution, C3 Data
Management, C4 Scheduling, C5 Environment Management, C6 Provenance,
C7 Agent Interaction) cover all stated requirements. No context is
known to be missing.

### V2: Dataset immutability is a hard rule
**Status:** VALIDATED (INV-D1, [EXPLICIT])
A Dataset, once created, is not modified in place. Transformation
produces a new Dataset. This is confirmed in the invariants and is
load-bearing for Provenance and scientific integrity.

### V3: Provenance before consumption
**Status:** VALIDATED (INV-D3 / INV-P3, [EXPLICIT])
A Dataset may not be consumed until its ProvenanceRecord exists.
Confirmed in the invariants and featured in `provenance.feature`.

### V4: SLURM is the only Scheduler in scope today
**Status:** VALIDATED
SLURM is the Scheduler on Alps. Other schedulers (PBS, LSF, Cray)
may be supported later but are out of scope for the current
iteration.

### V5: Representative values for Alps environment
**Status:** VALIDATED (by domain expert, this session)
The following representative values are used in Gherkin scenarios
and cross-context interactions. They are plausible for the Alps
environment but should be replaced with exact values during
implementation:
- Module versions: `cdo/2.0.5`, `nco/5.1.6`, `gcc/11.2.0`,
  `openmpi/4.1.4`, `intel/2021.4`, `intel-mpi/2021.4`,
  `craype/2.7.10`, `python/3.11.6`, `zarr/2.18.3`,
  `healpy/1.16.6`, `eccodes/2.31.0`
- File paths: `/scratch/snx3000/cera_user/...` (scratch),
  `/store/cera_user/...` (tape-backed)
- SLURM partitions: `normal`, `priority`, `gpu`
- CESM compsets: `BHIST` (historical), `B1850` (pre-industrial)
- CESM resolutions: `f09_g17` (0.9×1.25 degree)
- Grids: `r180x90` (regular lat-lon), `R02B09` (ICON),
  `nside=1024` (healpix), `T1279` (GRIB2 spectral)
- Variables: `TAS` (near-surface air temperature, units K),
  `PR` (precipitation, units mm/day), `TS` (surface temperature),
  `PSL` (sea-level pressure)

---

## ACCEPTED (acknowledged risk)

### A1: dsh is in developer preview with breaking-change warnings
**Status:** ACCEPTED
**Severity:** [CRITICAL]
**Source:** `ubiquitous-language.md: dsh`

dsh (DeepSeek Harness) is in developer preview. Breaking changes
between versions are possible and expected. cera's plugin contracts
depend on dsh's extension points (`ctx.tools`, `ctx.shell`,
`ctx.subprocess`, `ctx.sandbox`, `ctx.fs`, `ctx.jobs`).

**Risk:** A dsh upgrade could break cera's plugin contracts, Tool
invocations, Environment management, or Job submission — any of
which would halt the system.

**Mitigation:**
- Pin the dsh version in `package.json` / lockfile. Do not auto-update.
- Introduce an isolation layer between dsh's plugin contracts and
  cera's domain interfaces. The architect defines this layer; the
  analyst's responsibility is to flag the risk and ensure that
  domain specs do not depend on dsh-specific implementation details.
- When upgrading dsh, run the full test suite (Tier 3) against real
  services before merging.
- Break the isolation layer's contract into the stable surface
  cera needs (invoke Tool, query Job, read/write Dataset, load
  Environment, write Provenance) vs. the volatile dsh surface.

### A2: Scientists run CESM for weeks — Session must outlive Jobs
**Status:** ACCEPTED (originally INFERRED, confirmed by domain
expert's stated requirements)
**Severity:** [HIGH]
**Source:** `domain-model.md: Session`, `invariants.md: INV-W4`

A CESM run may last days to weeks. A Session (one interaction
between User and Agent) may end long before the CESM Job completes.
The Jobs are not cancelled when the Session ends; a later Session
can discover those Jobs by JobID.

**Risk:** If the Session-bound mechanism is wrong, the Agent loses
track of long-running Jobs, potentially leading to duplicate
submissions, orphaned Jobs, or inability to recover results.

**Mitigation:**
- INV-W4 is confirmed. The mechanism (how Session state is
  persisted and how Jobs are discovered across Sessions) is the
  architect's responsibility.
- The Agent queries the Scheduler (squeue, sacct) for Job states —
  it does not rely on Session-local state.
- ProvenanceRecords survive Session end (INV-P4), so output
  Datasets from prior Sessions are discoverable.

### A3: Parallel filesystem data locality — Agent respects locality
**Status:** ACCEPTED (originally INFERRED)
**Severity:** [MEDIUM]
**Source:** Cross-context interaction X3/X6

The Agent should respect data locality rather than shuffling large
Datasets between filesystems. If an input Dataset is on a slow
filesystem (tape, cold Lustre), the Agent advises staging to a
faster filesystem before processing. Staging is itself a
ToolInvocation with its own ProvenanceRecord.

**Risk:** Ignoring data locality leads to slow Tool execution,
filesystem contention, and wasted HPC time.

**Mitigation:**
- The Agent validates Location accessibility (INV-D4) before use.
- The Agent does not implicitly copy Datasets — all movements are
  explicit ToolInvocations with Provenance.
- The Agent advises the User when data locality is suboptimal.

### A4: Module system is Lmod on Alps
**Status:** ACCEPTED (originally INFERRED)
**Severity:** [MEDIUM]
**Source:** `environment-management.feature`

The module system on Alps is Lmod (Lua-based module system). The
Agent uses `module load`, `module avail`, `module purge`, and
`module spider` to manage Environments.

**Risk:** If the module system is not Lmod (e.g., Environment
Modules / TCL-based, or Spack), the module commands and conflict
detection logic differ.

**Mitigation:**
- Lmod is compatible with Environment Modules (same `module`
  command syntax). The Agent's commands are portable.
- `module spider` is Lmod-specific. If a different module system is
  used, the availability check falls back to `module avail`.
- The domain model treats the module system as an abstraction;
  Lmod is the current implementation.

---

## UNKNOWN (needs investigation)

### U1: opengrads feasibility [CRITICAL]
**Status:** UNKNOWN
**Severity:** [CRITICAL]
**Source:** `ubiquitous-language.md: opengrads`,
`features/opengrads-evaluation.feature`

opengrads is an interactive desktop tool for accessing,
manipulating, and visualizing earth-science data. It has its own
scripting language and dynamically linked plugins. Hosted on
SourceForge using CVS. Feasibility for HPC use is UNKNOWN.

#### Dedicated Evaluation Section

**1. Buildability**

Can opengrads be built on a modern HPC system (Alps)?

- opengrads is hosted on SourceForge using CVS. Is the CVS
  repository accessible and current?
- What are the build dependencies? The `opengrads-evaluation.feature`
  Scenario Outline tests with `gcc/11.2.0` and `intel/2021.4`.
- Does the build require X11 headers and libraries (`libX11`,
  `libXext`)? These may not be available on compute nodes.
- Does the build require a specific version of `glibc`, `gcc`, or
  other system libraries that may not match Alps' software stack?
- Are dynamically linked plugins loadable after building, or do
  they require a specific `LD_LIBRARY_PATH` that conflicts with
  other Tools?

**Questions for the domain expert:**
- Have you successfully built opengrads on any HPC system before?
  If so, which compiler and which system?
- Is the CVS repository the canonical source, or are there tarball
  releases that are easier to build?
- Does opengrads have a `CMakeLists.txt`, `Makefile`, or
  `configure` script? How complex is the build?

**2. HPC suitability**

opengrads is an "interactive desktop tool." Compute nodes on Alps
have no graphical display and no outbound network.

- Can opengrads run on login nodes? Login nodes are shared and
  resource-limited — heavy visualization is prohibited.
- Can opengrads run on service nodes? Service nodes are less
  constrained but may still lack displays.
- Is running opengrads on a login/service node useful to scientists,
  or does the value require interactive use on a workstation?
- Can opengrads run in batch mode (`-b` flag) without a display?
  The `opengrads-evaluation.feature` Scenario Outline tests this.
- If a virtual framebuffer (`Xvfb`) is needed, is that acceptable
  on Alps? Who manages it?

**Questions for the domain expert:**
- Do scientists use opengrads interactively (clicking, dragging,
  zooming) or primarily for scripted batch visualization?
- If opengrads can only run on login nodes with `Xvfb`, is that a
  viable workflow for your scientists?
- Are there alternative tools (Python: matplotlib, cartopy, xarray;
  or NCL — though NCL is deprecated) that provide the same
  visualization capabilities without the display constraint?

**3. Interactivity constraints**

The Agent runs non-interactively. opengrads expects interactive use.

- opengrads has its own scripting language (`gs` scripts). Can `gs`
  scripts be run in batch mode (`grads -b -cl 0 script.gs`)?
- opengrads has Python (`gradspy`), Perl, and TCL interfaces. Are
  any of these maintained and compatible with modern Python (3.11+),
  Perl, or TCL?
- Can a `gs` script open a Dataset, perform a calculation, and save
  output without any human interaction?
- Does the scripting interface support error handling (try/catch,
  exit codes) or does it crash on the first error?

**Questions for the domain expert:**
- Do you have existing `gs` scripts that you run in batch mode? If
  so, please share an example.
- Have you used the Python, Perl, or TCL interfaces? Which one is
  most mature?
- Does opengrads' scripting language support the operations your
  scientists need (selection, aggregation, remapping, visualization)
  without falling back to interactive mode?

**4. Maintenance status**

opengrads is on SourceForge using CVS.

- When was the last release? The `opengrads-evaluation.feature`
  Scenario records this from the SourceForge project page.
- When was the last CVS commit?
- How many open bug reports are there? Are any critical?
- Who are the active maintainers? Is it a single-person project?
- If the maintainer stops, can the community fork and continue?
- Does opengrads depend on any other unmaintained projects?

**Questions for the domain expert:**
- Are you in contact with the opengrads maintainers?
- Is there a scientific community that relies on opengrads and
  would maintain it if the original maintainers step away?
- Is the lack of maintenance a blocker, or is the current version
  stable enough for your needs?

**5. Go/no-go decision framework**

The final go/no-go decision is the domain expert's responsibility.
The `opengrads-evaluation.feature` Scenario Outline provides the
criteria and examples. The minimum criteria for "go" are:

1. **Buildability:** opengrads can be built on Alps with an
   available compiler (`gcc/11.2.0` or `intel/2021.4`).
2. **Non-interactive use:** at least one scripting interface (gs
   batch mode, Python, Perl, or TCL) can run without a display.
3. **Unique value:** opengrads provides a capability that CDO, NCO,
   and Python tools (healpy, ICON tools, matplotlib, cartopy,
   xarray) cannot.
4. **Node availability:** opengrads can run on a suitable node
   (login, service, or compute with Xvfb) without violating
   shared-node resource limits.
5. **Maintenance:** opengrads is actively maintained or the current
   version is stable enough for production use.

If any of criteria 1–3 fail, the decision is "no-go." If criterion
4 fails, the decision is "no-go." If criterion 5 fails, the
decision is "go with risk" (requires a mitigation plan for
maintenance).

---

### U2: Multi-infrastructure scheduler abstraction [CRITICAL]
**Status:** UNKNOWN
**Severity:** [CRITICAL]
**Source:** `domain-model.md: C4`, `ubiquitous-language.md: Scheduler`

SLURM is the only Scheduler in scope today. PBS/PBS Pro, LSF, and
possibly Cray schedulers may be needed in the future.

- How different are their job lifecycle semantics? SLURM states:
  PENDING, RUNNING, COMPLETED, FAILED, TIMEOUT, CANCELLED,
  OUT_OF_MEMORY, NODE_FAIL. Do PBS, LSF, and Cray have equivalent
  states? Are there states with no SLURM equivalent?
- Do they have equivalent commands? `sbatch` ↔ `qsub`, `squeue` ↔
  `qstat`, `scancel` ↔ `qdel`, `sacct` ↔ `qhist`/`tracejob`. Are the
  output formats compatible enough for a common parser?
- Resource Request semantics differ: SLURM uses `--nodes`,
  `--ntasks-per-node`, `--mem`, `--time`, `--partition`, `--qos`.
  PBS uses `nodes=`, `ppn=`, `mem=`, `walltime=`, queue. LSF uses
  `-n`, `-R`, `-W`, `-q`. Can a common ResourceRequest abstraction
  capture all of these?
- Does the "Scheduler is authoritative" invariant (INV-S1) hold
  equally for PBS and LSF? Do they provide historical job data
  equivalent to `sacct`?

**Question for the domain expert:**
- Which schedulers, besides SLURM, does cera need to support, and
  on what timeline? This determines whether the abstraction is
  needed now or can be deferred.

---

### U3: CDO non-zero exit codes for warnings [HIGH]
**Status:** UNKNOWN
**Severity:** [HIGH]
**Source:** `invariants.md: INV-T3`, `features/cdo-operations.feature`

CDO reportedly returns exit code 1 for some warnings (e.g.,
metadata inconsistencies, non-fatal data issues). The question is:
does exit code 1 for CDO mean "output is usable but warning
flagged" (permissive), or does any non-zero exit code mean failure
(strict)?

- If permissive: a per-Tool success definition must be documented
  in advance, listing which non-zero exit codes are non-errors for
  which Tools. The output Dataset is registered with a warning flag.
- If strict: any non-zero exit code blocks output registration
  (INV-T3 as written).

The `cdo-operations.feature` file includes both variants as
scenarios. The domain expert must confirm which is correct.

**Question for the domain expert:**
- Which CDO operations return exit code 1 for warnings? Is the
  output from those operations scientifically valid and usable?
- Do any other Tools in scope (NCO, healpy, ICON tools) use
  non-zero exit codes for success?

---

### U4: Does CESM's case.submit fix the output location? [HIGH]
**Status:** UNKNOWN
**Severity:** [HIGH]
**Source:** `invariants.md: INV-M4`, `features/cesm-submission.feature`

The filesystem location where a CESM run writes its output tree
must be determined and recorded before the Job is submitted
(INV-M4). Does CESM's own `case.submit` fix the output location
(e.g., always `<case_dir>/run/`), or can it vary based on runtime
configuration?

- If fixed: the Agent records the known location at Case creation
  time. INV-M4 is satisfied trivially.
- If variable: the Agent must determine the output location from
  CESM configuration variables (`RUNDIR`, `DOUT_S_ROOT`, etc.)
  before submission and record it explicitly.

**Question for the domain expert:**
- Does CESM on Alps always write to `<case_dir>/run/`, or can the
  output location be overridden? Which configuration variables
  control this?

---

### U5: Is Workflow a first-class entity with persisted state? [HIGH]
**Status:** UNKNOWN
**Severity:** [HIGH]
**Source:** `domain-model.md: Workflow`, `invariants.md: INV-W2`

Is Workflow a first-class entity with persisted state (surviving
Session end), or an ephemeral plan (recreated each Session)?

- If first-class: WorkflowState (NOT_STARTED, IN_PROGRESS, BLOCKED,
  COMPLETE, FAILED) is a real thing. Workflows can be resumed,
  inspected, and audited after the Session ends.
- If ephemeral: the Workflow is a plan created at Session start and
  discarded at Session end. Individual ToolInvocations and Jobs
  persist (via C1, C4, C6), but the Workflow itself does not.

The current domain model marks Workflow as a first-class entity
(aggregate root in C7), and WorkflowState as CANDIDATE. The
`workflow-execution.feature` file assumes first-class semantics
(resume after Session, state transitions). This needs confirmation.

**Question for the domain expert:**
- Do you need to resume a Workflow across Sessions (e.g., "continue
  the analysis I started yesterday")? Or is each Session a fresh
  start where you re-express your intent?

---

### U6: Is "Experiment" above Workflow needed? [MEDIUM]
**Status:** UNKNOWN
**Severity:** [MEDIUM]
**Source:** `ubiquitous-language.md: Experiment` [CANDIDATE]

Do scientists think in terms of "Experiments" — a scientific
investigation consisting of one or more Workflows and CESM Cases,
tied together by a research question?

- If yes: Experiment is a first-class entity above Workflow. It
  groups related Workflows and Cases, provides a narrative context
  ("sensitivity study: CO2 doubling"), and enables cross-Workflow
  queries.
- If no: Workflows and Cases are the top-level organizational
  units, and "experiment" is informal vocabulary used by scientists
  but not modeled.

**Question for the domain expert:**
- Do you think in terms of experiments that span multiple Workflows
  and CESM runs? Would an "Experiment" entity help you organize and
  query your work, or is it unnecessary structure?

---

### U7: Does the agent need to resume awareness of Jobs from a previous Session? [HIGH]
**Status:** UNKNOWN (assumed yes, needs confirmation)
**Severity:** [HIGH]
**Source:** `invariants.md: INV-W4`, `features/job-management.feature`

The current model assumes that a Session can end while Jobs are
RUNNING, and a later Session can discover those Jobs by JobID
(INV-W4). This is modeled as an invariant and featured in
`job-management.feature` and `workflow-execution.feature`.

- The need is domain-level: scientists run CESM for weeks and
  interact with the Agent across multiple Sessions.
- The mechanism (how Job awareness is persisted and discovered) is
  the architect's responsibility.
- The question is whether the assumption is correct — does the
  domain expert require this behavior?

**Question for the domain expert:**
- When you start a new Session with the Agent, do you expect it to
  know about Jobs you submitted in previous Sessions? Should it
  proactively report on their status, or only when you ask?

---

### U8: "Operator" term overload [MEDIUM]
**Status:** UNKNOWN
**Severity:** [MEDIUM]
**Source:** `ubiquitous-language.md: Operator (Agent) [CANDIDATE]`

"Operator" is overloaded:
- CDO Operator: a single transformation flag (e.g., `-timmean`,
  `-remapcon2`) that can be chained.
- NCO Operator: a separate executable (e.g., `ncks`, `ncra`) that
  cannot be chained.
- Agent Operator (CANDIDATE): a domain-level action exposed to the
  LLM (e.g., "select variable", "compute time mean", "remap grid")
  that may map to one or more CLI operators.

The ubiquitous language suggests "Capability" or "Action" as a
non-overloaded alternative. The domain expert must choose.

**Question for the domain expert:**
- What term should the Agent use for its domain-level actions?
  "Capability"? "Action"? Something else? The term must not
  overload "Operator" as used by CDO and NCO.

---

### U9: CESM is a peer entity, not a Tool [MEDIUM]
**Status:** UNKNOWN (originally INFERRED, needs confirmation)
**Severity:** [MEDIUM]
**Source:** `domain-model.md: Open Modeling Questions #2`

CESM is modeled as a peer entity (Case aggregate in C2) rather than
a Tool in C1, because of its multi-step lifecycle (create →
configure → build → submit → monitor → post-process) and its long
running times.

- If correct: CESM has its own bounded context (C2), its own
  invariants (INV-M1 through INV-M4), and is not just a special
  ToolInvocation.
- If wrong: CESM is a complex Tool in C1, and C2 is an unnecessary
  context. The Case lifecycle is a ToolInvocation lifecycle.

**Question for the domain expert:**
- Is CESM fundamentally different from other Tools (CDO, NCO) in
  a way that justifies its own bounded context, or is it a
  particularly complex Tool?

---

## Open Questions for the Domain Expert

Grouped by layer. These will be relayed to the user for
interrogation. Each group contains the most critical questions
that block or shape the remaining spec work.

### Layer 1 — Domain Model

1. **Is CESM a peer entity or a complex Tool?** (U9) The current
   model gives CESM its own bounded context (C2). If CESM is a
   Tool, C2 collapses into C1.
2. **Is "Experiment" above Workflow needed?** (U6) Do scientists
   think in experiments that span multiple Workflows and CESM
   Cases?
3. **What term replaces "Operator (Agent)"?** (U8) "Capability"?
   "Action"? Must not overload CDO/NCO "Operator."

### Layer 2 — Invariants

1. **CDO exit code 1 — success or failure?** (U3) Does any non-zero
   exit code block output registration (strict), or is exit code 1
   a documented non-error for CDO (permissive)?
2. **Does CESM's case.submit fix the output location?** (U4)
   Affects INV-M4 — is the output tree location always
   `<case_dir>/run/`, or can it vary?
3. **Do other Tools use non-zero exit codes for success?** (U3,
   extended) Beyond CDO, do NCO, healpy, or ICON tools use
   non-zero exit codes in any non-error case?

### Layer 3 — Behavioral Spec

1. **Is Workflow a first-class entity with persisted state?** (U5)
   Determines whether WorkflowState is real and whether Workflows
   can be resumed across Sessions.
2. **Does the agent need to resume awareness of Jobs from previous
   Sessions?** (U7) Assumed yes — confirm the behavior and
   expectations (proactive reporting vs. on-demand query).
3. **opengrads go/no-go decision** (U1) Based on the five criteria
   in the evaluation section: buildability, non-interactive use,
   unique value, node availability, maintenance. The domain expert
   must evaluate each criterion.

### Layer 4 — Cross-Context Interactions

1. **Which schedulers, besides SLURM, does cera need to support, and
   on what timeline?** (U2) Determines whether the scheduler
   abstraction is needed now or can be deferred.
2. **What happens when CESM writes output to a different location
   than expected?** (U4) The Agent must not guess — but does this
   actually happen, and if so, how should the Agent detect and
   handle it?
3. **Should the Agent proactively report Job status when a new
   Session begins, or only when the User asks?** (U7) Affects the
   C4↔C7 interaction contract.

### Layer 5 — Failure Modes

1. **What is the acceptable recovery time for SLURM unavailability?**
   If SLURM is down for 30 minutes during a weeks-long CESM run, is
   UNKNOWN state acceptable, or does the User need a heartbeat
   mechanism?
2. **What is the blast radius of a corrupted ProvenanceRecord?**
   Is one corrupted record a local issue (quarantine that Dataset)
   or a systemic issue (audit the entire Provenance store)?
3. **When the Agent (LLM) hallucinates a Tool name or parameters,
   what is the desired behavior — refuse and ask, or attempt
   best-effort?** This affects the C7↔C1 contract.

### Layer 6 — Assumptions

1. **opengrads: all five evaluation criteria** (U1) — buildability,
   HPC suitability, interactivity, maintenance, unique value.
2. **Module system on Alps: is it Lmod?** (A4) Currently assumed
   Lmod, originally inferred. Quick confirmation.
3. **Is the dsh version pin sufficient, or does cera need a formal
   adapter layer?** (A1) The isolation layer is the architect's
   responsibility, but the domain expert should confirm the
   acceptable level of coupling to dsh.
