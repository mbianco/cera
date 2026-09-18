# Contributing to cera

## Development setup

```bash
git clone git@github.com:mbianco/cera.git
cd cera
npm install
```

**Requirements:**
- Node.js 24+ (built-in `fetch`, `AbortController`, ES2022)
- npm (or pnpm)

No HPC system is required for development — all tests run locally
with mocked FirecREST and dsh-adapter interfaces.

## Architecture (R14, ADR-012)

FirecREST is the **only production HPC transport**. dsh runs on the
laptop. The local backend (`--backend dev`) is for development only.

When contributing code:
- **Production path** (`--backend firecrest`): All ToolInvocations are
  parallel (F-INV-6). uenv is in Job scripts (F-INV-5).
  EnvironmentService is NOT used (FP-INV-3).
- **Dev path** (`--backend dev`): Synchronous execution is possible.
  EnvironmentService is active. SLURM CLI is used directly.
- **No existing module interface is changed.** Only implementations
  are selected at startup via `createCeraSystem()`.

See `specs/resolutions-r14.md` and `specs/architecture/adr/ADR-012.md`
for full details.

## Coding standards

- **TypeScript strict mode** — no `any` in public signatures, no
  unchecked indexed access, no implicit returns
- **Private fields** — use `#` (true JS private), not the `private`
  keyword
- **No `TODO` / `FIXME`** — if you find one, file an issue or fix it
  immediately
- **Branded IDs** — use branded types from `src/types/value-objects.ts`
  (e.g., `DatasetId`, `JobId`) to prevent mixing IDs across entities
- **Immutability** — domain entities are frozen (`Object.freeze`).
  Mutations create new frozen objects.
- **ESLint** — zero warnings allowed (`--max-warnings=0`)

## Testing

### BDD-then-TDD

1. **BDD red first.** A Gherkin scenario scopes what's next. The
   scenario MUST assert on observable artifacts a stub would not
   produce — file rows, event payloads, persisted records, exit codes.
2. **TDD inside.** For each step needing new code: failing test →
   minimal code → green → refactor.
3. **BDD green closes.** If the Gherkin still fails after the TDD
   cycles, the assumed architecture is wrong — revisit the spec.

### Three test tiers

| Tier | What | When |
|------|------|------|
| 1 (fast) | `npx vitest run --exclude "tests/integration/**" --exclude "tests/property/**"` | Between every edit, pre-commit |
| 2 (slow) | `npx vitest run --exclude "tests/integration/**"` + integration tests | Pre-PR |
| 3 (full) | `npx vitest run --coverage` | Pre-merge, nightly |

Run `make` (no target) before every commit: lint + typecheck + Tier 1.

### Test organization

- `tests/<module>/` — unit tests for each module (mocked dependencies)
- `tests/firecrest-adapter/` — FirecREST backend tests (production)
- `tests/integration/` — integration tests (real modules + mock dsh-adapter)
- `tests/property/` — property-based tests (fast-check)
- `tests/startup.test.ts` — `createCeraSystem()` backend selection tests
- `tests/tool-invocation/job-script-config.test.ts` — F-INV-6, FP-INV-5 tests
- Tests tagged `@dev-only` test the local backend (scheduling,
  environment-management) — they are NOT production-path tests.

## PR process

1. **Run `make` before creating a PR** — lint, typecheck, and Tier 1
   must all pass
2. **Run `make test-slow` before requesting review** — integration
   tests and coverage must pass
3. **CI runs automatically** — Tier 1 on every push, Tier 2 on PR
4. **Squash merge** to main — CI tags releases, don't `git tag` by hand
5. **Update specs** if the PR changes the domain model, invariants, or
   architecture
6. **Update README** if the PR changes setup, build, or test commands

## Escalations

If you find a spec gap, architecture conflict, or invariant ambiguity,
write to `specs/escalations/` and continue with other work. The
escalated-to role addresses the issue, marks it RESOLVED, and you
resume from the escalation point.

## dsh dependency pinning

dsh is in developer preview with breaking-change warnings (ADR-005).
The `dsh-adapter` module is the ONLY module that imports dsh. When
upgrading dsh, update only `dsh-adapter` and run the full test suite
(Tier 3).
