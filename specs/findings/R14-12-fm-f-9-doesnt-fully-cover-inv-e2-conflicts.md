## Finding: FM-F-9 replaces FM-E2 (conflicting Modules) but doesn't cover the conflict scenario
Severity: Medium
Category: Correctness > Specification compliance; Failure cascades
Location: `specs/failure-modes-firecrest-primary.md` lines 516–545 (FM-E2 DEV-ONLY), 849–863 (FM-F-9); `specs/invariants-firecrest-primary.md` lines 340–383 (INV-E2 RE-EVALUATED)
Spec reference: INV-E2 (conflict detection before execution, CRITICAL); FM-E2 (conflicting Modules); FM-F-9 (uenv not available in Job script)

### Description

The R14 failure modes document classifies FM-E2 (Conflicting Modules)
as DEV-ONLY, "replaced by FM-F-9 variant in production" (line 517).
FM-F-9 is described as: "cera embeds a `uenv start <spec> --` command
in the Job script, but the specified uenv does not exist (or the
mount path is wrong, or the uenv is corrupted)" (lines 217–222 in
`specs/firecrest/failure-modes.md`).

**The gap:** FM-F-9 covers the case where a uenv **does not exist**
(or mount path is wrong, or uenv is corrupted). FM-E2 (the original)
covers a different scenario: two Modules (uenvs) that both exist but
**conflict** (same soname/path, different version).

Under R14, the INV-E2 re-evaluation (lines 340–383) says: "Conflict
detection still happens before the Tool command runs, but inside the
Job script (uenv's own mount-time conflict detection) rather than by
cera's `detectConflicts()` before Job submission."

This means:
1. cera submits a Job with two uenv specs (e.g., `cdo:2.0.5` and
   `python:3.11.6` where both provide a conflicting `libstdc++.so`).
2. The Job runs `uenv start cdo:2.0.5 -- uenv start python:3.11.6 --
   <tool command>`.
3. uenv's own mount-time detection may or may not catch the
   conflict. If it doesn't, the Tool runs and may segfault (the
   exact scenario INV-E2 was designed to prevent).

The spec says "cera may do static validation of uenv specs
(type-level, using the Conflict type)" — but this is **optional**
("may"). The original INV-E2 was CRITICAL severity, meaning
violation corrupts data or scientific validity. The R14 re-
evaluation weakens this to "best-effort static validation + hope
uenv catches it at mount time."

**Missing from the spec:**
1. What does "static validation" actually check? (Path-level?
   Type-level? What types?)
2. Does uenv's mount-time detection catch all conflicts that cera's
   `detectConflicts()` used to catch?
3. If uenv doesn't catch a conflict and the Tool segfaults, which
   failure mode applies? (FM-T1 (segfault) + FM-F-9 (uenv error)?
   But FM-F-9 is about uenv not existing, not conflicting.)
4. Is the "may do static validation" optional, or should it be
   required for INV-E2 to be considered preserved?

### Evidence

1. `failure-modes-firecrest-primary.md` line 517: "FM-E2 ...
   DEV-ONLY (replaced by FM-F-9 variant in production)"
2. `failure-modes-firecrest-primary.md` line 529: "A variant of
   FM-F-9 (uenv conflict error in Job script). The Job fails with a
   uenv conflict error in stderr."
3. `specs/firecrest/failure-modes.md` lines 217–222: FM-F-9 says
   "the specified uenv does not exist (or the mount path is wrong,
   or the uenv is corrupted)" — no mention of conflicts.
4. `invariants-firecrest-primary.md` lines 358–366: "cera may do
   static validation of uenv specs (type-level, using the Conflict
   type) but cannot do runtime conflict detection." The word "may"
   makes this optional.
5. `invariants.md` lines 268–278: original INV-E2, severity CRITICAL,
   "detected before a Tool runs, not at Tool runtime via a segfault."

### Suggested resolution

Either (a) add a separate failure mode (FP-FM-4) for "uenv conflict
not detected before Tool runs" that covers the case where uenv's
mount-time detection misses a conflict, or (b) clarify that FM-F-9
includes conflict errors (not just "not found" errors) and update
its description accordingly. Change "may do static validation" to
"shall do static validation" to preserve INV-E2's CRITICAL
intent.
