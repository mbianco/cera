# R14 Adversary Review Summary — FirecREST-Only Primary Architecture

**Date:** 2026-09-18
**Mode:** Implementation (R14 refactor specs + source code under review)
**Reviewer:** Adversary agent
**Scope:** `resolutions-r14.md`, `invariants-firecrest-primary.md`,
`failure-modes-firecrest-primary.md`, `ADR-012.md`, `impact-analysis.md`,
`module-graph-firecrest.md`, `api-contracts-firecrest.md`,
`build-phases-firecrest.md`, `enforcement-map-firecrest.md`,
`src/startup.ts`, `src/cli.ts`

## Findings by Severity

| Severity | Count | IDs |
|----------|-------|-----|
| Critical | 3 | R14-01, R14-02, R14-03 |
| High | 6 | R14-04, R14-05, R14-06, R14-07, R14-08, R14-09 |
| Medium | 6 | R14-10, R14-11, R14-12, R14-13, R14-14, R14-15 |
| Low | 2 | R14-16, R14-17 |
| **Total** | **17** | |

## Critical Findings (block implementer)

### R14-01: ProvenanceRecord Environment identity is a placeholder, not the uenv spec
INV-P2 (full reproducibility tuple) requires "Environment identity (all
Modules with versions)" in every ProvenanceRecord. The R14 spec says the
identity should be the uenv spec embedded in the Job script. The existing
code (`tool-invocation-service.ts` lines 597–598) uses a static
placeholder `'firecrest-backend'` instead. The build phases (Phase B)
never mention updating this placeholder. **Impact:** every
ProvenanceRecord under the FirecREST backend violates INV-P2 —
reproducibility is lost because the Environment identity is identical for
all ToolInvocations regardless of which uenv was actually used.

### R14-02: `--uenv-specs` is optional in the CLI but F-INV-5 and INV-E1 require uenv in every Job
R14.3 says "uenv is always loaded in Job scripts." F-INV-5 (elevated to
primary) says "uenv is loaded in Job scripts, not by cera." INV-E1
(re-evaluated) says "Each Job has exactly one Environment." But the CLI
and API contracts make uenv specs optional (`JobScriptConfig.uenvSpecs?`).
If `--uenv-specs` is not provided, Jobs are submitted with no uenv,
violating F-INV-5, INV-E1, and INV-T1. **Impact:** production Jobs may
run without the required Environment, causing Tool failures or
incorrect results.

### R14-03: FirecREST outage → ProvenanceRecord write cascade — unbounded, breaks "degradable"
When FirecREST goes down (FM-F-4) and a Job completes on the HPC,
cera cannot write the ProvenanceRecord (F-INV-7 requires FirecREST
filesystem). The output Dataset is stuck in an unregistered state
(INV-D3 violated if registered). FM-F-4 is classified "degradable"
and FM-P1 is "recoverable; fatal if all retries fail" — but during a
prolonged FirecREST outage, all retries fail, making the combined
scenario fatal with no time bound. The 30-minute UNKNOWN policy (R13)
applies to Job state queries, not ProvenanceRecord writes.
**Impact:** completed HPC work is stuck indefinitely during FirecREST
outages; scientific integrity is at risk.

## High Findings (should resolve before merge)

### R14-04: INV-T5 classification contradicts enforcement map
`invariants-firecrest-primary.md` says RE-EVALUATED;
`enforcement-map-firecrest.md` says UNCHANGED. Direct contradiction
between two R14 spec documents. Implementers using the enforcement
map may not update signal-handling tests.

### R14-05: Invariant summary counts are arithmetically wrong
Summary says 17 UNCHANGED + 11 RE-EVALUATED = 28 (plus 4+1+5 = 38),
but the table has 40 entries. Correct counts: 21 UNCHANGED, 9
RE-EVALUATED. 2-invariant discrepancy.

### R14-06: `--backend dev` on login node bypasses FirecREST security
No runtime warning or guard for `--backend dev` in production-like
environments. On an HPC login node with dsh, all HPC operations bypass
FirecREST (no JWT, no audit trail, no timeout). FP-INV-2 enforcement is
documentation-only.

### R14-07: FP-FM-2 (laptop crash) — Job discovery mechanism unclear
After a laptop crash, Session state (including JobIDs) is lost.
`queryJobsByUser()` returns all Jobs for the user — no way to
distinguish cera-submitted Jobs from manual `sbatch` Jobs. Username
derivation from JWT is not implemented (no `getUsername()` on
`JwtTokenProvider`). Proactive Job reporting (R7) is broken without it.

### R14-08: In-flight `invokeTool()` during FirecREST outage — blocking undefined
The poll loop (lines 980–992) blocks for up to 1000 iterations ×
pollIntervalMs (potentially hours) during a FirecREST outage. No
timeout on `invokeTool()` itself. The agent loop is blocked. The spec
doesn't specify maximum blocking duration or a "Job status unknown"
return state.

