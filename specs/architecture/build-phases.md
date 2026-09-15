# Build Phases — cera

> Derives implementation order from the dependency graph. Leaf
> modules (no internal deps) are Phase 1. Modules depending only on
> leaves are Phase 2. And so on.
>
> All modules also depend on `dsh-adapter` (Phase 1 infrastructure),
> so Phase 1 must be completed before any other module can be built
> and tested.

---

## Phase 1: Infrastructure

### Modules
- `dsh-adapter`

### Capabilities after this phase
- Stable TypeScript interfaces wrapping all dsh extension points
  (`ctx.shell`, `ctx.subprocess`, `ctx.sandbox`, `ctx.fs`, `ctx.jobs`,
  `ctx.tools`, `ctx.commands`).
- The only module that imports dsh directly. All other modules import
  `dsh-adapter` instead.
- The isolation layer described in A1 (`assumptions.md`) and ADR-005.

### Tests possible after this phase
- Unit tests for each adapter interface using mock dsh contexts.
- Verify that swapping the dsh version only requires changes in
  `dsh-adapter`, not in domain modules.
- Verify that adapter interfaces are stable and don't leak dsh types
  (no `any` in public signatures).

### Dependencies on external systems
- **dsh** — the TypeScript/Node agent framework. Pinned version in
  `package.json` (A1: do not auto-update).
- No HPC system access required (mockable).

### Spec references
- `assumptions.md` A1 (dsh developer preview, isolation layer)
- `failure-modes.md` FM-X3 (dsh breaking change)
- ADR-005 (dsh isolation layer)

---

## Phase 2: Leaf Domain Modules

### Modules
- `scheduling` (C4 — SLURM)
- `environment-management` (C5 — uenv)
- `provenance` (C6)

### Capabilities after this phase

**scheduling:**
- Submit SLURM Jobs via `sbatch`.
- Query Job state via `squeue` (active) and `sacct` (historical).
- Cancel Jobs via `scancel`.
- Reconcile Job states after SLURM outages (R13).
- Proactive Job queries by User (for R7, used in Phase 5).

**environment-management:**
- Check uenv availability via the uenv registry (INV-E3).
- Mount/unmount uenvs (squashfs at prescribed paths).
- Detect path-level conflicts between uenvs (INV-E2, updated for uenv).
- Verify an Environment is still active and conflict-free.
- At most one active Environment per execution context (INV-E1).

**provenance:**
- Write immutable ProvenanceRecords (INV-P1, INV-P2).
- Query ProvenanceRecords by Dataset or Job identity.
- Query lineage chains.
- Verify Provenance before consumption (INV-P3).
- Reconstruct corrupted records (best-effort).
- Quarantine individual Datasets (R11: local, not systemic).

### Tests possible after this phase
- **scheduling:** Unit tests with mock `sbatch`/`squeue`/`scancel`/
  `sacct` output. Verify INV-S1 (no inference from files), INV-S2
  (immutable ResourceRequest), INV-S3 (Scheduler assigns JobID),
  INV-S4 (terminal state is final). Verify UNKNOWN state handling
  (R13, FM-S2).
- **environment-management:** Unit tests with mock uenv registry and
  mount commands. Verify INV-E1 (one active Environment), INV-E2
  (conflict detection before execution), INV-E3 (availability
  check). Test partial mount (FM-E3), conflicting uenvs (FM-E2).
- **provenance:** Unit tests with a mock filesystem store. Verify
  INV-P1 (immutability), INV-P2 (full tuple), INV-P3 (before
  consumption), INV-P4 (survives Session end). Test write failure
  (FM-P1), corrupted record (FM-P2, R11 local quarantine).

### Dependencies on external systems
- **dsh-adapter** (Phase 1, internal).
- **SLURM** — `scheduling` requires `sbatch`, `squeue`, `scancel`,
  `sacct` CLI tools on the host. For unit tests, these are mocked.
  For integration tests (Tier 3), a real SLURM controller is needed.
