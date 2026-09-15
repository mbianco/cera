## Finding: ALL feature files use stale Lmod terminology in Background sections
Severity: High
Category: Correctness > Semantic drift
Location: specs/features/cdo-operations.feature (line 10); specs/features/nco-operations.feature (line 11); specs/features/cesm-submission.feature (line 10); specs/features/grid-conversion.feature (lines 15, 28, 45, 57, 72, 98, 109, 120); specs/features/zarr-io.feature (lines 11, 112); specs/features/job-management.feature (no env background — OK); specs/features/environment-management.feature (lines 11, 16, 26, 36, 47, 53, 83, 101, 108, 124); specs/features/workflow-execution.feature (line 11); specs/features/provenance.feature (lines 11, 26)
Spec reference: resolutions.md R9; ADR-003; escalation 001

### Description

Escalation 001 flags `environment-management.feature` as needing a
uenv rewrite — it uses `module load`, `module avail`, `module
spider`, `module purge`, has an `@lmod` tag, and describes
soname-level conflict detection.

However, the staleness extends far beyond `environment-management.
feature`. **Every** feature file that references an Environment in
its Background uses Lmod-specific terminology: "an Environment with
Modules '...' is loaded and verified conflict-free." Per R9 and
ADR-003, Alps uses uenv (squashfs mounts), not Lmod. Environments
are mounted, not "loaded." The term "Modules" refers to uenv
components, not Lmod modules.

Additionally, the conflict detection in
`environment-management.feature` (lines 73–77: "Detect conflicting
library sonames") uses soname-level detection, but R9 and ADR-003
specify filesystem path-level conflict detection.

### Evidence

1. `grep -rn "Modules.*is loaded" specs/features/` → 21 matches
   across 8 feature files (all except `job-management.feature` and
   `opengrads-evaluation.feature`).
2. `grep -rn "module load\|module avail\|module spider\|module
   purge" specs/features/` → 17 matches in
   `environment-management.feature` alone.
3. `environment-management.feature` line 11: "And the module system
   on the host is Lmod" — explicitly states Lmod, contradicting R9.
4. `environment-management.feature` line 73: "Detect conflicting
   library sonames" — soname-level, not path-level (R9).

### Suggested resolution

Escalation 001 covers `environment-management.feature` only. The
analyst must also update all other feature files' Background
sections to use uenv terminology. At minimum:
- Replace "an Environment with Modules '...' is loaded" with
  "an Environment with uenvs '...' is mounted"
- Replace soname-level conflict detection with path-level
- Update the `@lmod` tag to `@uenv`
