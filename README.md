# cera

AI agent for climate scientists, built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

cera wraps legacy scientific tools — CDO, NCO, CESM, Python tools for
ICON/healpix/zarr — so climate scientists can use them natively through
an LLM-driven agent running on their laptop. All HPC operations go
through [FirecREST](https://firecrest.cscs.ch/), CSCS's RESTful API for
HPC resources. No SSH, no VPN — just an OIDC token.

## Status

**Developer preview.** 886 tests across 7 modules + 2 backends.
Not yet deployed on Alps — requires dsh binding and integration
testing against real FirecREST/SLURM/CDO/CESM.

## Quick start

```bash
git clone git@github.com:mbianco/cera.git
cd cera
npm install

# Build (produces dist/cli.mjs + dist/index.mjs)
npm run build

# Run cera (FirecREST backend is the default)
./dist/cli.mjs --backend firecrest \
  --firecrest-url https://firecrest.cscs.ch \
  --system daint \
  --token-endpoint https://idp.cscs.ch/auth/realms/cscs/protocol/openid-connect/token \
  --client-id cera-client \
  --client-secret "$CERA_CLIENT_SECRET" \
  --uenv-specs cdo:2.0.5

# Development mode (requires dsh on the local machine)
./dist/cli.mjs --backend dev

# Or use tsx for development without building
npm run dev -- --backend firecrest --firecrest-url https://firecrest.cscs.ch --system daint --token-endpoint https://idp.cscs.ch/auth/realms/cscs/protocol/openid-connect/token --client-id cera-client --client-secret "$CERA_CLIENT_SECRET"
```

## Architecture

cera runs on the scientist's laptop. dsh provides the agent loop, LLM
adapter, session management, and tool registration — all locally.
FirecREST is the only production HPC transport: Job submission, file
access, and tool execution all go through REST API calls.

```
 Laptop                          Alps (via FirecREST)
 ┌─────────────┐                ┌──────────────────┐
 │  dsh        │   REST API     │  SLURM           │
 │  cera       │ ────────────── │  uenv (in Jobs)  │
 │  LLM        │   OIDC (JWT)   │  CDO, NCO, CESM  │
 └─────────────┘                │  Filesystem      │
                                └──────────────────┘
```

### Modules

```
src/
├── dsh-adapter/          — dsh isolation layer (dev-only backend).
│                           Wraps ctx.shell, ctx.subprocess, ctx.fs,
│                           etc. into stable cera interfaces. Only
│                           module that imports dsh (ADR-005).
├── firecrest-adapter/    — FirecREST backend (production). Implements
│                           the same interfaces as dsh-adapter via
│                           REST API. All ToolInvocations become SLURM
│                           Jobs (F-INV-6). uenv in Job scripts
│                           (F-INV-5). OIDC authentication (F-INV-2).
├── startup.ts            — createCeraSystem() factory. Selects
│                           backend at startup (default: firecrest).
│                           Wires all 7 domain modules.
├── scheduling/           — SLURM job management (dev-only CLI impl).
│                           In production, replaced by
│                           FirecRESTSchedulingService.
├── environment-management/ — uenv mount/unmount (dev-only). In
│   │                         production, uenv is in Job scripts.
│   │                         Types (Environment, UenvSpec) stay —
│   │                         used by tool-invocation to build scripts.
├── provenance/           — Immutable ProvenanceRecords on HPC
│                           filesystem. Local quarantine (R11).
├── data-management/      — Dataset registry, Location validation,
│                           markConsumable (joint with provenance).
├── tool-invocation/      — Tool execution + CESM Case lifecycle.
│                           All parallel in production (F-INV-6).
│                           Optional EnvironmentService (FCREST-01).
│                           JobScriptConfig for uenv + default
│                           ResourceRequest (FP-INV-5).
├── agent-interaction/    — Session (proactive Job reporting, R7),
│                           Experiment (first-class, ADR-002),
│                           Workflow (persisted, ADR-006),
│                           Action (LLM-facing, R3/ADR-010).
└── cli.ts                — CLI entry point. --backend firecrest
                           (default) or --backend dev.
```

### Key design decisions

- **FirecREST is the only production HPC transport** (ADR-012). dsh
  runs on the laptop. No SSH, no VPN. The local backend is dev-only
  (`--backend dev`).
- **CESM is a complex Tool** (ADR-001), not a peer entity. The Case
  lifecycle is a specialized ToolInvocation.
- **Experiment is first-class** (ADR-002) with eventual consistency
  for Case assignment.
- **uenv, not Lmod** (ADR-003). In production, uenv is loaded in Job
  scripts (F-INV-5), not by cera.
- **SLURM-only** (ADR-004). Multi-scheduler abstraction deferred.
- **dsh isolation layer** (ADR-005). dsh is pinned; only
  `dsh-adapter` imports it.
- **Workflow persistence** (ADR-006). Workflows stored as JSON files.
- **Strict exit codes** (ADR-008). Non-zero blocks output registration
  by default; permissive is opt-in.
- **LLM hallucination: refuse and ask** (ADR-010). No best-effort
  substitution.

See `specs/architecture/adr/` for all 12 ADRs.

## Testing

Three tiers, cascading (see `Makefile`):

| Tier | What | Command | When |
|------|------|---------|------|
| 1 (fast) | Unit + property tests | `make test-fast` | Every edit, pre-commit |
| 2 (slow) | Tier 1 + integration tests + coverage | `make test-slow` | Pre-PR |
| 3 (full) | Tier 2 + e2e (real HPC) | `make test-full` | Pre-merge, nightly |

```bash
# Default: lint + typecheck + Tier 1
make

# Full suite
make test-full
```

886 tests across 41 test files. 0 npm vulnerabilities.

## Documentation

Full documentation is published at
[mbianco.github.io/cera](https://mbianco.github.io/cera/):

- [Getting Started](https://mbianco.github.io/cera/getting-started/)
- [Architecture](https://mbianco.github.io/cera/architecture/)
- [API Reference](https://mbianco.github.io/cera/api-reference/)
- [ADRs](https://mbianco.github.io/cera/adrs/)
- [Contributing](https://github.com/mbianco/cera/blob/main/CONTRIBUTING.md)

## Specs

All specification artifacts live in `specs/`:

- `specs/domain-model.md` — entities, aggregates, bounded contexts
- `specs/ubiquitous-language.md` — domain glossary
- `specs/invariants.md` — 28 system invariants (local backend)
- `specs/invariants-firecrest-primary.md` — invariants under R14
- `specs/failure-modes.md` — 34 failure scenarios (local backend)
- `specs/failure-modes-firecrest-primary.md` — failure modes under R14
- `specs/resolutions.md` — domain expert resolutions R1–R13
- `specs/resolutions-r14.md` — R14: FirecREST as only production transport
- `specs/features/*.feature` — 10 Gherkin behavioral specs
- `specs/firecrest/` — FirecREST-specific invariants, failure modes, assumptions, API contracts
- `specs/architecture/` — module graph, API contracts, dependency graph, enforcement map, error taxonomy, build phases, 12 ADRs
- `specs/cross-context/interactions.md` — integration points between bounded contexts

## License

[MIT](LICENSE)
