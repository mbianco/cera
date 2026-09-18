## Finding: INV-T7 and INV-T9 classified UNCHANGED but body text says enforcement mechanism changes
Severity: Medium
Category: Correctness > Invariant consistency
Location: `specs/invariants-firecrest-primary.md` lines 145–151 (INV-T7), 160–168 (INV-T9); `specs/architecture/enforcement-map-firecrest.md` line 26 (INV-T7)
Spec reference: INV-T7 (one running Job per Case); INV-T9 (output tree location known before submission)

### Description

The `invariants-firecrest-primary.md` document defines its own
classification scheme:

- **UNCHANGED** — text and enforcement are the same.
- **RE-EVALUATED** — still holds, but enforcement mechanism changes.

Several invariants are classified as UNCHANGED but their body text
explicitly says the enforcement mechanism changes:

**INV-T7 (One running Job per Case):**
Classification: UNCHANGED (line 147).
Body text (line 149–151): "SLURM (via FirecREST) is still the
authority. The Agent checks Job states via `GET
/compute/{system}/jobs/{id}`."
The enforcement mechanism changes from local `squeue` to FirecREST
REST API. By the document's own definition, this should be
RE-EVALUATED.

**INV-T9 (Output tree location known before submission):**
Classification: UNCHANGED (line 162).
Body text (lines 166–168): "the resolution mechanism changes from
local `fs.existsSync()` to FirecREST stat, but the invariant text
is unchanged."
The document explicitly acknowledges "the resolution mechanism
changes" but classifies as UNCHANGED. This is self-contradictory.

**Contrast with correctly classified invariants:**
- INV-T5 is RE-EVALUATED because "Signal information comes from
  SLURM via FirecREST API, not from the local OS process status."
- INV-D4 is RE-EVALUATED because "resolution mechanism changes from
  local filesystem to FirecREST stat endpoint."

If INV-T5 and INV-D4 are RE-EVALUATED because the source of
information changes, INV-T7 and INV-T9 should also be RE-EVALUATED
for the same reason.

**Impact:** The enforcement map (`enforcement-map-firecrest.md`
line 26) classifies INV-T7 as "RE-EVALUATED (transport)" —
contradicting the invariants document's UNCHANGED. This creates
confusion about which document is authoritative and whether tests
need updating.

### Evidence

1. `invariants-firecrest-primary.md` line 147: `**Classification:
   UNCHANGED**` (INV-T7)
2. `invariants-firecrest-primary.md` line 149: "The Agent checks Job
   states via `GET /compute/{system}/jobs/{id}`" — mechanism change.
3. `invariants-firecrest-primary.md` line 162: `**Classification:
   UNCHANGED**` (INV-T9)
4. `invariants-firecrest-primary.md` line 167: "the resolution
   mechanism changes from local `fs.existsSync()` to FirecREST stat"
   — explicit acknowledgment of mechanism change.
5. `enforcement-map-firecrest.md` line 26: `RE-EVALUATED (transport)`
   (INV-T7) — contradicts the invariants doc.

### Suggested resolution

Reclassify INV-T7 and INV-T9 as RE-EVALUATED in
`invariants-firecrest-primary.md`, consistent with the document's
own definition and with the enforcement map. Update the summary
counts accordingly (see R14-05 for the corrected counts).