- **uenv** — `environment-management` requires the uenv CLI and
  registry on the host. For unit tests, these are mocked. For
  integration tests, a real uenv installation is needed.
- **Filesystem** — `provenance` requires filesystem write access.
  For unit tests, a temporary directory is used.

### Spec references
- `scheduling`: `domain-model.md` C4; `invariants.md` INV-S1–S4;
  `resolutions.md` R8, R13; `features/job-management.feature`
- `environment-management`: `domain-model.md` C5; `invariants.md`
  INV-E1–E3; `resolutions.md` R9; `features/environment-management.feature`
- `provenance`: `domain-model.md` C6; `invariants.md` INV-P1–P4;
  `resolutions.md` R11; `features/provenance.feature`

---

## Phase 3: Data Management

### Modules
- `data-management` (C3)

### Capabilities after this phase
- Register Datasets with Format, Grid, Variables, and Location.
- Query Datasets by identity or filter.
- Validate Location accessibility (read/write) before use (INV-D4).
- Mark Datasets as consumable (only after Provenance verification,
  INV-D3 — joint enforcement with `provenance` from Phase 2).
- Quarantine Datasets (corrupted, missing Provenance, external
  mutation).
- Dataset immutability (INV-D1) enforced by type system and runtime.
- One Format, one Grid per Dataset (INV-D2) enforced by type system.

### Tests possible after this phase
- Unit tests with mock `provenance` (from Phase 2) and mock
  filesystem (via `dsh-adapter`).
- Verify INV-D1 (immutability — no operation modifies an existing
  Dataset).
- Verify INV-D2 (one Format, one Grid — immutable fields).
- Verify INV-D3 (Provenance before consumption — `markConsumable()`
  blocks if no ProvenanceRecord).
- Verify INV-D4 (Location resolves before use).
- Test FM-D1 (quota exceeded), FM-D2 (slow filesystem), FM-D3
  (file not found / permission denied), FM-D5 (corrupted ZARR).

### Dependencies on external systems
- `provenance` (Phase 2, internal).
- `dsh-adapter` (Phase 1, internal).
- **Filesystem** — `data-management` requires filesystem access for
  Location validation. For unit tests, a temporary directory is used.
  For integration tests, an HPC parallel filesystem (Lustre, GPFS)
  is needed.

### Spec references
- `domain-model.md` C3; `invariants.md` INV-D1–D4;
  `cross-context/interactions.md` X3, X7;
  `features/zarr-io.feature`, `features/grid-conversion.feature`

---

## Phase 4: Tool Invocation (including CESM)

### Modules
- `tool-invocation` (C1)

### Capabilities after this phase
- Invoke CLI Tools (CDO, NCO) synchronously via `dsh-adapter`.
- Invoke Python Tools (healpy, ICON tools, zarr) via `dsh-adapter`.
- Invoke Model Tools (CESM) with the full Case lifecycle:
  create → configure → build → submit → monitor → post-process.
- Parallel ToolInvocations delegate to `scheduling` (Phase 2) via
  SLURM.
- Tool catalog: register and query Tools.
- Strict exit codes (R4): non-zero blocks output registration by
  default. Permissive mode is opt-in per ToolInvocation.
- Signal vs. exit-code distinction (INV-T5) preserved.
- Input immutability (INV-T4): input Datasets opened for reading only.
- Output registration gated on success (INV-T3).
- Case invariants (INV-T6–T9, formerly INV-M1–M4) enforced.
- ProvenanceRecord written for every ToolInvocation (X4).
- Environment loaded and verified before invocation (INV-T1, via
  `environment-management` from Phase 2).
- Input Datasets validated with Provenance before consumption (via
  `data-management` from Phase 3).

### Tests possible after this phase
- Unit tests with mock `environment-management`, `data-management`,
  `provenance`, `scheduling` (all from Phases 2–3) and mock
  `dsh-adapter` (Phase 1).
