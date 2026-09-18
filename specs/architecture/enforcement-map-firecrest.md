# Enforcement Map — FirecREST-Only Primary (R14, ADR-012)

> Updated enforcement map for the FirecREST-only primary architecture.
> The original `enforcement-map.md` remains the reference for the
> dev backend. This document supersedes it for the production path.
>
> Status legend:
> - **ENFORCED (production)** — enforced in the production path
> - **ENFORCED (dev-only)** — enforced only under `--backend dev`
> - **RE-EVALUATED** — same invariant, different enforcement mechanism
> - **REMOVED from production** — not enforced in production
> - **NEW** — introduced by R14

---

## C1 — Tool Invocation

| ID | Invariant | Production Enforcement | Dev Enforcement | Status |
|----|-----------|----------------------|-----------------|--------|
| INV-T1 | Environment loaded before invocation | uenv embedded in Job script (F-INV-5). No EnvironmentService.verifyEnvironment() call. The Job either loads uenv or fails (FM-F-9). | EnvironmentService.verifyEnvironment() before invocation | RE-EVALUATED |
| INV-T2 | Single exit outcome per invocation | ExitOutcome derived from Job terminal state (FirecREST GET /compute/.../jobs/{id}). Exactly one of exit_code or signal. | Same — local subprocess ExitOutcome | UNCHANGED |
| INV-T3 | Output registration gated on success | ToolInvocationService checks Job state = COMPLETED and exit code = 0 (or permissive). Only then registers output Dataset. | Same | UNCHANGED |
| INV-T4 | Input immutability during invocation | Input Datasets are on the HPC filesystem. cera reads them via FirecREST (GET /filesystem/.../ops/download or stat). cera never opens input Datasets for writing. | Same — local fs | UNCHANGED |
| INV-T5 | Signal vs exit-code distinction | Job terminal state and exit code are parsed from FirecREST response. SLURM timeout → SIGTERM → signal. OOM → OUT_OF_MEMORY → signal. | Same — local subprocess | UNCHANGED |
| INV-T6 | Submit requires built Case | CaseService.submitCase() checks Case state = BUILT. Unchanged — Case state is managed by ToolInvocationService regardless of backend. | Same | UNCHANGED |
| INV-T7 | One running Job per Case | CaseService.submitCase() checks existing Job state via SchedulingService.queryJob(). Under FirecREST, this is GET /compute/.../jobs/{id}. | Same — local squeue | RE-EVALUATED (transport) |
| INV-T8 | Run length bounded by Wall Time | CaseService.submitCase() compares runLength vs resourceRequest.wallTime. Unchanged. | Same | UNCHANGED |
| INV-T9 | Output tree location known before submission | Set at Case creation (R5). Unchanged. | Same | UNCHANGED |
| FP-INV-5 | Default ResourceRequest for formerly-sync ToolInvocations | ToolInvocationService uses jobScriptConfig.defaultResourceRequest when request.resourceRequest is absent. | N/A — synchronous execution doesn't need ResourceRequest | NEW |

## C3 — Data Management

| ID | Invariant | Production Enforcement | Dev Enforcement | Status |
|----|-----------|----------------------|-----------------|--------|
| INV-D1 | Dataset immutability | Object.freeze on Dataset. No write handles to input Datasets. FirecREST file operations are read-only for inputs. | Same — local fs | UNCHANGED |
| INV-D2 | One Format, one Grid per Dataset | Type system (readonly fields on Dataset). Validated at registration. | Same | UNCHANGED |
| INV-D3 | Provenance before consumption | DataManagementService.markConsumable() calls ProvenanceService.verifyProvenance(). ProvenanceService uses FirecREST filesystem to read records. | Same — local fs | UNCHANGED (transport differs) |
| INV-D4 | Location resolves before use | DataManagementService.validateLocation() calls FilesystemGateway.exists() and isReadable(). Under FirecREST, these are HTTP HEAD/GET requests. | Same — local fs.exists() | RE-EVALUATED (transport) |

## C4 — Scheduling

| ID | Invariant | Production Enforcement | Dev Enforcement | Status |
|----|-----------|----------------------|-----------------|--------|
| INV-S1 | Scheduler is authoritative for Job State | FirecREST GET /compute/.../jobs/{id} returns SLURM state. cera does NOT infer from file existence. | Same — local squeue/sacct | RE-EVALUATED (transport) |
| INV-S2 | Resource Request immutable after submission | ResourceRequest is frozen on the Job object. FirecREST does not support modification. | Same | UNCHANGED |
| INV-S3 | Unique JobID | FirecREST returns jobId from POST /compute/.../jobs. SLURM assigns it. cera does not generate JobIDs. | Same — local sbatch | UNCHANGED |
| INV-S4 | Terminal state is final | Once FirecREST reports a terminal state (COMPLETED, FAILED, TIMEOUT, CANCELLED, OUT_OF_MEMORY, NODE_FAIL), cera does not query again. | Same | UNCHANGED |

## C5 — Environment Management

