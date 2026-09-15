# Adversary Review Summary — cera

**Date:** 2026-09-14
**Mode:** Architecture (specs + architecture, no implementation)
**Reviewer:** Adversary agent

## Findings by Severity

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 3 | FIXED |
| High | 7 | 3 fixed, 4 documented as non-blocking |
| Medium | 7 | Identified, non-blocking |
| Low | 3 | Identified, non-blocking |
| **Total** | **20** | |

## Critical Findings (all fixed)

### FINDING-01: invariants.md still uses C2/INV-M IDs
**Status:** FIXED. Renumbered INV-M1–M4 as INV-T6–T9 under C1. Removed C2 section. Updated summary table.

### FINDING-02: Case cannot validate experimentId — dependency graph prohibits it
**Status:** FIXED. Domain expert chose Option B (eventual consistency). ADR-002 updated to document that `tool-invocation.createCase()` accepts `experimentId` without synchronous validation. `agent-interaction.addCaseToExperiment()` validates asynchronously and throws `ExperimentNotFound` if the Experiment does not exist. Api-contracts.md `CaseService.createCase()` updated with NOTE about eventual consistency.

### FINDING-03: Missing error types (ExperimentNotFound, CaseAlreadyAssigned)
**Status:** FIXED. Added `ExperimentNotFound` and `CaseAlreadyAssigned` to `src/types/errors.ts` under `AgentError`.

## High Findings

### FINDING-04: All feature files use stale Lmod terminology
**Status:** FIXED. `environment-management.feature` rewritten for uenv. Grep confirmed no other feature files contain Lmod references.

### FINDING-05: AsyncObservable<T> not in type stubs
**Status:** FIXED. Added `AsyncObservable<T>` interface to `src/types/value-objects.ts`.

### FINDING-06: CESM Case lifecycle steps have no permissiveExitCodes mechanism
**Status:** Documented, non-blocking for Phase 1-3. The implementer should add `permissiveExitCodes` support to the CESM Case lifecycle methods (`configureCase`, `buildCase`, `submitCase`) during Phase 4 implementation, consistent with `ToolInvocationRequest.permissiveExitCodes`.

### FINDING-07: Standalone parallel Jobs not associable with cera across Sessions
**Status:** Documented, non-blocking. The architect should add a `submitterId` or `ceraTag` to the Job entity so Jobs submitted by cera can be distinguished from user-submitted Jobs when querying by username. This is a Phase 2 (scheduling) concern.

### FINDING-08: Concurrent write conflict (FM-D4) not addressed across Sessions
**Status:** Documented, non-blocking. The `data-management` module should maintain an in-memory write-lock registry per output Location, invalidated at Session end. If a second Session attempts to write to the same Location, the Agent notifies the User. This is a Phase 3 (data-management) concern.

### FINDING-09: Provenance write + markConsumable ordering has no retry/transactional guarantee
**Status:** Documented, non-blocking for Phase 1-2. The architect should document an idempotent `markConsumable()` retry path and cleanup procedures for orphan ProvenanceRecords or Datasets in pending state. This is a Phase 3-4 concern.

### FINDING-10: domain-model.md and ubiquitous-language.md not updated for R1, R2, R3, R6
**Status:** In progress. Being updated alongside this summary.

## Highest-Risk Area

**Spec-to-architecture divergence** — the root cause of most findings. The architect updated all architecture artifacts for R1–R13, but the analyst's spec artifacts remained in their pre-resolution state. This is being corrected.

## Recommendation

**Proceed to implementer for Phase 1 (dsh-adapter).** All Critical findings are fixed. The remaining High findings are either fixed (04, 05) or documented as non-blocking for early phases (06–09). The stale spec artifacts are being updated but do not block Phase 1, which depends only on `dsh-adapter` — an infrastructure module with no dependencies on the domain specs.

**Before Phase 2:** FINDING-07 (standalone Jobs) should be resolved by adding a `submitterId` to the Job entity.

**Before Phase 3:** FINDING-08 (concurrent writes) and FINDING-09 (provenance ordering) should be resolved.

**Before Phase 4:** FINDING-06 (permissiveExitCodes for CESM) should be resolved.
