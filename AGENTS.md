# cera — AGENTS.md

**Language:** TypeScript (strict mode, ES modules, target ES2022)

**Build system:** tsdown (build), vitest (test), eslint (lint), tsc (typecheck)

## Commands

| Command | Purpose | Tier |
|---------|---------|------|
| `pnpm build` | Build with tsdown → `dist/` | — |
| `pnpm test` | Run all tests (vitest) | 1 (fast) |
| `pnpm test:fast` | Quick subset — between every edit, pre-commit | 1 (fast) |
| `pnpm lint` | ESLint — zero warnings allowed | — |
| `pnpm typecheck` | `tsc --noEmit` | — |

Default (`pnpm test && pnpm lint && pnpm typecheck`) before every commit.

## dsh dependency pinning

`@deepseek-ai/dsh` is pinned to an exact version in `package.json` (no `^` or `~`).
This is critical — dsh is in developer preview with breaking-change warnings
(assumptions.md A1, ADR-005). The `dsh-adapter` module is the ONLY module that
imports dsh. When upgrading dsh, update only `dsh-adapter` and run the full
test suite (Tier 3).

## Specs

All spec artifacts live in `specs/`:
- `specs/architecture/` — module graph, API contracts, dependency graph, ADRs, build phases
- `specs/invariants.md` — invariants (INV-*) that must not be violated
- `specs/resolutions.md` — domain expert resolutions (R1-R13)
- `specs/assumptions.md` — assumptions log (A1, V1-V5, U1-U9)
- `specs/fidelity/INDEX.md` — test depth per invariant

## Current phase

Phase 1: `dsh-adapter` — isolation layer between dsh and cera domain interfaces.
See `specs/architecture/build-phases.md` for the full phase plan.
