# FirecREST Backend Failure Modes — cera

> FirecREST-specific failure modes, blast radius, desired degradation,
> and what is unacceptable even in failure. These supplement (not
> replace) the existing failure modes in `failure-modes.md`.
>
> Each entry is mapped to the FirecREST invariant it threatens and
> the existing cera failure mode (if any) it corresponds to.

---

## FM-F-1: FirecREST 5-second timeout on synchronous call
**Severity:** HIGH
**Blast radius:** single operation (Job submission, file stat, etc.)
**Recovery class:** recoverable (retry with backoff)
**Threatens:** F-INV-3

**How:** A synchronous FirecREST call (GET, POST, PUT, DELETE on
non-transfer endpoints) does not complete within FirecREST's 5-second
timeout. This may be due to HPC-side slowness (SLURM controller under
load), network latency between the laptop and FirecREST, or FirecREST
itself being slow.

**Desired degradation:** cera aborts the request, retries with
exponential backoff (starting at e.g., 1s, max 30s, up to 5
retries). If all retries fail, cera notifies the User that the
operation could not complete and suggests checking FirecREST status.

**Unacceptable:** cera blocks indefinitely on a single request.
cera retries the same request more than the configured maximum
without notifying the User. cera silently drops the operation without
recording an error.

---

## FM-F-2: JWT token expired or invalid (401)
**Severity:** HIGH
**Blast radius:** entire session (all FirecREST operations affected)
**Recovery class:** recoverable (token refresh) → fatal (if refresh fails)
**Threatens:** F-INV-2

**How:** The JWT Bearer token in the `Authorization` header is
expired, revoked, or malformed. FirecREST returns 401 for every
request made with the invalid token.

**Desired degradation:** cera detects the 401 response, attempts to
refresh the token via the OIDC provider (using the refresh token or
client credentials grant). If refresh succeeds, cera retries the
original request with the new token. If refresh fails (OIDC provider
unreachable, refresh token expired, credentials revoked), cera
notifies the User that authentication has expired and no further
FirecREST operations are possible until the User re-authenticates.

**Unacceptable:** cera retries the request with the same expired
token. cera silently marks all operations as failed without
indicating the authentication issue. cera proceeds without a valid
token (sending no `Authorization` header).

---

## FM-F-3: FirecREST rate limit exceeded (429)
**Severity:** MEDIUM
**Blast radius:** single operation (or multiple if cera is making
many requests in a short period)
**Recovery class:** recoverable (retry with exponential backoff)
**Threatens:** F-INV-3

**How:** cera has made more requests than FirecREST allows in a
given time window. FirecREST returns 429, optionally with a
`Retry-After` header indicating how long to wait.

**Desired degradation:** cera honors the `Retry-After` header (if
present) or applies exponential backoff (starting at e.g., 2s, max
60s). cera does NOT flood FirecREST with immediate retries. If
rate limiting persists, cera notifies the User that FirecREST is
rate-limiting cera's requests and suggests reducing concurrent
operations.

**Unacceptable:** cera retries immediately without backoff. cera
opens multiple parallel requests to the same endpoint while already
rate-limited.

---

## FM-F-4: FirecREST server unavailable (503)
**Severity:** CRITICAL
**Blast radius:** entire session (no FirecREST operations possible)
**Recovery class:** degradable (running Jobs on HPC continue; cera
can cache last-known states) → fatal (if prolonged)
**Threatens:** F-INV-1, F-INV-3

**How:** The FirecREST server is down, restarting, or under
maintenance. All requests return 503.

**Desired degradation:**
- Running Jobs on the HPC are NOT affected (they execute on compute
  nodes independently of FirecREST).
- cera marks all Job states as UNKNOWN (not COMPLETED, not RUNNING —
  same as FM-S2 for the local backend).
- cera retries with backoff (starting at 30s, max 5 min — same as
  the scheduling config for FM-S2).
- When FirecREST recovers, cera queries Job states via
  GET /compute/.../jobs/{id}. Jobs that completed during the outage
  are identified and reported.
- The User is notified that FirecREST is unavailable and that running
  Jobs continue on the HPC.

**Unacceptable:** cera promotes any Job to COMPLETED based on file
existence or elapsed time (INV-S1 violation). cera cancels running
Jobs because FirecREST is unavailable. cera silently marks all Jobs
as FAILED.

---

## FM-F-5: SSH connection from FirecREST to HPC failed (500)
**Severity:** HIGH
**Blast radius:** single operation (or multiple if the SSH connection
pool is exhausted)
**Recovery class:** recoverable (retry with backoff) → fatal (if
persistent — indicates HPC or network issue)
**Threatens:** F-INV-1

**How:** FirecREST is running but cannot reach the HPC system via
SSH. This may be due to a network partition between FirecREST and
the HPC, SSH daemon failure on the HPC, or SSH connection pool
exhaustion. FirecREST returns 500 with an SSH-related error message.

**Desired degradation:** cera retries with backoff (similar to
FM-F-1). If the error persists, cera notifies the User that FirecREST
cannot reach the HPC system and suggests checking system health via
GET /status/{system}/healthchecks.

