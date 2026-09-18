## Finding: FP-FM-2 (laptop crash) — Job discovery mechanism is unclear when Session state is lost
Severity: High
Category: Correctness > Specification compliance; Failure cascades
Location: `specs/failure-modes-firecrest-primary.md` lines 899–931 (FP-FM-2); `src/startup.ts` (CeraSystemConfig.username)
Spec reference: FP-FM-2 (laptop crash during Job polling); R7 (Agent resumes Jobs); INV-W4 (Session outlives Jobs); ADR-007

### Description

FP-FM-2 states: "On the next Session start, the Agent proactively
queries `FirecRESTSchedulingService.queryJobsByUser()` (R7, INV-W4)
and discovers the Job by its JobID."

**Problem 1: Session state is lost on laptop crash.** The JobID was
stored in the ToolInvocation object, which is in the Session. If the
laptop crashes, the Session state (in memory or in a local file) is
lost. The Agent does not know which Jobs it submitted.

**Problem 2: `queryJobsByUser()` returns ALL Jobs for the user.**
SLURM does not tag Jobs by their submitter application. A scientist
who runs cera Jobs, manual `sbatch` Jobs, and jobs from other tools
all appear under the same username. The Agent cannot distinguish
cera-submitted Jobs from others without additional metadata.

**Problem 3: The CeraSystemConfig.username is `undefined` in the CLI
stub** (`cli.ts` line 214: `username: undefined, // derived from
JWT`). The `JwtTokenProvider` interface (`firecrest-adapter/types.ts`
lines 29–48) has no method to extract the username from the JWT.
Without a username, `queryJobsByUser()` cannot be called.

**Related prior finding:** FINDING-07 (standalone parallel Jobs not
associable across Sessions) identified the same issue: "The
architect should add a `submitterId` or `ceraTag` to the Job entity
so Jobs submitted by cera can be distinguished from user-submitted
Jobs." This finding was documented as non-blocking for Phase 1–4 but
is now blocking for R14 production: FP-FM-2 cannot be implemented
without a way to identify cera-submitted Jobs.

**Missing from the spec:**
1. How does the Agent identify cera-submitted Jobs after a laptop
   crash?
2. Is there a Job naming convention (e.g., `cera-<invocationId>`)?
3. Is there a cera metadata tag in the Job script or comment?
4. Is the Session state persisted to a local file (and can it be
   recovered after a crash)?
5. How does the Agent distinguish its Jobs from manual `sbatch` Jobs
   when querying by username?

### Evidence

1. `specs/failure-modes-firecrest-primary.md` line 914: "the Agent
   proactively queries `FirecRESTSchedulingService.queryJobsByUser()`
   (R7, INV-W4) and discovers the Job by its JobID."
2. `specs/failure-modes-firecrest-primary.md` line 919: "Unacceptable:
   The Agent loses track of the Job permanently (no recovery path)."
   — but the recovery path depends on knowing the JobID, which is
   lost.
3. `src/startup.ts` line 144: `readonly username?: string` —
   optional, and the CLI sets it to `undefined`.
4. `src/firecrest-adapter/types.ts` lines 29–48: `JwtTokenProvider`
   has `getToken()`, `refreshToken()`, `isExpired()` — no method to
   extract `preferred_username` from the token.
5. `specs/findings/FINDING-07-standalone-jobs-not-associable-across-sessions.md`:
   same issue identified previously, documented as non-blocking.

### Suggested resolution

Specify a Job identification mechanism for R14 production: (a) a
`cera-<invocationId>` Job name convention passed via
`--job-name=...` in the SLURM submit, (b) a cera-specific comment
in the Job script, or (c) a local persisted Job registry
(`~/.cera/jobs.json`) that survives laptop crashes. Also specify how
the username is derived from the JWT (add a `getUsername()` method
to `JwtTokenProvider` or a JWT parsing utility).
