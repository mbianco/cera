# cera

AI agent for climate scientists on the Alps supercomputer, built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

cera wraps legacy scientific tools — CDO, NCO, CESM, Python tools for ICON/healpix/zarr — so climate scientists can use them natively through an LLM-driven agent. The agent runs on login/service nodes and dispatches compute jobs via SLURM. It uses uenv (squashfs mounts) for environment management on Alps.

## Status

**Developer preview.** All 5 implementation phases are complete with 742 passing tests. The system has not yet been deployed on Alps — it requires a dsh binding and integration testing against real SLURM/uenv/CDO/CESM.

## Quick start

```bash
# Clone
git clone git@github.com:mbianco/cera.git
cd cera

# Install (npm or pnpm)
npm install

# Run tests (Tier 1 — fast)
npm run test:fast

# Full verification (lint + typecheck + all tests)
npm run lint && npm run typecheck && npm run test:full

# Build
npm run build
```

## Architecture

```
src/
├── dsh-adapter/          — Isolation layer between dsh and cera (Phase 1)
│                           Only module that imports dsh. All others import
│                           this module's stable interfaces.
├── scheduling/           — SLURM job management: submit, query, cancel (Phase 2)
├── environment-management/ — uenv mount/unmount, conflict detection (Phase 2)
├── provenance/           — Immutable ProvenanceRecords, lineage (Phase 2)
├── data-management/      — Dataset registry, Location validation (Phase 3)
├── tool-invocation/      — Tool execution + CESM Case lifecycle (Phase 4)
└── agent-interaction/    — Session, Experiment, Workflow, Action (Phase 5)
```

### Key design decisions

- **CESM is a complex Tool** (ADR-001), not a peer entity. The Case lifecycle is a specialized ToolInvocation.
- **Experiment is first-class** (ADR-002) with eventual consistency for Case assignment.
- **uenv, not Lmod** (ADR-003). Environments are squashfs mounts at prescribed paths.
- **SLURM-only** (ADR-004). Multi-scheduler abstraction deferred.
- **dsh isolation layer** (ADR-005). dsh is pinned; only `dsh-adapter` imports it.
- **Workflow persistence** (ADR-006). Workflows are stored as JSON files on the filesystem.
- **Strict exit codes** (ADR-008). Non-zero blocks output registration by default; permissive is opt-in.
- **LLM hallucination: refuse and ask** (ADR-010). No best-effort substitution.

See `specs/architecture/adr/` for all 10 ADRs.

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

## Specs

All specification artifacts live in `specs/`:

- `specs/domain-model.md` — entities, aggregates, bounded contexts
- `specs/ubiquitous-language.md` — domain glossary
- `specs/invariants.md` — 28 system invariants
- `specs/failure-modes.md` — 34 failure scenarios
- `specs/resolutions.md` — domain expert resolutions (R1–R13)
- `specs/features/*.feature` — 10 Gherkin behavioral specs
- `specs/architecture/` — module graph, API contracts, dependency graph, enforcement map, error taxonomy, build phases, ADRs
- `specs/cross-context/interactions.md` — integration points between bounded contexts

## License

[MIT](LICENSE)
