## Finding: Concurrent write conflict detection (FM-D4) not addressed across Sessions
Severity: High
Category: Correctness > Concurrency
Location: specs/failure-modes.md (lines 196–208, FM-D4); specs/cross-context/interactions.md (lines 651–659, X10 duplicated case); specs/architecture/error-taxonomy.md (lines 244–255, FM-D4)
Spec reference: failure-modes.md FM-D4; cross-context/interactions.md X10

### Description

FM-D4 states: "Two ToolInvocations (in the same Session or
different Sessions) attempt to write to the same output Location
simultaneously." The desired degradation is: "C7 detects the
duplicate (same Tool, parameters, inputs, output Location — see
X10 in cross-context) and refuses the second ToolInvocation before
it starts."

X10's "duplicated" case (interactions.md lines 651–659) says: "The
Agent accidentally creates two ToolInvocations for the same
operation on the same input Dataset... C7 should detect the
duplicate (same Tool, same parameters, same inputs, same output
Location) and refuse the second ToolInvocation."

However, the error-taxonomy.md (line 252) says the caller
responsibility is "`agent-interaction` detects the duplicate" — but
the domain model (C7, line 117–118) explicitly states: "cross-
Session coordination is out of scope unless the domain expert
requires it."

If two Sessions (same User, different sessions) simultaneously
create ToolInvocations with the same output Location, the
agent-interaction module has no cross-Session coordination
mechanism to detect the conflict before both Jobs start. There is
no shared registry of in-flight output Locations. The
`ToolInvocationRequest` has `outputLocation: Location` but there's
no API for checking whether another Session has already claimed
that Location.

### Evidence

1. failure-modes.md FM-D4: "Two ToolInvocations (in the same
   Session or **different Sessions**)" — explicit cross-Session
   scenario.
2. domain-model.md C7 (line 117): "cross-Session coordination is
   out of scope."
3. No API in `agent-interaction` or `tool-invocation` for
   registering/claiming output Locations.
4. error-taxonomy.md FM-D4: "Caller responsibility: agent-
   interaction detects the duplicate" — but with no cross-Session
   mechanism.

### Suggested resolution

Architect must either:
A. Add a shared output Location registry (in `data-management` or
   a new module) that tracks in-flight writes across Sessions.
B. Restrict FM-D4 to intra-Session only and explicitly state that
   cross-Session concurrent writes to the same Location are
   undefined behavior (filesystem's problem).
