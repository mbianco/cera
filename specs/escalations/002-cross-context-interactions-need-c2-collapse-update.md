# Escalation 002: cross-context/interactions.md needs C2 collapse update

**From:** Architect
**To:** Analyst
**Date:** 2026-09-14
**Severity:** MEDIUM
**Status:** ESCALATED — needs spec update for consistency

## Context

The domain expert has confirmed (resolutions.md R1, ADR-001) that
CESM is a **complex Tool** in C1, not a peer entity in a separate
bounded context. C2 (Model Execution) **collapses into C1**
(Tool Invocation).

However, `cross-context/interactions.md` still references C2 as a
separate bounded context in several interactions:

- **X5** (C2↔C4): "CESM case.submit creates a Job" — should be
  C1↔C4 (a ToolInvocation delegating to Scheduling, same as X2).
- **X6** (C2↔C3): "CESM output tree becomes Datasets" — should be
  C1↔C3 (a ToolInvocation producing output Datasets, same as X3).
- **X9** (C5↔C2): "CESM has specific compiler/MPI requirements" —
  should be C5↔C1 (a Tool with specific Environment requirements,
  same as X1).
- **X11** (C7↔C2): "Agent translates User intent into CESM Case
  lifecycle" — should be C7↔C1 (a specialized ToolInvocation).

## Impact

The cross-context interaction document is internally inconsistent
with the resolutions and the architecture (which has no C2 module).
The architect has already updated the interaction flow in
dependency-graph.md and api-contracts.md, but
`cross-context/interactions.md` itself is stale.

## What needs to change

The analyst should:

1. Remove or merge X5 into X2 (both are now "ToolInvocation ↔
   Scheduling").
2. Remove or merge X6 into X3 (both are now "ToolInvocation ↔ Data
   Management").
3. Remove or merge X9 into X1 (both are now "ToolInvocation ↔
   Environment Management").
4. Remove or merge X11 into X10 (both are now "Agent Interaction ↔
   Tool Invocation").
5. Update the interaction registry table at the top of the file.
6. Update the "Cross-Cutting Scenarios" section to reference C1
   instead of C2.

Alternatively, the analyst may choose to keep X5, X6, X9, X11 as
**specialized variants** of X2, X3, X1, X10 respectively, with a
note that they describe CESM-specific behavior within C1. This is
acceptable as long as they are clearly labeled as intra-context
(C1) rather than cross-context (C2↔X).

## Blocking?

**No.** The architect has already designed the module graph,
dependency graph, and API contracts without C2. The inconsistency
is in the spec document only and does not block implementation.
However, it should be corrected before the auditor checks spec
consistency.
