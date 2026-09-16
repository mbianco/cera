# FirecREST Backend Invariants — cera

> Invariants specific to the FirecREST backend. These supplement (not
> replace) the existing invariants in `invariants.md`. Every F-INV
> below is expressible as a testable assertion and is mapped to the
> existing cera invariant it derives from or extends.
>
> Tag legend: **[NEW]** — invariant introduced by the FirecREST
> backend. **[DERIVED]** — re-evaluation or extension of an existing
> cera invariant for the FirecREST context.

---

## F-INV-1: All HPC operations go through FirecREST
**Severity:** CRITICAL
**Aggregate:** cera backend
**Tag:** [NEW]
**Maps to:** (new — backend isolation principle)

When the FirecREST backend is selected, every HPC operation — Job
submission, Job state query, Job cancellation, file listing, file
read/write, file stat, directory creation — goes through the FirecREST
REST API. No direct SSH access, no local subprocess execution for HPC
operations, no direct filesystem access to HPC paths.

> **Assertion:** For backend "firecrest", every operation that touches
> an HPC resource is implemented as an HTTP request to a FirecREST
> endpoint. No `SubprocessRunner.execute("ssh ...")` or
> `FilesystemGateway.readFile("/scratch/...")` bypass exists.

---

## F-INV-2: JWT token must be valid and not expired for every request
**Severity:** CRITICAL
**Aggregate:** FirecREST client
**Tag:** [NEW]
**Maps to:** (new — authentication invariant)

Every FirecREST HTTP request carries a valid, non-expired JWT Bearer
token in the `Authorization` header. The token's `preferred_username`
claim determines the HPC user under which commands execute. If the
token is expired or invalid, FirecREST returns 401 and cera must
refresh the token (or notify the User) before retrying.

> **Assertion:** For every HTTP request `r` sent to FirecREST,
> `r.headers["Authorization"]` is `"Bearer <token>"` where `<token>`
> is valid and non-expired at the time of the request. No request is
> sent without a token.

---

## F-INV-3: Synchronous FirecREST calls have a 5-second timeout
**Severity:** HIGH
**Aggregate:** FirecREST client
**Tag:** [NEW]
**Maps to:** FM-F-1

FirecREST imposes a 5-second timeout on synchronous operations. cera's
FirecREST client must respect this timeout: if a synchronous request
does not complete within 5 seconds (plus reasonable network overhead),
cera aborts the request and retries with backoff (up to a configurable
maximum).

> **Assertion:** For every synchronous FirecREST call, the client
> timeout is set to 5 seconds (or a value derived from 5s + network
> margin). No synchronous call blocks indefinitely.

---

## F-INV-4: Large file transfers (>5MB) are asynchronous
**Severity:** HIGH
**Aggregate:** FirecREST filesystem
**Tag:** [NEW]
**Maps to:** (new — FirecREST file transfer constraint)

Files larger than 5MB cannot be downloaded or uploaded synchronously
via the `/ops/download` and `/ops/upload` endpoints. cera must detect
file size (via stat) before attempting a transfer and use the
asynchronous `/transfer/download` and `/transfer/upload` endpoints
for large files. The async endpoints return a `jobId`; cera polls the
transfer job status until completion, then retrieves the file.

> **Assertion:** For any file `f` with `stat(f).size > 5_000_000`,
> cera uses `/transfer/...` endpoints, never `/ops/...` endpoints.
> For files ≤5MB, cera may use synchronous `/ops/...` endpoints.

---

## F-INV-5: uenv is loaded in Job scripts, not by cera
**Severity:** CRITICAL
**Aggregate:** ToolInvocation (via FirecREST)
**Tag:** [DERIVED — re-evaluates INV-E1 for FirecREST]
**Maps to:** INV-E1 (one active Environment per execution context)

Under the local (dsh) backend, cera's environment-management module
(C5) directly manages the uenv lifecycle: `checkUenvAvailability`,
`loadUenv`, `verifyEnvironment`, `unloadUenv`. These operations
require `SubprocessRunner` access to run `uenv` CLI commands on the
HPC login node.

Under the FirecREST backend, cera runs on a laptop and has no direct
access to the HPC CLI. FirecREST does not expose uenv management
endpoints. Therefore:

- cera does NOT call `uenv mount`, `uenv status`, or any uenv CLI
  command directly.
- cera embeds the uenv load command (e.g., `uenv start <spec> --`)
  in the Job script submitted via FirecREST.
- The Environment is loaded within the SLURM Job on the HPC, not on
  the laptop.
