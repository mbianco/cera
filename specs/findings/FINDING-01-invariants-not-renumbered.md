## Finding: invariants.md still uses C2/INV-M IDs while architecture references INV-T6–T9
Severity: Critical
Category: Correctness > Specification compliance
Location: specs/invariants.md (lines 90–142, 404–435); specs/architecture/enforcement-map.md (lines 7–9, 70–112, 359–362); specs/architecture/error-taxonomy.md (lines 30–33, 134–176); specs/architecture/api-contracts.md (lines 655–673)
Spec reference: resolutions.md R1; ADR-001 (invariant renumbering table)

### Description

resolutions.md R1 states: "INV-M1 through INV-M4 remain valid but
are renumbered as C1 invariants (INV-T6 through INV-T9)." ADR-001
contains the full renumbering table. The architecture artifacts
(enforcement-map, error-taxonomy, api-contracts, module-graph,
build-phases) have been updated to reference INV-T6 through INV-T9.

However, the source invariants document (`specs/invariants.md`) has
**not been updated**. It still contains:

- A full "## C2 — Model Execution (CESM)" section (lines 90–142)
  with INV-M1, INV-M2, INV-M3, INV-M4 as separate C2 invariants.
- A summary table (lines 404–435) listing INV-M1 through INV-M4 under
  C2, not INV-T6 through INV-T9 under C1.

The enforcement-map.md references `invariants.md INV-T6 (formerly
INV-M1)`, `invariants.md INV-T7 (formerly INV-M2)`, etc. — but INV-T6
through INV-T9 **do not exist** in invariants.md. An implementer or
auditor cross-referencing the enforcement map against the invariant
source will find that 4 of the 9 C1 invariants (INV-T6–T9) have no
canonical definition, only indirect references in ADR-001 and the
architecture artifacts.

### Evidence

1. `grep -n "INV-T[6-9]" specs/invariants.md` returns zero matches.
2. `grep -n "INV-M" specs/invariants.md` returns the C2 section with
   INV-M1 through INV-M4 intact.
3. `grep -n "INV-T[6-9]" specs/architecture/enforcement-map.md`
   returns 8 matches, all referencing `invariants.md INV-Mx (now
   INV-Tx per R1)` — but the target IDs don't exist in invariants.md.
4. The enforcement-map.md header says "Total: 28 invariants (9 C1,
   4 C3, 4 C4, 3 C5, 4 C6, 4 C7)" — but invariants.md has 5 C1 +
   4 C2 + 4 C3 + 4 C4 + 3 C5 + 4 C6 + 4 C7 = 28, with 4 still under
   the stale C2 section.

### Suggested resolution

Analyst must update `specs/invariants.md` to:
1. Remove the "C2 — Model Execution (CESM)" section.
2. Move INV-M1–M4 into the C1 section, renumbered as INV-T6–T9.
3. Update the summary table to list all 9 invariants under C1 with
   no C2 entry.
4. Update all cross-references (domain-model.md C2 section, failure-
   modes.md C2 section, cross-context/interactions.md X5/X6/X9/X11,
   feature files referencing INV-M1–M4).