| ID | Invariant | Production Enforcement | Dev Enforcement | Status |
|----|-----------|----------------------|-----------------|--------|
| INV-E1 | One active Environment per execution context | The "execution context" is now the SLURM Job (F-INV-5). Each Job has exactly one uenv (specified in the script). cera does not manage Environments. | EnvironmentService.getActiveEnvironment() — one per process | RE-EVALUATED |
| INV-E2 | Conflict detection before execution | N/A in production — cera does not call uenv mount. Conflicts would cause the Job to fail (FM-F-9). | ConflictDetector.detectConflicts() before mount | REMOVED from production |
| INV-E3 | Module availability verified before load | N/A in production — cera does not call uenv status. uenv availability is checked at Job runtime (FM-F-9). | EnvironmentService.checkUenvAvailability() | REMOVED from production |
| FP-INV-3 | EnvironmentService not used in production | ToolInvocationServiceImplProps.environment is undefined when backend.type === 'firecrest'. No EnvironmentService methods are called. | EnvironmentService is active | NEW |
| FP-INV-4 | SLURM CLI not used in production | SchedulingService is implemented by FirecRESTSchedulingService, not the SLURM CLI (sbatch, squeue, scancel). The CLI implementation is tagged dev-only. | SLURM CLI is active | NEW |

## C6 — Provenance

| ID | Invariant | Production Enforcement | Dev Enforcement | Status |
|----|-----------|----------------------|-----------------|--------|
| INV-P1 | ProvenanceRecord immutability | Object.freeze on record. File written via FirecREST POST /filesystem/.../ops/upload (or /transfer/upload for >5MB). Never overwritten. | Same — local fs.writeFile() | UNCHANGED (transport differs) |
| INV-P2 | Full reproducibility tuple | Validated at write time (MissingField thrown if any field is null). | Same | UNCHANGED |
| INV-P3 | Provenance before consumption | DataManagementService.markConsumable() calls ProvenanceService.verifyProvenance(). | Same | UNCHANGED |
| INV-P4 | Provenance survives Session end | Records are on the HPC filesystem (via FirecREST). Queryable in any Session. | Same — local fs | UNCHANGED (transport differs) |
| F-INV-7 | Provenance written via FirecREST filesystem | Every ProvenanceRecord write is an HTTP request to a FirecREST filesystem endpoint. No record is written to local disk. | N/A — local fs in dev | NEW (production) |

## C7 — Agent Interaction

| ID | Invariant | Production Enforcement | Dev Enforcement | Status |
|----|-----------|----------------------|-----------------|--------|
| INV-W1 | Step inputs exist before step starts | WorkflowService.startWorkflow() validates input Datasets via DataManagementService.queryDataset() and ProvenanceService.verifyProvenance(). | Same | UNCHANGED |
| INV-W2 | Failure halts downstream | WorkflowExecutor stops on failure. Downstream steps do not start. | Same | UNCHANGED |
| INV-W3 | Workflow describes real dependencies | Best-effort — not enforced at runtime. | Same | UNCHANGED |
| INV-W4 | Session can outlive Jobs | SessionService.endSession() does NOT cancel running Jobs. Jobs are discoverable by JobID in future Sessions via FirecREST. | Same — local squeue | UNCHANGED (transport differs) |

## FirecREST-specific invariants (F-INV)

| ID | Invariant | Production Enforcement | Dev Enforcement | Status |
|----|-----------|----------------------|-----------------|--------|
| F-INV-1 | All HPC operations through FirecREST | Every HPC operation is an HTTP request to a FirecREST endpoint. No SubprocessRunner.execute("ssh ...") or local filesystem bypass. | N/A — local backend in dev | ENFORCED (production) |
| F-INV-2 | Valid JWT for every request | FirecrestClientImpl adds `Authorization: Bearer <token>` from JwtTokenProvider. On 401, refreshes and retries. | N/A — no JWT in dev | ENFORCED (production) |
| F-INV-3 | 5-second timeout on synchronous calls | AbortController with requestTimeoutMs (default 6000ms = 5s + 1s margin). | N/A — no FirecREST in dev | ENFORCED (production) |
| F-INV-4 | Large files (>5MB) are async | FirecrestFilesystemGateway.stat() checks file size before transfer. Files >5MB use /transfer/ endpoints. | N/A — no FirecREST in dev | ENFORCED (production) |
| F-INV-5 | uenv loaded in Job scripts | JobScriptBuilder prepends `uenv start <spec> --` before Tool command. No direct uenv CLI calls. | N/A — EnvironmentService in dev | ENFORCED (production) |
| F-INV-6 | All ToolInvocations are parallel | ToolInvocationService always takes the parallel path when jobScriptConfig is provided (production). The `executionModel` field is ignored. | N/A — synchronous is possible in dev | ENFORCED (production) |

## New invariants (FP-INV)

| ID | Invariant | Enforcement | Status |
|----|-----------|-------------|--------|
| FP-INV-1 | `--backend` defaults to `firecrest` | CLI parseArgs default: `'firecrest'`. createCeraSystem() requires firecrestConfig when type is 'firecrest'. | ENFORCED (production) |
| FP-INV-2 | Local backend is not production | CLI help text says "development only". Documentation describes only FirecREST. FP-INV-2 in invariants-firecrest-primary.md. | ENFORCED (documentation) |