- INV-E1 (one active Environment per execution context) is re-evaluated:
  the "execution context" is now the SLURM Job, not the cera process.
  Each Job has exactly one Environment (the uenv specified in the
  script).
- The `EnvironmentService` interface is NOT used by the FirecREST
  backend. Instead, the `FirecrestShellExecutor` and
  `FirecrestSchedulingService` embed uenv commands in Job scripts.

> **Assertion:** For backend "firecrest", no method in the system
> calls `SubprocessRunner.execute("uenv", ...)` or
> `ShellExecutor.execute("uenv ...")`. uenv load commands appear only
> within Job script strings submitted to FirecREST.

---

## F-INV-6: All ToolInvocations are parallel (submitted as SLURM Jobs)
**Severity:** HIGH
**Aggregate:** ToolInvocation (via FirecREST)
**Tag:** [DERIVED — extends the existing executionModel concept]
**Maps to:** api-contracts.md §6 (ToolInvocationRequest.executionModel)

Under the local (dsh) backend, a ToolInvocation can be "synchronous"
(short CLI call on the login node via `ShellExecutor`) or "parallel"
(submitted as a SLURM Job via `SchedulingService`).

Under the FirecREST backend, there is no "run command and wait for
output" endpoint. Everything that executes on the HPC goes through
SLURM Jobs (POST /compute/.../jobs). Therefore:

- Every ToolInvocation, regardless of its declared `executionModel`,
  is submitted as a SLURM Job via the FirecREST compute endpoints.
- The `executionModel` field is ignored by the FirecREST backend —
  all ToolInvocations are treated as "parallel."
- cera polls the Job state (GET /compute/.../jobs/{id}) until a
  terminal state is reached, then derives the ExitOutcome from the
  Job's terminal state and exit code.

> **Assertion:** For backend "firecrest", every ToolInvocation
> results in exactly one POST to `/compute/{system}/jobs`. No
> ToolInvocation is executed via a synchronous command path.

---

## F-INV-7: Provenance records are written to the HPC filesystem via FirecREST
**Severity:** CRITICAL
**Aggregate:** Provenance (via FirecREST)
**Tag:** [DERIVED — extends INV-P1, INV-P4]
**Maps to:** INV-P1 (ProvenanceRecord immutability), INV-P4
(Provenance survives Session end)

Under the local (dsh) backend, ProvenanceRecords are written to the
HPC filesystem via `FilesystemGateway.writeFile()` — which, on the
login node, writes directly to the local filesystem.

Under the FirecREST backend, cera runs on a laptop. The Provenance
store remains on the HPC filesystem (INV-P4 requires Provenance to
persist across Sessions). Therefore:

- ProvenanceRecords are written via FirecREST filesystem endpoints:
  - For records ≤5MB: `POST /filesystem/{system}/ops/upload`
    (synchronous).
  - For records >5MB (rare but possible for complex lineage):
    `POST /filesystem/{system}/transfer/upload` (asynchronous, poll
    for completion).
- ProvenanceRecords are read via:
  - `GET /filesystem/{system}/ops/download` (synchronous, ≤5MB).
  - `POST /filesystem/{system}/transfer/download` (async, >5MB).
- The Provenance store path on the HPC is configured in `FirecrestConfig`.
- INV-P1 (immutability) is unchanged: cera never overwrites an
  existing ProvenanceRecord.

> **Assertion:** For backend "firecrest", every ProvenanceRecord write
> is an HTTP request to a FirecREST filesystem endpoint. The record is
> persisted on the HPC filesystem, not on the laptop. No
> ProvenanceRecord is written to local disk.

---

## Summary Table

| ID | Severity | Tag | Maps to | Short |
|----|----------|-----|---------|-------|
| F-INV-1 | CRITICAL | [NEW] | (backend isolation) | All HPC operations through FirecREST |
| F-INV-2 | CRITICAL | [NEW] | (authentication) | Valid JWT for every request |
| F-INV-3 | HIGH | [NEW] | FM-F-1 | 5-second timeout on synchronous calls |
| F-INV-4 | HIGH | [NEW] | (file transfer constraint) | Large files (>5MB) are async |
| F-INV-5 | CRITICAL | [DERIVED] | INV-E1 | uenv loaded in Job scripts, not by cera |
| F-INV-6 | HIGH | [DERIVED] | executionModel | All ToolInvocations are parallel |
| F-INV-7 | CRITICAL | [DERIVED] | INV-P1, INV-P4 | Provenance written via FirecREST filesystem |
