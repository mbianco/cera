## Finding: In-flight `invokeTool()` during FirecREST outage — blocking behavior undefined
Severity: High
Category: Correctness > Failure cascades; Robustness > Resource exhaustion
Location: `src/tool-invocation/tool-invocation-service.ts` lines 664–670 (dispatch), 980–992 (poll loop); `specs/failure-modes-firecrest-primary.md` FM-F-4 (lines 807–816)
Spec reference: FM-F-4 (FirecREST server unavailable, 503); R13 (UNKNOWN acceptable for 30 minutes); INV-S1 (Scheduler authoritative)

### Description

When `invokeTool()` submits a Job via `this.#scheduling.submitJob()`
and enters the poll loop (lines 980–992), it calls
`this.#scheduling.queryJob(job.jobId)` repeatedly until a terminal
state is reached. Under R14, `this.#scheduling` is
`FirecRESTSchedulingService`, which makes HTTP requests to
`GET /compute/{system}/jobs/{id}`.

**Scenario:** The Job is RUNNING on the HPC. FirecREST goes down
(FM-F-4, 503). The poll loop calls `queryJob()`, which returns 503.
The spec says "cera marks all Job states as UNKNOWN" — but the
existing code at line 984 simply calls `queryJob()` and checks
`isTerminalJobState()`. An UNKNOWN state (if the mock/implementation
returns it) is not terminal, so the loop continues.

**The blocking problem:**
1. The poll loop has a safety limit of 1000 iterations (line 982),
   but each iteration waits `this.#config.pollIntervalMs` (line 990).
   At 30s per poll, that's up to 8.3 hours of blocking.
2. The R13 policy (30 minutes UNKNOWN acceptable) applies to Job
   **state queries** — but the spec doesn't say what happens to the
   `invokeTool()` call during this period.
3. There is no timeout on `invokeTool()` itself. The agent loop is
   blocked waiting for this single ToolInvocation.
4. If FirecREST recovers within the poll limit, the Job state is
   updated and `invokeTool()` proceeds. If not, the loop exits after
   1000 iterations with the last-known state (likely UNKNOWN), and
   the ExitOutcome is derived from an UNKNOWN state — which is
   neither success nor failure.

**Missing from the spec:**
1. What is the maximum blocking duration for `invokeTool()` during a
   FirecREST outage?
2. Should `invokeTool()` return a special "Provenance pending" or
   "Job status unknown" state to the caller, allowing the agent loop
   to continue with other work?
3. How does the agent loop handle an `invokeTool()` that has been
   blocking for >30 minutes? Is there a watchdog?
4. What ExitOutcome is derived from an UNKNOWN state after the poll
   limit is reached? Is it a failure? Is it non-deterministic?

### Evidence

1. `src/tool-invocation/tool-invocation-service.ts` lines 980–992:
   poll loop with `maxIterations = 1000` and `pollIntervalMs` delay.
   No timeout on the overall `invokeTool()` call.
2. `specs/failure-modes-firecrest-primary.md` lines 808–815: FM-F-4
   says "Running Jobs on the HPC are NOT affected" and "cera marks
   all Job states as UNKNOWN" — but doesn't mention `invokeTool()`
   blocking.
3. `specs/resolutions.md` R13: "UNKNOWN state is acceptable for 30
   minutes" — applies to Job state, not `invokeTool()` blocking.
4. `specs/failure-modes-firecrest-primary.md` line 995:
   `jobStateToExitOutcome()` — no documentation of how UNKNOWN maps
   to an ExitOutcome.

### Suggested resolution

Specify a maximum blocking duration for `invokeTool()` (e.g., 30
minutes, aligned with R13). After this duration, `invokeTool()`
should return a special state (e.g., `JobStatusUnknown`) to the
caller, allowing the agent loop to continue. Document how UNKNOWN
maps to an ExitOutcome (or state that the ToolInvocation remains in
RUNNING state until the Job is confirmed terminal). Add a test for
the long-blocking scenario.
