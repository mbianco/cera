## Finding: Invariant summary counts are arithmetically wrong (17+11+1+4+5≠40)
Severity: High
Category: Correctness > Specification compliance
Location: `specs/invariants-firecrest-primary.md` lines 714–718 (summary counts); lines 671–712 (summary table)
Spec reference: invariants-firecrest-primary.md §Summary Table, §Summary counts

### Description

The summary table in `invariants-firecrest-primary.md` (lines
671–712) lists 40 invariants: 28 original (INV-T1–T9, INV-D1–D4,
INV-S1–S4, INV-E1–E3, INV-P1–P4, INV-W1–W4) plus 7 F-INV
(F-INV-1–7) plus 5 FP-INV (FP-INV-1–5).

The summary counts at lines 714–718 are:

```
- UNCHANGED: 17
- RE-EVALUATED: 11
- REMOVED from production (DEV-ONLY): 1
- PRODUCTION-ONLY: 4
- NEW: 5
```

Total: 17 + 11 + 1 + 4 + 5 = **38** — but the table has **40**
entries. There is a 2-count discrepancy.

**Correct counts from the table:**

UNCHANGED (count each row with classification UNCHANGED):
INV-T2, T3, T4, T6, T7, T8, T9 (7) + INV-D1, D2, D3 (3) + INV-S2,
S3, S4 (3) + INV-P1, P2, P3, P4 (4) + INV-W1, W2, W3, W4 (4) = **21**

RE-EVALUATED:
INV-T1, T5 (2) + INV-D4 (1) + INV-S1 (1) + INV-E1, E2 (2) +
F-INV-1, F-INV-5, F-INV-6 (3) = **9**

REMOVED: INV-E3 = **1**
PRODUCTION-ONLY: F-INV-2, F-INV-3, F-INV-4, F-INV-7 = **4**
NEW: FP-INV-1–5 = **5**

Total: 21 + 9 + 1 + 4 + 5 = **40** ✓

The summary says 17 UNCHANGED (should be 21) and 11 RE-EVALUATED
(should be 9). The "+ 2 elevated" annotation in the RE-EVALUATED
line appears to be a miscount — the three F-INV entries that are
"elevated" (F-INV-1, F-INV-5, F-INV-6) are already counted in the
list.

### Evidence

1. Lines 671–712: 40 rows in the summary table.
2. Lines 714–718: counts sum to 38, not 40.
3. Manual recount: 21 UNCHANGED, 9 RE-EVALUATED, 1 REMOVED, 4
   PRODUCTION-ONLY, 5 NEW = 40.

### Suggested resolution

Update the summary counts to:
```
- UNCHANGED: 21
- RE-EVALUATED: 9
- REMOVED from production (DEV-ONLY): 1
- PRODUCTION-ONLY: 4
- NEW: 5
```
Remove the "+ 2 elevated" annotation from the RE-EVALUATED line.
