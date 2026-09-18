# Architecture

cera is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh), a TypeScript/Node agent framework with an "everything-is-a-plugin"
architecture via Cordis. cera wraps dsh's extension points behind stable
internal interfaces, so a dsh upgrade only affects the `dsh-adapter` module.

Under R14 (ADR-012), **FirecREST is the only production HPC transport**.
dsh runs on the scientist's laptop; all HPC operations go through
FirecREST's REST API. The local backend (`--backend dev`) is for
development only.

## Module graph

```
src/
├── dsh-adapter/          — dsh isolation layer (DEV-ONLY backend, ADR-005).
│                           Wraps ctx.shell, ctx.subprocess, ctx.sandbox,
│                           ctx.fs, ctx.jobs, ctx.tools, ctx.commands into
│                           stable cera-internal interfaces. Only module
│                           that imports dsh.
├── firecrest-adapter/    — FirecREST backend (PRODUCTION, ADR-012).
│                           Implements the same interfaces as dsh-adapter
│                           via FirecREST's REST API. All ToolInvocations
│                           become SLURM Jobs (F-INV-6). uenv is loaded
│                           in Job scripts (F-INV-5). Authentication is
│                           OIDC (JWT Bearer token, F-INV-2).
├── scheduling/           — SLURM job management (DEV-ONLY CLI impl).
│   │                       In production, replaced by
│   │                       FirecRESTSchedulingService (via FirecREST
│   │                       compute endpoints: POST/GET/DELETE
│   │                       /compute/{system}/jobs).
├── environment-management/ — uenv mount/unmount (DEV-ONLY runtime).
│   │                         Types (Environment, UenvSpec, Module,
│   │                         Conflict) are used by tool-invocation to
│   │                         construct Job scripts. The runtime service
│   │                         (mount/unmount/verify) is only active in
│   │                         dev mode (FP-INV-3).
├── provenance/           — Immutable ProvenanceRecords (JSON on HPC
│                           filesystem via FirecREST). Lineage traversal,
│                           local quarantine (R11).
├── data-management/      — Dataset registry (in-memory), Location
│   │                       validation (via FirecREST stat/list in
│   │                       production), markConsumable (joint with
│   │                       provenance, INV-D3/INV-P3).
├── tool-invocation/      — Tool execution (CLI, Python, Model/CESM).
│   │                       All parallel in production (F-INV-6).
│   │                       Full lifecycle: validate → (Env skip in prod)
│   │                       → validate Locations → start → monitor →
│   │                       complete/fail. Case lifecycle: create →
│   │                       configure → build → submit → monitor →
│   │                       post-process.
├── agent-interaction/    — Session (proactive Job reporting, R7),
│   │                       Experiment (first-class, ADR-002),
│   │                       Workflow (persisted, ADR-006),
│   │                       Action (LLM-facing, R3/ADR-010).
└── startup.ts            — createCeraSystem() factory (ADR-012).
                            Wires all 8 modules based on selected
                            backend. For type: 'firecrest' (default),
                            creates FirecREST-backed interfaces with
                            no EnvironmentService (FP-INV-3). For
                            type: 'dev', creates dsh-adapter-backed
                            interfaces with active EnvironmentService.
```

## Bounded contexts

| Context | Module | Key entities | Key invariants |
|---------|--------|-------------|----------------|
| C1 — Tool Invocation | `tool-invocation` | Tool, ToolInvocation, Case | INV-T1–T9 |
| C3 — Data Management | `data-management` | Dataset, Format, Grid, Variable | INV-D1–D4 |
| C4 — Scheduling | `scheduling` | Job, JobId, ResourceRequest, JobState | INV-S1–S4 |
| C5 — Environment Management | `environment-management` | Environment, UenvSpec, Module | INV-E1–E3 (dev-only) |
| C6 — Provenance | `provenance` | ProvenanceRecord | INV-P1–P4 |
| C7 — Agent Interaction | `agent-interaction` | Session, User, Workflow, Experiment, Action | INV-W1–W4 |

## Two backends

| Feature | Dev (dsh-adapter) | Production (firecrest-adapter) |
|---------|-------------------|-------------------------------|
| Where cera runs | HPC login node (dev only) | Laptop |
| Authentication | SSH (existing) | OIDC (JWT Bearer token, F-INV-2) |
| Tool execution | Local subprocess | SLURM Job via REST API |
| Synchronous Tools | Yes (ShellExecutor) | No — all parallel (F-INV-6) |
| uenv management | cera calls `uenv mount/umount` | Embedded in Job script (F-INV-5) |
| File access | Direct filesystem | HTTP (≤5MB sync, >5MB async, F-INV-4) |
| Provenance store | Local filesystem (HPC) | HPC filesystem via REST |
| EnvironmentService | Active | Not used (FP-INV-3) |
| `--backend` flag | `dev` | `firecrest` (default, FP-INV-1) |

Both backends implement the same cera-internal interfaces. The backend
is selected at startup via `createCeraSystem()` in `src/startup.ts`
(ADR-012). Domain modules (C1, C3–C7) are backend-agnostic — they
depend on the interfaces, not the implementation.

## Build phases

| Phase | Modules | Key capability |
|-------|---------|----------------|
| 1 | `dsh-adapter` | Stable interfaces wrapping dsh |
| 2 | `scheduling`, `environment-management`, `provenance` | SLURM Jobs, uenv Environments, Provenance records |
| 3 | `data-management` | Dataset registration and validation |
| 4 | `tool-invocation` | Tool execution (incl. CESM Cases) |
| 5 | `agent-interaction` | Session, Experiment, Workflow, Action |
| Post | `firecrest-adapter` | Laptop backend via FirecREST REST API |
| R14 | `startup`, CLI refactor | Backend selection, createCeraSystem() factory |

## Cross-context interactions

9 key interactions between bounded contexts, documented in
[`specs/cross-context/interactions.md`](https://github.com/mbianco/cera/blob/main/specs/cross-context/interactions.md):

| ID | Contexts | Summary |
|----|---------|---------|
| X1 | C1↔C5 | Tool requires Environment; load+verify before invocation (dev-only in production) |
| X2 | C1↔C4 | Parallel tool delegates to Scheduling |
| X3 | C1↔C3 | Tools consume and produce Datasets |
| X4 | C1↔C6 | Every ToolInvocation produces a ProvenanceRecord |
| X7 | C3↔C6 | Dataset not consumable until ProvenanceRecord exists |
| X8 | C4↔C7 | Session outlives Jobs; proactive Job reporting |
| X10 | C7↔C1 | Agent translates User intent into ToolInvocations |
| X12 | C7↔C3 | Agent queries, references, and registers Datasets |
| X13 | C6↔C7 | Agent queries ProvenanceRecords on behalf of User |
