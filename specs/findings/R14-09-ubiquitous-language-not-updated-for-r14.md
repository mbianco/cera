## Finding: Ubiquitous language not updated for R14 — stale entries contradict production path, new terms missing
Severity: High
Category: Correctness > Semantic drift; Specification compliance
Location: `specs/ubiquitous-language.md` (entire file); `specs/architecture/build-phases-firecrest.md` Phase F (lines 505–567)
Spec reference: R14.1, R14.3, R14.7; ADR-012; ubiquitous-language.md §A–Z

### Description

The R14 refactor introduces fundamental changes to where cera runs
(laptop, not login node), how environments are loaded (Job scripts,
not cera), and what transport is used (FirecREST, not local
subprocess). The ubiquitous language (`ubiquitous-language.md`) was
not updated and contains multiple entries that now **contradict the
R14 production path**.

**Stale entries:**

1. **"Login Node"** (line 196–197): "The Agent runs on login or
   service nodes." Under R14, the Agent runs on the laptop in
   production. The resolutions-r14.md (R14.1) explicitly says: "The
   `Login Node` ubiquitous-language entry is re-evaluated." But the
   actual file was not updated.

2. **"Module (Software Module)"** (lines 201–205): "A unit of
   software packaging managed by a module system (Lmod, Environment
   Modules, or Spack). Loaded via `module load <name>/<ver>`."
   Under R14 (and R9 before it), the module system is uenv, not
   Lmod. Loading is via `uenv start <spec> --` in Job scripts, not
   `module load` on the login node.

3. **"Job"** (lines 177–181): "Short CLI Tool invocations may execute
   synchronously without a Job." Under R14, all ToolInvocations are
   Jobs in production (F-INV-6). Synchronous execution is dev-only.

**Missing new terms (used extensively in R14 specs but not in the
glossary):**

4. **FirecREST** — the only production HPC transport. Referenced
   100+ times across R14 specs. No glossary entry.
5. **BackendType** — `'firecrest' | 'dev'`. Defined in
   `api-contracts-firecrest.md` and `src/startup.ts`. No glossary
   entry.
6. **CeraSystem** — fully-wired system aggregate. Defined in
   `api-contracts-firecrest.md` and `src/startup.ts`. No glossary
   entry.
7. **CeraSystemConfig** — configuration for `createCeraSystem()`. No
   glossary entry.
8. **JobScriptConfig** — uenv specs and default ResourceRequest for
   Job scripts. No glossary entry.
9. **BackendSelection** — selects backend at startup. No glossary
   entry.
10. **JWT** — JSON Web Token, the authentication mechanism for
    FirecREST. Referenced extensively. No glossary entry.
11. **OIDC** — OpenID Connect, the token provider protocol. No
    glossary entry.
12. **uenv** — user environments (squashfs mounts). Referenced
    extensively in R14 specs. The term appears in the glossary only
    as part of the "Module (Software Module)" entry, which still
    says Lmod.

**Build phases gap:** Phase F (Documentation Update,
`build-phases-firecrest.md` lines 505–567) mentions updating
`README.md`, `docs/getting-started.md`, `AGENTS.md`, and JSDoc
comments — but **does not mention updating
`ubiquitous-language.md`**.

### Evidence

1. `specs/ubiquitous-language.md` line 196: "Login Node — The Agent
   runs on login or service nodes."
2. `specs/ubiquitous-language.md` line 204: "Module — Loaded via
   `module load <name>/<ver>`."
3. `specs/ubiquitous-language.md` line 181: "Short CLI Tool
   invocations may execute synchronously without a Job."
4. `specs/resolutions-r14.md` R14.1: "The `Login Node`
   ubiquitous-language entry is re-evaluated" — but the file was not
   updated.
5. `specs/architecture/build-phases-firecrest.md` Phase F (lines
   505–567): no mention of `ubiquitous-language.md`.
6. `src/startup.ts` line 57: `export type BackendType = 'firecrest'
   | 'dev';` — not in glossary.
7. `src/startup.ts` line 175: `export interface CeraSystem {` — not
   in glossary.

### Suggested resolution

Add `ubiquitous-language.md` to Phase F. Update the stale entries
(Login Node, Module, Job). Add new entries for FirecREST,
BackendType, CeraSystem, CeraSystemConfig, JobScriptConfig,
BackendSelection, JWT, OIDC, and uenv. Ensure every new term
introduced by R14 has a glossary entry with a clear definition and
[CORE] / [LEGACY] tag.