- Verify INV-T1–T9 (all C1 invariants).
- Verify Tool lifecycle: create → start → monitor → complete/fail.
- Verify Case lifecycle: create → configure → build → submit →
  monitor → post-process.
- Test FM-T1–T5, FM-M1–M5 (all C1/C2 failure modes, now in C1).
- Test exit code scenarios (strict default, permissive opt-in).
- Test signal scenarios (SIGSEGV, SIGKILL, SIGTERM).
- BDD tests from `cdo-operations.feature`, `nco-operations.feature`,
  `cesm-submission.feature`, `grid-conversion.feature`,
  `zarr-io.feature` (ToolInvocation-level scenarios).

### Dependencies on external systems
- `environment-management` (Phase 2, internal).
- `data-management` (Phase 3, internal).
- `provenance` (Phase 2, internal).
- `scheduling` (Phase 2, internal).
- `dsh-adapter` (Phase 1, internal).
- **CLI Tools** — CDO, NCO must be installed on the host for
  integration tests. For unit tests, they are mocked.
- **Python Tools** — healpy, zarr, ICON tools must be installed for
  integration tests. For unit tests, they are mocked.
- **CESM** — must be installed (source tree, build system) for
  integration tests. For unit tests, `case.setup`, `case.build`,
  `case.submit` are mocked.
- **SLURM** — for parallel ToolInvocations and CESM Cases (via
  `scheduling` from Phase 2).
- **uenv** — for Environment loading (via `environment-management`
  from Phase 2).
- **Filesystem** — for Dataset I/O (via `data-management` from
  Phase 3).

### Spec references
- `domain-model.md` C1, C2 (collapsed into C1);
  `invariants.md` INV-T1–T9;
  `resolutions.md` R1 (CESM is Tool), R4 (strict exit codes), R5
  (output location fixed), R10 (opengrads not mandatory);
  `cross-context/interactions.md` X1–X6, X9–X11, X14;
  `failure-modes.md` FM-T1–T5, FM-M1–M5;
  `features/cdo-operations.feature`, `features/nco-operations.feature`,
  `features/cesm-submission.feature`, `features/grid-conversion.feature`,
  `features/zarr-io.feature`, `features/opengrads-evaluation.feature`

---

## Phase 5: Agent Interaction (including Experiment, Workflow)

### Modules
- `agent-interaction` (C7)

### Capabilities after this phase
- Full LLM-facing surface: Session, Experiment, Workflow, Action.
- Session lifecycle: start → proactive Job report (R7) → interact →
  end. Running Jobs survive Session end (INV-W4).
- Experiment lifecycle: create → add Workflows → add Cases → query
  (R2).
- Workflow lifecycle: create → add steps → start → resume → complete/
  fail. Workflow state persists across Sessions (R6).
- Action (LLM-facing concept, R3): register, validate, list. Actions
  are exposed to the LLM via `dsh-adapter.ToolRegistry`.
- LLM hallucination policy: refuse and ask (R12, ADR-010). If the
  LLM generates a Tool name or parameters not in the catalog, the
  Agent refuses and asks the User for clarification.
- Workflow execution: step inputs verified with Provenance before
  start (INV-W1). Failure halts downstream (INV-W2). Real
  dependencies checked (INV-W3, best-effort).
- End-to-end: User expresses intent → Agent translates into
  ToolInvocations → Tools execute → Datasets registered →
  Provenance recorded → User notified.

### Tests possible after this phase
- Unit tests with mock `tool-invocation`, `data-management`,
  `provenance`, `scheduling` (all from Phases 2–4) and mock
  `dsh-adapter` (Phase 1).
- Verify INV-W1–W4 (all C7 invariants).
- Verify Session lifecycle: proactive Job report on start, Jobs
  survive end.
- Verify Workflow lifecycle: create, add steps, start, resume, state
  transitions.
