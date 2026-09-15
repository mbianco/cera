## Finding: domain-model.md and ubiquitous-language.md not updated for R1, R2, R3, R6
Severity: High
Category: Correctness > Semantic drift
Location: specs/domain-model.md (lines 33–48, 106–118, 142–162, 209, 277–296); specs/ubiquitous-language.md (lines 109–113, 244–248, 335–339)
Spec reference: resolutions.md R1, R2, R3, R6

### Description

resolutions.md states (line 4): "These resolutions supersede any
conflicting content in the original spec artifacts." However, the
primary spec artifacts have not been updated to reflect the
resolutions. The architecture artifacts (module-graph, api-
contracts, enforcement-map, error-taxonomy, type stubs, ADRs)
**have** been updated, creating a divergence between the analyst's
spec artifacts and the architect's artifacts.

### Specific divergences

**R1 (CESM is a Tool, C2 collapses):**
- domain-model.md still has a full "### C2 — Model Execution"
  section (lines 33–48) and a "Aggregate: Case" section (lines
  142–162) attributed to C2.
- The entity reference table (lines 247–274) lists Case under C2.
- The "Open Modeling Questions" section (lines 277–296) still
  lists question #2 ("Is CESM a Tool or a peer entity?") as
  open — resolved by R1.
- ubiquitous-language.md "Case (CESM)" entry (line 39) says
  "[LEGACY]" but doesn't reflect that Case is now in C1.

**R2 (Experiment is first-class):**
- domain-model.md C7 owned entities (line 112) list "Session,
  User, Workflow (the expression of intent), Workflow State
  (CANDIDATE)" — no Experiment.
- The entity reference table (lines 247–274) has no Experiment
  entry.
- ubiquitous-language.md "Experiment" entry (line 112) still says
  "[CANDIDATE]" — should be [CORE].

**R3 (Action replaces Operator):**
- ubiquitous-language.md "Operator (Agent — CANDIDATE)" entry
  (lines 244–248) still says "[CANDIDATE]" — should be replaced by
  "Action [CORE]".
- domain-model.md C7 section has no mention of Action.

**R6 (WorkflowState validated):**
- domain-model.md (line 209): "WorkflowState (CANDIDATE)" — should
  be [VALIDATED] or removed.
- ubiquitous-language.md "State (Workflow State) — [CANDIDATE]"
  (lines 335–339) — should be [CORE] or [VALIDATED].

### Evidence

1. `grep -n "CANDIDATE" specs/domain-model.md` → 4 matches, all
   for items resolved by resolutions.md.
2. `grep -n "CANDIDATE" specs/ubiquitous-language.md` → 5 matches,
   all for items resolved by resolutions.md.
3. `grep -n "Experiment" specs/domain-model.md` → Experiment only
   appears in Open Modeling Questions as [CANDIDATE], not as an
   owned entity.

### Suggested resolution

Analyst must update domain-model.md and ubiquitous-language.md to
reflect R1–R3, R6. At minimum:
1. Remove or collapse the C2 section in domain-model.md.
2. Add Experiment and Action to C7 owned entities.
3. Update all [CANDIDATE] → [CORE] / [VALIDATED] per resolutions.
4. Remove resolved questions from the Open Modeling Questions
   section.
