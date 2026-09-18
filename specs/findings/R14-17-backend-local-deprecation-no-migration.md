## Finding: `--backend local` deprecation has no migration documentation
Severity: Low
Category: Correctness > Semantic drift; Documentation
Location: `src/cli.ts` lines 117–120; `specs/resolutions-r14.md` R14.7; `specs/architecture/build-phases-firecrest.md` Phase A
Spec reference: R14.7 (--backend defaults to firecrest; dev replaces local)

### Description

R14.7 states: "There is no `--backend local` flag in production —
`dev` replaces `local` as the development mode identifier."

The CLI (`src/cli.ts` lines 117–120) correctly rejects `--backend
local` with a clear error message:
```
Unknown backend: 'local'. Use 'firecrest' (production) or 'dev' (development only).
```

However, there is **no migration documentation** for existing users
who have `--backend local` in scripts, aliases, or documentation.
The build phases (Phase A) mention "Remove `--backend local` from
help text" but do not mention:
1. A deprecation warning in a transitional release (e.g., "`--backend
   local` is deprecated, use `--backend dev` instead.")
2. A migration section in `docs/getting-started.md` or `README.md`
3. A note in `AGENTS.md` about the breaking change

The current behavior is a **hard error** (process.exit(1)), which
is appropriate for a clean break but could confuse existing users
who update cera and find their scripts no longer work.

### Evidence

1. `src/cli.ts` lines 117–120: hard error for unknown backend.
2. `specs/resolutions-r14.md` R14.7: "dev replaces local as the
   development mode identifier."
3. `specs/architecture/build-phases-firecrest.md` Phase A (lines
   24–34): mentions removing `--backend local` from help text, no
   migration documentation.
4. No `MIGRATION.md` or equivalent in the spec tree.

### Suggested resolution

Add a migration note to Phase F (Documentation Update) specifying:
(a) a brief migration section in `docs/getting-started.md` ("If you
previously used `--backend local`, use `--backend dev` instead."),
(b) optionally, a transitional release that prints a deprecation
warning for `--backend local` before making it a hard error.