- Verify Experiment lifecycle: create, add Workflows/Cases, query.
- Verify Action validation: hallucinated Tool name → refuse and ask;
  hallucinated parameters → refuse and ask.
- Verify failure halts downstream: step fails → dependent steps not
  started.
- BDD tests from `workflow-execution.feature` (full Workflow
  scenarios, cross-session recovery).
- End-to-end (Tier 3): User intent → Workflow → ToolInvocations →
  Datasets → Provenance, against real dsh, SLURM, uenv, filesystem,
  and CLI Tools.

### Dependencies on external systems
- `tool-invocation` (Phase 4, internal).
- `data-management` (Phase 3, internal).
- `provenance` (Phase 2, internal).
- `scheduling` (Phase 2, internal).
- `dsh-adapter` (Phase 1, internal).
- **LLM** — the language model API (DeepSeek). For unit tests, the
  LLM is mocked. For integration tests (Tier 3), a real LLM API
  endpoint is needed.
- **dsh** — for `ctx.tools` (Action registration) and `ctx.commands`
  (human-command dispatch), via `dsh-adapter`.
- All external systems from Phases 2–4 (SLURM, uenv, filesystem,
  CLI Tools, CESM) for end-to-end tests.

### Spec references
- `domain-model.md` C7; `invariants.md` INV-W1–W4;
  `resolutions.md` R2 (Experiment), R3 (Action), R6 (Workflow
  persists), R7 (proactive Job reporting), R12 (refuse and ask);
  `cross-context/interactions.md` X8, X10–X13;
  `failure-modes.md` FM-A1–A4;
  `features/workflow-execution.feature`, `features/cesm-submission.feature`
  (cross-session recovery scenarios)

---

## Phase Summary

| Phase | Modules | Internal deps | External deps | Key capability |
|-------|---------|---------------|---------------|----------------|
| 1 | `dsh-adapter` | none | dsh | Stable interfaces wrapping dsh |
| 2 | `scheduling`, `environment-management`, `provenance` | `dsh-adapter` | SLURM, uenv, filesystem | SLURM Jobs, uenv Environments, Provenance records |
| 3 | `data-management` | `provenance`, `dsh-adapter` | filesystem | Dataset registration and validation |
| 4 | `tool-invocation` | `environment-management`, `data-management`, `provenance`, `scheduling`, `dsh-adapter` | CLI Tools, Python Tools, CESM | Tool execution (incl. CESM Cases) |
| 5 | `agent-interaction` | `tool-invocation`, `data-management`, `provenance`, `scheduling`, `dsh-adapter` | LLM | Session, Experiment, Workflow, Action |

---

## Test Strategy by Phase

| Phase | Fast (Tier 1) | Slow (Tier 2) | Full (Tier 3) |
|-------|---------------|---------------|----------------|
| 1 | Unit tests with mock dsh contexts | — | — |
| 2 | Unit tests with mock SLURM/uenv/fs | Property tests for invariant enforcement | Integration against real SLURM/uenv |
| 3 | Unit tests with mock provenance/fs | BDD scenarios from grid-conversion/zarr-io features | Integration against real HPC filesystem |
| 4 | Unit tests with all mocked deps | BDD scenarios from all Tool features; slow-marked CESM tests | Integration against real CLI Tools + CESM + SLURM |
| 5 | Unit tests with all mocked deps | BDD scenarios from workflow-execution feature; context window tests | End-to-end: User intent → Workflow → Tools → Datasets → Provenance |

---

## Parallelization Opportunities

Within each phase, modules with no mutual dependencies can be built
in parallel:

- **Phase 2:** `scheduling`, `environment-management`, and
  `provenance` are independent of each other. They can be built
  simultaneously by up to 3 implementers.
- **Phase 3–5:** Single module per phase. No parallelization within
  a phase, but the previous phase's tests can run while the next
  phase is being designed.