**Unacceptable:** cera treats a single SSH failure as a permanent
error without retrying. cera floods FirecREST with retries when the
SSH connection is exhausted (this makes the problem worse).

---

## FM-F-6: Large file transfer job failed (async, FAILED state)
**Severity:** HIGH
**Blast radius:** single file transfer
**Recovery class:** recoverable (resubmit transfer) → fatal (if the
file is critical for a Workflow and cannot be retransferred)
**Threatens:** F-INV-4

**How:** A large file transfer (>5MB) was submitted via
POST /filesystem/.../transfer/download or /transfer/upload. The
transfer job reached a FAILED state — the staging storage was
unavailable, the file was deleted mid-transfer, or a network error
occurred.

**Desired degradation:** cera detects the FAILED state during
polling. cera reports the failure to the User with the transfer
jobId and any error details. cera offers to resubmit the transfer
(if the source file still exists).

**Unacceptable:** cera silently ignores the transfer failure and
proceeds as if the file was transferred. cera treats partial
transfer output as a complete file. cera registers a Dataset whose
Location does not resolve (INV-D4 violation).

---

## FM-F-7: FirecREST not configured for the target system (404)
**Severity:** HIGH
**Blast radius:** entire session (no operations possible on that system)
**Recovery class:** recoverable (User selects a different system)
**Threatens:** F-INV-1

**How:** The target system name in `FirecrestConfig` (e.g.,
"unknown_system") is not configured in FirecREST. All requests to
`/compute/unknown_system/...` or `/filesystem/unknown_system/...`
return 404.

**Desired degradation:** cera queries GET /status/systems to list
available systems. cera notifies the User that the configured system
is not available and presents the list of configured systems. The
User selects a different system, and cera updates the configuration
(or the User restarts with the correct system name).

**Unacceptable:** cera proceeds with the non-existent system name
without notifying the User. cera silently substitutes a different
system without User confirmation.

---

## FM-F-8: File too large for synchronous download (>5MB)
**Severity:** MEDIUM
**Blast radius:** single file operation
**Recovery class:** recoverable (fall back to async transfer)
**Threatens:** F-INV-4

**How:** cera attempts to download a file via the synchronous
`/ops/download` endpoint, but the file is larger than 5MB.
FirecREST returns an error indicating the file exceeds the
synchronous limit.

**Desired degradation:** cera detects the error (or, better,
pre-checks file size via stat before attempting download). cera
falls back to the asynchronous `/transfer/download` endpoint,
submits the transfer job, polls for completion, and retrieves the
file via the appropriate transfer method (S3 or streamer).

**Unacceptable:** cera retries the synchronous download after
receiving the size error. cera silently truncates the file.
cera treats the download as failed without attempting the async
fallback.

---

## FM-F-9: uenv not available in the Job script (CESM build/run fails)
**Severity:** HIGH
**Blast radius:** single Job (and the ToolInvocation or Case it serves)
**Recovery class:** recoverable (User corrects the uenv spec)
**Threatens:** F-INV-5, INV-E1 (re-evaluated for FirecREST)

**How:** cera embeds a `uenv start <spec> --` command in the Job
script, but the specified uenv does not exist on the HPC system (or
the mount path is wrong, or the uenv is corrupted). The Job runs
`uenv start`, fails, and exits with a non-zero exit code. The Job
reaches FAILED state with stderr containing "uenv: not found" or a
similar error.

**Desired degradation:** cera detects the FAILED state and the uenv
error in stderr. cera reports the failure to the User with the
specific uenv spec and the error message. cera suggests verifying
the uenv name and version, or loading an alternative. The
ProvenanceRecord records the FAILED state and the stderr.

**Unacceptable:** cera retries the Job with the same uenv spec
(the uenv won't magically appear). cera proceeds to register output
Datasets from a failed Job (INV-T3 violation). cera suppresses the
uenv error and reports a generic "Job failed" without indicating
the uenv cause.

---

## Summary Table

| ID | Severity | Blast Radius | Recovery | Maps to existing FM |
|----|----------|-------------|----------|---------------------|
| FM-F-1 | HIGH | single operation | recoverable | FM-S2 (timeout analog) |
| FM-F-2 | HIGH | entire session | recoverable→fatal | (new — authentication) |
| FM-F-3 | MEDIUM | single operation | recoverable | (new — rate limit) |
| FM-F-4 | CRITICAL | entire session | degradable→fatal | FM-S2 (SLURM unavailable analog) |
| FM-F-5 | HIGH | single operation | recoverable→fatal | (new — SSH between FirecREST and HPC) |
| FM-F-6 | HIGH | single file transfer | recoverable→fatal | FM-T5, FM-D5 (file not found/corrupted analog) |
| FM-F-7 | HIGH | entire session | recoverable | (new — system not configured) |
| FM-F-8 | MEDIUM | single file operation | recoverable | (new — sync size limit) |
| FM-F-9 | HIGH | single Job | recoverable | FM-E1, FM-E3 (uenv not found/partial load analog) |
