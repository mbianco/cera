## Finding: INV-T5 classification contradicts enforcement map — RE-EVALUATED vs UNCHANGED
Severity: High
Category: Correctness > Semantic drift; Invariant consistency
Location: `specs/invariants-firecrest-primary.md` lines 97–134 (INV-T5); `specs/architecture/enforcement-map-firecrest.md` line 24 (INV-T5)
Spec reference: INV-T5 (signal vs. exit-code distinction)

### Description

`invariants-firecrest-primary.md` classifies INV-T5 as
**RE-EVALUATED** (line 99): "Signal information comes from SLURM via
the FirecREST API, not from the local OS process status."

`enforcement-map-firecrest.md` line 24 classifies the same invariant
as **UNCHANGED**: "Signal vs exit-code distinction | Job terminal
state and exit code are parsed from FirecREST response. SLURM timeout
→ SIGTERM → signal. OOM → OUT_OF_MEMORY → signal. | Same — local
subprocess | UNCHANGED"

These two R14 spec documents directly contradict each other. The
invariants document defines RE-EVALUATED as "still holds, but
enforcement mechanism changes." INV-T5's enforcement mechanism
clearly changes (from local OS process status to SLURM via
FirecREST), so RE-EVALUATED is the correct classification. The
enforcement map's UNCHANGED is wrong.

This matters because implementers use the enforcement map to decide
which tests need modification. If INV-T5 is UNCHANGED, an
implementer might assume existing signal-handling tests don't need
updating. But they do — the source of signal information changes
from `SubprocessRunner` (local) to `FirecRESTSchedulingService`
(SLURM via REST).

### Evidence

1. `invariants-firecrest-primary.md` line 99: `**Classification:
   RE-EVALUATED**`
2. `invariants-firecrest-primary.md` lines 126–134: Tests that check
   local process signals → `@dev-only`. Tests that check Job states
   → `@production` (add if not present).
3. `enforcement-map-firecrest.md` line 24: `| INV-T5 | ... |
   UNCHANGED |`
4. `invariants-firecrest-primary.md` summary table line 677: `INV-T5
   | C1 | RE-EVALUATED |`

### Suggested resolution

Update `enforcement-map-firecrest.md` line 24 to classify INV-T5 as
RE-EVALUATED, consistent with `invariants-firecrest-primary.md`.
