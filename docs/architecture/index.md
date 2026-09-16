# Architecture

cera is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh), a TypeScript/Node agent framework with an "everything-is-a-plugin"
architecture via Cordis. cera wraps dsh's extension points behind stable
internal interfaces, so a dsh upgrade only affects the `dsh-adapter` module.

## Module graph

```
src/
├── dsh-adapter/          — Isolation layer (Phase 1). Only module that
│                           imports dsh. Wraps ctx.shell, ctx.subprocess,
│                           ctx.sandbox, ctx.fs, ctx.jobs, ctx.tools,
│                           ctx.commands into stable cera interfaces.
├── firecrest-adapter/    — FirecREST backend (ADR-011). Implements the
│                           same interfaces as dsh-adapter via REST API.
│                           All ToolInvocations become SLURM Jobs.
├── scheduling/           — SLURM job management: submit (sbatch), query
│   │                       (squeue/sacct), cancel (scancel), monitor
│   │                       (poll with backoff, R13).
├── environment-management/ — uenv mount/unmount, conflict detection at
│   │                         filesystem path level (not Lmod soname).
├── provenance/           — Immutable ProvenanceRecords (JSON on HPC
│                           filesystem), lineage traversal, local
│                           quarantine (R11).
├── data-management/      — Dataset registry (in-memory), Location
│   │                       validation, markConsumable (joint with
│   │                       provenance, INV-D3/INV-P3).
├── tool-invocation/      — Tool execution (CLI, Python, Model/CESM).
│   │                       Full lifecycle: validate → verify Env →
│   │                       validate Locations → start → monitor →
│   │                       complete/fail. Case lifecycle: create →
│   │                       configure → build → submit → monitor →
│   │                       post-process.
└── agent-interaction/    — Session (proactive Job reporting, R7),
                            Experiment (first-class, eventual
                            consistency), Workflow (persisted, R6),
                            Action (LLM-facing, refuse and ask R12).
```

## Bounded contexts

| Context | Module | Key entities | Key invariants |
|---------|--------|-------------|----------------|
| C1 — Tool Invocation | `tool-invocation` | Tool, ToolInvocation, Case | INV-T1–T9 |
| C3 — Data Management | `data-management` | Dataset, Format, Grid, Variable | INV-D1–D4 |
| C4 — Scheduling | `scheduling` | Job, JobId, ResourceRequest, JobState | INV-S1–S4 |
| C5 — Environment Management | `environment-management` | Environment, UenvSpec, Module | INV-E1–E3 |
| C6 — Provenance | `provenance` | ProvenanceRecord | INV-P1–P4 |
| C7 — Agent Interaction | `agent-interaction` | Session, User, Workflow, Experiment, Action | INV-W1–W4 |

## Two backends

| Feature | Local (dsh-adapter) | FirecREST (firecrest-adapter) |
|---------|--------------------|-------------------------------|
| Where cera runs | Alps login node | Laptop |
| Authentication | SSH (existing) | OIDC (JWT Bearer token) |
| Tool execution | Local subprocess | SLURM Job via REST API |
| Synchronous Tools | Yes (ShellExecutor) | No — all parallel (F-INV-6) |
| uenv management | cera calls `uenv mount/umount` | Embedded in Job script (F-INV-5) |
| File access | Direct filesystem | HTTP (≤5MB sync, >5MB async) |
| Provenance store | Local filesystem (HPC) | HPC filesystem via REST |

Both backends implement the same cera-internal interfaces. The
backend is selected at startup via configuration. Domain modules
(C1, C3–C7) are backend-agnostic — they depend on the interfaces,
not the implementation.

## Build phases

| Phase | Modules | Key capability |
|-------|---------|----------------|
| 1 | `dsh-adapter` | Stable interfaces wrapping dsh |
| 2 | `scheduling`, `environment-management`, `provenance` | SLURM Jobs, uenv Environments, Provenance records |
| 3 | `data-management` | Dataset registration and validation |
| 4 | `tool-invocation` | Tool execution (incl. CESM Cases) |
| 5 | `agent-interaction` | Session, Experiment, Workflow, Action |
| Post | `firecrest-adapter` | Laptop backend via FirecREST REST API |

## Cross-context interactions

9 key interactions between bounded contexts, documented in
[`specs/cross-context/interactions.md`](https://github.com/mbianco/cera/blob/main/specs/cross-context/interactions.md):

| ID | Contexts | Summary |
|----|---------|---------|
| X1 | C1↔C5 | Tool requires Environment; load+verify before invocation |
| X2 | C1↔C4 | Parallel tool delegates to Scheduling |
| X3 | C1↔C3 | Tools consume and produce Datasets |
| X4 | C1↔C6 | Every ToolInvocation produces a ProvenanceRecord |
| X7 | C3↔C6 | Dataset not consumable until ProvenanceRecord exists |
| X8 | C4↔C7 | Session outlives Jobs; proactive Job reporting |
| X10 | C7↔C1 | Agent translates User intent into ToolInvocations |
| X12 | C7↔C3 | Agent queries, references, and registers Datasets |
| X13 | C6↔C7 | Agent queries ProvenanceRecords on behalf of User |
