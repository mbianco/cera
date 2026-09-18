## Finding: FirecREST outage → ProvenanceRecord write cascade — unbounded duration, breaks "degradable" classification
Severity: Critical
Category: Correctness > Failure cascades; Robustness > Error handling quality
Location: `specs/failure-modes-firecrest-primary.md` FM-F-4 (lines 807–816), FM-P1 (lines 580–613); `specs/firecrest/failure-modes.md` FM-F-4; `specs/invariants-firecrest-primary.md` F-INV-7, INV-D3, INV-P3
Spec reference: FM-F-4 (FirecREST server unavailable, 503); FM-P1 (ProvenanceRecord write failure); F-INV-7 (Provenance via FirecREST); INV-D3 (Provenance before consumption); R13 (UNKNOWN acceptable for 30 minutes)

### Description

Under R14, ProvenanceRecords are written via FirecREST filesystem
endpoints (F-INV-7). When FirecREST goes down (FM-F-4, 503), the
following cascade occurs:

1. A Job completes on the HPC (Jobs are unaffected by FirecREST
   outages — this is correct).
2. cera's `invokeTool()` tries to write the ProvenanceRecord via
   FirecREST `POST /filesystem/{system}/ops/upload`.
3. The write fails with 503 (FM-F-4 → FM-P1 re-evaluated).
4. cera retries with backoff (FM-P1 recovery).
5. If FirecREST stays down, **all retries fail** — the
   ProvenanceRecord is never written.
6. The output Dataset cannot be registered (INV-D3: Provenance before
   consumption). The Dataset is "held in an unregistered state"
   (FM-P1 recovery text).
7. The `invokeTool()` call is **blocked** — it cannot return success
   (no ProvenanceRecord) and it cannot return failure (the Job
   succeeded).

**The problem:** FM-F-4 is classified as "degradable (running Jobs on
HPC continue)" and FM-P1 is "recoverable (retry with backoff); fatal
if all retries fail." But the combined scenario (FirecREST down + Job
completed + Provenance can't be written + Dataset stuck) is
**neither degradable nor recoverable within a bounded time**:

- The 30-minute UNKNOWN policy (R13) applies to **Job state queries**,
  not to ProvenanceRecord writes. There is no time bound on how long
  `invokeTool()` blocks waiting for the ProvenanceRecord write to
  succeed.
- FM-P1 says "fatal if all retries fail" — but during a FirecREST
  outage, ALL retries will fail. This makes the combined scenario
  fatal, contradicting FM-F-4's "degradable" classification.
- The FM-P1 re-evaluation (lines 588–595) lists "503 (FirecREST
  server unavailable — FM-F-4)" as a possible cause, but does not
  address the **combined scenario** as a distinct failure mode with
  its own recovery strategy.

**Missing documentation:**
- What is the maximum duration `invokeTool()` blocks during a
  FirecREST outage?
- Is there a timeout after which `invokeTool()` returns a special
  state (e.g., "Provenance pending")?
- Can the Agent continue with other work while waiting for the
  ProvenanceRecord write to succeed?
- What happens to multiple completed Jobs during a prolonged
  FirecREST outage? Are their ProvenanceRecords queued? Is there a
  write-on-recovery mechanism?

### Evidence

1. `specs/invariants-firecrest-primary.md` line 575: "ProvenanceRecords
   are on the HPC filesystem, accessed via FirecREST filesystem
   endpoints" — F-INV-7, PRODUCTION-ONLY.
2. `specs/failure-modes-firecrest-primary.md` lines 808–815: FM-F-4
   says "Running Jobs on the HPC are NOT affected" and recovery is
   "degradable" — but doesn't mention ProvenanceRecord writes.
3. `specs/failure-modes-firecrest-primary.md` lines 595–600: FM-P1
   says "The Agent retries the ProvenanceRecord write with backoff.
   If all retries fail, the User is notified and the output Dataset is
   held in an unregistered state." — No time bound, no combined
   scenario with FM-F-4.
4. `src/tool-invocation/tool-invocation-service.ts` lines 715–728:
   `writeProvenanceRecord()` is called BEFORE `registerDataset()`.
   If the write fails, the Dataset is never registered. The
   `invokeTool()` function awaits this write — there is no timeout
   in the visible code.
5. `specs/resolutions.md` R13: "UNKNOWN state is acceptable for 30
   minutes" — applies to Job state queries (FM-S2/FM-F-4), not
   ProvenanceRecord writes.

### Suggested resolution

Add a combined failure scenario (e.g., FP-FM-3) that documents the
FirecREST outage → ProvenanceRecord write failure cascade. Specify:
(a) a maximum blocking duration for `invokeTool()` during a FirecREST
outage, (b) whether the Agent can continue with other work, (c) a
write-on-recovery mechanism for ProvenanceRecords queued during the
outage, and (d) how the 30-minute UNKNOWN policy (R13) relates to
ProvenanceRecord writes (if at all).
