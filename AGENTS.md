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
| `npm run dev` | Run CLI via tsx (no build needed) | — |
| `npm run build` | Build with tsdown → `dist/` | — |
| `npm run lint` | ESLint — zero warnings allowed | — |
| `npm run typecheck` | `tsc --noEmit` | — |

**CI:** GitHub Actions — Tier 1 on every push/PR, Tier 2 on PR, Tier 3
nightly + pre-release. Docs deployed to GitHub Pages on push to `docs/`.
See `.github/workflows/`.

## Architecture (R14, ADR-012)

FirecREST is the **only production HPC transport**. dsh runs on the
laptop. All HPC operations — Job submission, file access, tool
execution — go through FirecREST's REST API. No SSH, no VPN. OIDC
(JWT Bearer token) for authentication.

- `--backend firecrest` (default): Production. Laptop + FirecREST.
- `--backend dev`: Development only. dsh-adapter wraps local
  subprocess. Synchronous execution possible. EnvironmentService
  active. NOT a production path (FP-INV-2).

Key R14 consequences:
- All ToolInvocations are parallel in production (F-INV-6).
- uenv is loaded in Job scripts, not by cera (F-INV-5).
- EnvironmentService is optional — not passed to ToolInvocationService
  in production (FP-INV-3).
- SLURM CLI implementation (scheduling/) is dev-only (FP-INV-4).
- `createCeraSystem()` in `src/startup.ts` wires all 7 modules based
  on the selected backend.

## dsh dependency pinning

dsh is in developer preview with breaking-change warnings (ADR-005).
The `dsh-adapter` module is the ONLY module that imports dsh. When
upgrading dsh, update only `dsh-adapter` and run the full test suite
(Tier 3).

## Specs

All spec artifacts live in `specs/`:
- `specs/domain-model.md` — entities, aggregates, bounded contexts
- `specs/ubiquitous-language.md` — domain glossary
- `specs/invariants.md` — invariants (INV-*) for local backend
- `specs/invariants-firecrest-primary.md` — invariants under R14
- `specs/failure-modes.md` — failure scenarios for local backend
- `specs/failure-modes-firecrest-primary.md` — failure modes under R14
- `specs/resolutions.md` — domain expert resolutions R1-R13
- `specs/resolutions-r14.md` — R14: FirecREST as only production transport
- `specs/assumptions.md` — assumptions log
- `specs/features/*.feature` — Gherkin behavioral specs
- `specs/firecrest/` — FirecREST-specific invariants, failure modes, assumptions, API contracts
- `specs/architecture/` — module graph, API contracts, dependency graph, enforcement map, error taxonomy, build phases, ADRs (001-012)
- `specs/cross-context/interactions.md` — integration points between contexts
- `specs/fidelity/` — test depth per invariant (auditor)
- `specs/integration/SUMMARY.md` — integration verification summary
- `specs/findings/` — adversary review findings (FCREST-01–08, R14-01–17)
- `specs/escalations/` — spec gaps, architecture conflicts, invariant ambiguities

## Project state

**All 5 implementation phases + R14 refactor complete.** 886 tests.

| Phase | Module | Tests | Status |
|-------|--------|-------|--------|
| 1 | dsh-adapter | 162 | Complete (dev-only) |
| 2 | scheduling, environment-management, provenance | 239 | Complete (scheduling + env are dev-only) |
| 3 | data-management | 90 | Complete |
| 4 | tool-invocation (incl. CESM) | 133 | Complete (R14: all parallel, optional Env) |
| 5 | agent-interaction (Session, Experiment, Workflow, Action) | 107 | Complete |
| Post | firecrest-adapter | 115 | Complete (production) |
| Post | property tests + integration tests | 11 | Complete |
| Post | R14 refactor (startup, job-script-config) | 29 | Complete |
| **Total** | **8 modules + startup** | **886** | **All green** |

## Workflow roles

| Role | Output scope |
|------|-------------|
| Analyst | Specs only (domain model, invariants, Gherkin) |
| Architect | Structure only (interfaces, contracts, ADRs, module graph) |
| Adversary | Findings only (flaws, gaps, inconsistencies). Read-only. |
| Implementer | Code within architect boundaries (TDD + BDD) |
| Auditor | Measurement + correctness judgment (depth, falsifiability) |
| Integrator | Integration tests at cross-context seams |
