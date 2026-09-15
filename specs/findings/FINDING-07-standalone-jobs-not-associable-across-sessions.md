## Finding: Standalone parallel Jobs are not associable with cera across Sessions
Severity: High
Category: Correctness > Implicit coupling
Location: specs/architecture/api-contracts.md (lines 195–196, queryJobsByUser); specs/architecture/adr/ADR-007.md (lines 72–84, Job discovery); src/types/entities.ts (lines 235–245, Job entity)
Spec reference: resolutions.md R7; invariants.md INV-W4; ADR-007

### Description

R7 requires proactive Job reporting on Session start. ADR-007
describes the mechanism:

"Jobs are discoverable by JobID because:
1. SLURM does not cancel Jobs when the Agent's Session ends.
2. squeue -u <username> returns all active Jobs for the User.
3. sacct -j <jobId> returns historical data.
4. The persisted Workflow state (ADR-006) records which Job IDs
   were submitted by which Workflow steps, enabling the Agent to
   associate Jobs with Workflows across Sessions."

Point 4 only covers Jobs that are part of a Workflow. For
**standalone parallel ToolInvocations** (a CDO remap submitted to
SLURM without a Workflow), there is no persisted Workflow state to
associate them with cera. The `Job` entity has optional
`workflowId` and `caseId` — both null for standalone Jobs.

Furthermore, the ProvenanceRecord (X4) is written **upon
completion**, not upon submission. During a standalone Job's
execution, neither a ProvenanceRecord nor a Workflow entry exists
to identify it as cera-submitted. If the Session ends during
execution, `queryJobsByUser()` returns the Job from SLURM, but
the agent-interaction module has no cera-specific metadata to
distinguish it from Jobs submitted by other tools.

The `SubmitJobInput` type (api-contracts.md lines 214–219) has no
field for a cera-specific SLURM job name or comment that would
allow post-hoc identification.

### Evidence

1. `Job` entity (entities.ts line 241): `workflowId?: WorkflowId`
   — optional, null for standalone Jobs.
2. `SubmitJobInput` (api-contracts.md lines 214–219): no `jobName`
   or `comment` field.
3. `JobSubmitted` event (events.ts lines 112–119): has
   `resourceRequestHash` but no cera-specific marker.
4. ADR-007 line 101: "the Agent filters to Jobs that were submitted
   via cera (by cross-referencing persisted Workflow state and
   ProvenanceRecords)" — no mechanism for standalone Jobs.
5. The X4 contract says ProvenanceRecord is produced "upon
   completion" — not during execution.

### Suggested resolution

Architect should add a cera-specific marker to `SubmitJobInput`
(e.g., `jobName: "cera-{toolId}-{timestamp}"` or a SLURM comment
field) so that `queryJobsByUser()` results can be filtered to
cera-submitted Jobs, including standalone ones in-flight.
