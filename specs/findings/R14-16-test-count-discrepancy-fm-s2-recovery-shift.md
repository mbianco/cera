## Finding: Test count discrepancy and FM-S2 recovery class meaning shift under R14
Severity: Low
Category: Robustness > Observability gaps; Documentation
Location: `specs/impact-analysis.md` line 548 (Total: ~772); `AGENTS.md` (742 tests); `specs/failure-modes-firecrest-primary.md` lines 396–428 (FM-S2 DEV-ONLY); `specs/failure-modes.md` lines 243–262 (FM-S2 original)
Spec reference: FM-S2 (SLURM daemon unavailable); R14.5 (tests reclassified)

### Description

**Issue 1: Test count discrepancy.** `impact-analysis.md` line 548
says "Total: ~772" tests, but `AGENTS.md` says "742 tests across 7
modules." The impact analysis acknowledges this: "may differ
slightly from the AGENTS.md count of 742 due to property and
integration tests added in post-audit." While the difference is
explained, the two numbers create ambiguity about the actual test
count. The AGENTS.md should be updated to reflect the actual count
after R14 test reclassification (which adds ~18 new tests,
potentially making the total ~760).

**Issue 2: FM-S2 recovery class meaning shift.** The original
`failure-modes.md` FM-S2 (lines 246–261) says recovery class is
"degradable (synchronous tools still work; running Jobs continue on
compute nodes)." The key qualifier is "synchronous tools still work"
— in the original architecture, synchronous ToolInvocations run on
the login node and don't use SLURM, so they continue even when
SLURM is down.

Under R14, FM-S2 is classified as DEV-ONLY (line 397). In
production, the equivalent is FM-F-4 (FirecREST server
unavailable). But FM-F-4's recovery class is "degradable (running
Jobs on HPC continue; cera can cache last-known states) → fatal
(if prolonged)." There is **no "synchronous tools still work"
qualifier** — because there are no synchronous tools in production.

The shift in the meaning of "degradable" is not explicitly
documented. A reader comparing FM-S2 (original) and FM-F-4 (R14)
might assume the recovery behavior is the same, when in fact a
whole class of operations (synchronous tools) no longer exists in
production. The R14 docs say FM-S2 is DEV-ONLY and FM-F-4 is
PRODUCTION-ONLY, but don't call out that the "degradable"
classification has a different operational meaning under each.

### Evidence

1. `specs/impact-analysis.md` line 548: "Total: ~772"
2. `AGENTS.md`: "742 tests across 7 modules"
3. `specs/failure-modes.md` lines 246–247: "degradable (synchronous
   tools still work; running Jobs continue on compute nodes)"
4. `specs/failure-modes-firecrest-primary.md` lines 808–815: FM-F-4
   "degradable (running Jobs on HPC continue; cera can cache
   last-known states)" — no "synchronous tools still work."

### Suggested resolution

(a) Update `AGENTS.md` with the actual test count after R14
reclassification, or add a note pointing to `impact-analysis.md` for
the current count. (b) Add a note in `failure-modes-firecrest-primary.md`
FM-S2 section: "Note: Under R14, there are no synchronous
ToolInvocations in production. The 'synchronous tools still work'
qualifier in the original FM-S2 no longer applies. FM-F-4's
'degradable' classification refers only to running HPC Jobs, not to
any local execution path."
