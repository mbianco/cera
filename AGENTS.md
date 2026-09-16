# cera — AGENTS.md

**Language:** TypeScript (strict mode, ES modules, target ES2022)

**Build system:** tsdown (build), vitest (test), eslint (lint), tsc (typecheck)

## Commands

| Command | Purpose | Tier |
|---------|---------|------|
| `make` | Lint + typecheck + Tier 1 (default) | 1 |
| `make test-fast` | Fast unit + property tests | 1 |
| `make test-slow` | Tier 1 + integration tests + coverage | 2 |
| `make test-full` | Tier 2 + full e2e (real HPC) | 3 |
| `npm run lint` | ESLint — zero warnings allowed | — |
| `npm run typecheck` | `tsc --noEmit` | — |
| `npm run build` | Build with tsdown → `dist/` | — |

**CI:** GitHub Actions — Tier 1 on every push/PR, Tier 2 on PR, Tier 3 nightly + pre-release. See `.github/workflows/`.

## dsh dependency pinning

`@deepseek-ai/dsh` is pinned to an exact version in `package.json` (no `^` or `~`).
This is critical — dsh is in developer preview with breaking-change warnings
(assumptions.md A1, ADR-005). The `dsh-adapter` module is the ONLY module that
imports dsh. When upgrading dsh, update only `dsh-adapter` and run the full
test suite (Tier 3).

## Specs

All spec artifacts live in `specs/`:
- `specs/domain-model.md` — entities, aggregates, bounded contexts
- `specs/ubiquitous-language.md` — domain glossary
- `specs/invariants.md` — invariants (INV-*) that must not be violated
- `specs/failure-modes.md` — known failure scenarios and handling
- `specs/resolutions.md` — domain expert resolutions (R1-R13)
- `specs/assumptions.md` — assumptions log
- `specs/features/*.feature` — Gherkin behavioral specs
- `specs/architecture/` — module graph, API contracts, dependency graph,
  enforcement map, error taxonomy, build phases, ADRs
- `specs/cross-context/interactions.md` — integration points between contexts
- `specs/fidelity/` — test depth per invariant (auditor)
- `specs/integration/SUMMARY.md` — integration verification summary
- `specs/findings/` — adversary review findings
- `specs/escalations/` — spec gaps, architecture conflicts, invariant ambiguities

## Project state

**All 5 implementation phases complete.** 742 tests across 7 modules.

| Phase | Module | Tests | Status |
|-------|--------|-------|--------|
| 1 | dsh-adapter | 162 | Complete |
| 2 | scheduling, environment-management, provenance | 239 | Complete |
| 3 | data-management | 90 | Complete |
| 4 | tool-invocation (incl. CESM) | 133 | Complete |
| 5 | agent-interaction (Session, Experiment, Workflow, Action) | 107 | Complete |
| Post-audit | Property tests + integration tests | 11 | Complete |
| **Total** | **7 modules** | **742** | **All green** |

## Workflow roles

| Role | Output scope |
|------|-------------|
| Analyst | Specs only (domain model, invariants, Gherkin) |
| Architect | Structure only (interfaces, contracts, ADRs, module graph) |
| Adversary | Findings only (flaws, gaps, inconsistencies). Read-only. |
| Implementer | Code within architect boundaries (TDD + BDD) |
| Auditor | Measurement + correctness judgment (depth, falsifiability) |
| Integrator | Integration tests at cross-context seams |
