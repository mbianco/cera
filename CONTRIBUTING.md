# Contributing to cera

## Development setup

```bash
git clone git@github.com:mbianco/cera.git
cd cera
npm install
```

**Requirements:**
- Node.js 22+
- npm (or pnpm)

No HPC system is required for development — all tests run locally with mocked dsh-adapter interfaces.

## Coding standards

- **TypeScript strict mode** — no `any` in public signatures, no unchecked indexed access, no implicit returns
- **Private fields** — use `#` (true JS private), not the `private` keyword
- **No `TODO` / `FIXME`** — if you find one, file an issue or fix it immediately
- **Branded IDs** — use branded types from `src/types/value-objects.ts` (e.g., `DatasetId`, `JobId`) to prevent mixing IDs across entities
- **Immutability** — domain entities are frozen (`Object.freeze`). Mutations create new frozen objects.
- **ESLint** — zero warnings allowed (`--max-warnings=0`)

## Testing

### BDD-then-TDD

1. **BDD red first.** A Gherkin scenario scopes what's next. The scenario MUST assert on observable artifacts a stub would not produce — file rows, event payloads, persisted records, exit codes. "Returns success" is not depth.
2. **TDD inside.** For each step needing new code: failing test → minimal code → green → refactor.
3. **BDD green closes.** If the Gherkin still fails after the TDD cycles, the assumed architecture is wrong — revisit the spec, don't paper over.

### Three test tiers

| Tier | What | When |
|------|------|------|
| 1 (fast) | `npx vitest run --exclude tests/integration/** --exclude tests/property/**` | Between every edit, pre-commit |
| 2 (slow) | `npx vitest run --exclude tests/integration/**` + integration tests | Pre-PR |
| 3 (full) | `npx vitest run --coverage` | Pre-merge, nightly |

Run `make` (no target) before every commit: lint + typecheck + Tier 1.

### Test organization

- `tests/<module>/` — unit tests for each module (mocked dependencies)
- `tests/integration/` — integration tests (real modules + mock dsh-adapter)
- `tests/property/` — property-based tests (fast-check, thousands of cases)
- `tests/<module>/helpers.ts` — mock factories for each module's dependencies

## PR process

1. **Run `make` before creating a PR** — lint, typecheck, and Tier 1 must all pass
2. **Run `make test-slow` before requesting review** — integration tests and coverage must pass
3. **CI runs automatically** — Tier 1 on every push, Tier 2 on PR
4. **Squash merge** to main — CI tags releases, don't `git tag` by hand
5. **Update specs** if the PR changes the domain model, invariants, or architecture
6. **Update README** if the PR changes setup, build, or test commands

## Workflow (agent-assisted development)

cera uses a diamond workflow: `analyst → architect → implementer → integrator` with adversarial gates. See `AGENTS.md` for the project-level workflow router.

| Role | Output scope |
|------|-------------|
| Analyst | Specs only (domain model, invariants, Gherkin) |
| Architect | Structure only (interfaces, contracts, ADRs, module graph) |
| Adversary | Findings only (flaws, gaps, inconsistencies). Read-only. |
| Implementer | Code within architect boundaries (TDD + BDD) |
| Auditor | Measurement + correctness judgment (depth, falsifiability) |
| Integrator | Integration tests at cross-context seams |

## Escalations

If you find a spec gap, architecture conflict, or invariant ambiguity, write to `specs/escalations/` and continue with other work. The escalated-to role addresses the issue, marks it RESOLVED, and you resume from the escalation point.

## dsh dependency pinning

`@deepseek-ai/dsh` is pinned to an exact version in `package.json` (no `^` or `~`). dsh is in developer preview with breaking-change warnings (ADR-005). The `dsh-adapter` module is the ONLY module that imports dsh. When upgrading dsh, update only `dsh-adapter` and run the full test suite (Tier 3).