### R14-09: Ubiquitous language not updated for R14
Stale entries: "Login Node" (Agent runs on login — wrong), "Module"
(Lmod + `module load` — wrong, now uenv), "Job" (synchronous without
Job — wrong, all Jobs now). Missing: FirecREST, BackendType,
CeraSystem, CeraSystemConfig, JobScriptConfig, BackendSelection, JWT,
OIDC. Build phases Phase F doesn't mention updating
`ubiquitous-language.md`.

## Medium Findings (non-blocking but should address)

### R14-10: `--client-secret` visible in `ps` output
CLI accepts secret as argument, no explicit warning about `ps`
visibility. Help text says "prefer env var" passively.

### R14-11: INV-T7, INV-T9 classified UNCHANGED but enforcement changes
Body text explicitly says mechanism changes (local squeue → FirecREST,
local fs → FirecREST stat). By the document's own definition, these
should be RE-EVALUATED. Enforcement map classifies INV-T7 as
RE-EVALUATED — contradicts the invariants doc.

### R14-12: FM-F-9 doesn't fully cover INV-E2 (conflicting Modules)
FM-F-9 covers uenv not existing. FM-E2 (CRITICAL) covers uenv
conflicts (both exist, incompatible). The replacement doesn't cover
the conflict scenario as clearly. Static validation is optional
("may"), weakening a CRITICAL invariant.

### R14-13: Username derivation from JWT not specified or implemented
`CeraSystemConfig.username` documented as "derived from JWT
`preferred_username`" but no mechanism in `JwtTokenProvider` or
`createCeraSystem()`. CLI sets `username: undefined`. Proactive Job
reporting (R7) and FP-FM-2 recovery are broken without it.

### R14-14: CLI validation gaps
No schema validation for `--default-resource-request` (any JSON
accepted). No `CERA_DEFAULT_RESOURCE_REQUEST` env var (inconsistent
with all other flags). No uenv spec format validation. No limit on
number of uenv specs (resource exhaustion — Job script could exceed
SLURM limits). `defaultResourceRequest` passed redundantly in both
`firecrestConfig` and `jobScriptConfig`.

### R14-15: BackendSelection not a discriminated union
Interface allows `{ type: 'firecrest' }` without `firecrestConfig` at
compile time — fails only at runtime. A discriminated union would
catch this at compile time.

## Low Findings (documentation polish)

### R14-16: Test count discrepancy + FM-S2 recovery semantics shift
`impact-analysis.md` says ~772 tests; `AGENTS.md` says 742. FM-S2
"degradable (synchronous tools still work)" — the qualifier no longer
applies in production (no synchronous tools), but this shift is not
explicitly documented.

### R14-17: `--backend local` deprecation has no migration documentation
Hard error for `--backend local`, but no migration section in docs
or transitional deprecation warning for existing users.

## Highest-Risk Area

**The ProvenanceRecord ↔ FirecREST coupling** is the highest-risk area.
Under R14, ProvenanceRecords are written via FirecREST (F-INV-7), but
FirecREST outages (FM-F-4) make ProvenanceRecord writes impossible
(R14-03). This creates an unbounded "stuck" state for completed HPC
work, violating INV-D3 (Provenance before consumption) and potentially
INV-P2 (full reproducibility tuple). Additionally, the ProvenanceRecord
Environment identity is a static placeholder (R14-01), meaning
reproducibility is already compromised even when FirecREST is
available.

**Secondary risk: dev mode safety.** The `--backend dev` flag has no
runtime guard and can bypass all FirecREST security on an HPC login
node (R14-06). This is a security exposure that is documented as
"not a production path" but has no enforcement mechanism.

## Recommendation

**Three Critical findings block the implementer.** They must be
resolved before Phase B (tool-invocation modifications) begins:

1. **R14-01** (ProvenanceRecord placeholder): The architect must
   specify how the actual uenv specs are recorded in the
   ProvenanceRecord's Environment fields. This affects `tool-invocation`
   (Phase B) and `provenance` — the build phases must be updated.

2. **R14-02** (uenv-specs optional): The architect must decide
   whether `--uenv-specs` is required for the FirecREST backend, or
   whether the invariants (F-INV-5, INV-E1, INV-T1) must be weakened
   to allow Tools with no uenv. This affects the CLI (Phase A) and
   the Job script builder.

3. **R14-03** (ProvenanceRecord write cascade): The architect must
   specify a time-bounded recovery strategy for ProvenanceRecord
   writes during FirecREST outages. This affects the
   `invokeTool()` flow (Phase B) and potentially a new failure mode
   (FP-FM-3). Without this, the "degradable" classification of
   FM-F-4 is misleading.

**High findings should be resolved before merge** but do not block
Phase A (startup wiring). R14-07 (Job discovery) and R14-13
(username derivation) are related — both must be resolved before
proactive Job reporting (R7) works in production. R14-09
(ubiquitous language) should be added to Phase F.

**Medium and Low findings** are non-blocking. They can be
addressed during implementation or in a follow-up review.
