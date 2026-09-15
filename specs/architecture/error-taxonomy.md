# Error Taxonomy — cera

> Maps every failure mode from `failure-modes.md` (updated per
> `resolutions.md`) to TypeScript error types, severity, recovery
> strategy, caller responsibility, user-facing message, and log level.
>
> All error types are defined in `src/types/errors.ts` as a
> discriminated union of `CeraError` subclasses.

---

## Error Class Hierarchy

```
CeraError (base)
├── DshAdapterError
│   ├── FrameworkBreakingChange (FM-X3)
│   └── AdapterInternal
├── ToolInvocationError
│   ├── EnvironmentNotLoaded (INV-T1, FM-E1, FM-E3)
│   ├── InputNotFound (FM-T5, FM-D3)
│   ├── InputMissingProvenance (INV-D3, INV-W1, FM-P3)
│   ├── InvalidParameters (FM-A2, FM-T4)
│   ├── ToolNotFound (FM-A1, R12)
│   ├── NonZeroExitCode (FM-T3, R4)
│   ├── SignalTerminated (FM-T1, FM-T2, INV-T5)
│   ├── QuotaExceeded (FM-D1)
│   ├── ConcurrentWriteConflict (FM-D4)
│   ├── CorruptedDataset (FM-D5)
│   ├── CaseNotBuilt (INV-T6, FM-M1)
│   ├── CaseAlreadyRunning (INV-T7)
│   ├── RunLengthExceedsWallTime (INV-T8)
│   └── OutputLocationNotSet (INV-T9)
├── SchedulingError
│   ├── RejectedByScheduler (FM-S1)
│   ├── SchedulerUnavailable (FM-S2)
│   ├── StaleQueueData (FM-S3)
│   └── JobNotFound
├── EnvironmentError
│   ├── UenvNotFound (FM-E1)
│   ├── ConflictDetected (FM-E2, INV-E2)
│   ├── PartialLoad (FM-E3)
│   └── NotActive
├── DataError
│   ├── LocationNotReadable (FM-D3, INV-D4)
│   ├── LocationNotWritable (FM-D3, INV-D4)
│   ├── QuotaExceeded (FM-D1)
│   ├── ProvenanceMissing (INV-D3, FM-P3)
│   └── DatasetCorrupted (FM-D5)
├── ProvenanceError
│   ├── WriteFailed (FM-P1)
│   ├── RecordCorrupted (FM-P2)
│   └── MissingField (INV-P2)
└── AgentError
    ├── LlmHallucinatedTool (FM-A1, R12)
    ├── LlmHallucinatedParameters (FM-A2, R12)
    ├── ContextWindowExceeded (FM-A3)
    ├── LlmUnavailable (FM-A4)
    ├── NetworkLost (FM-X2)
    └── WorkflowAlreadyAssigned
```

---

## C1 — Tool Invocation

### FM-T1: Tool segfault (SIGSEGV, SIGBUS)

| Field | Value |
|-------|-------|
| **Error type** | `ToolInvocationError.SignalTerminated` |
| **Discriminator** | `{ kind: 'signal_terminated'; signalName: string; signalNumber: number }` |
| **Severity** | HIGH |
| **Recovery** | fatal (stop and notify user) |
| **Caller responsibility** | `tool-invocation` catches the signal, captures stderr, marks ToolInvocation as FAILED. Does NOT retry. `agent-interaction` is notified and informs the User. Workflow is halted (INV-W2). |
| **User-facing message** | `"CDO crashed with signal SIGSEGV (11). This indicates a real defect, not a transient error. The ToolInvocation has been marked as FAILED. Output has not been registered. Please check the stderr output and verify your input data."` |
| **Internal log level** | ERROR |
| **Spec refs** | `invariants.md` INV-T5; `failure-modes.md` FM-T1; `features/cdo-operations.feature` (segfault scenario) |

### FM-T2: Tool killed by OOM (SIGKILL)

| Field | Value |
|-------|-------|
| **Error type** | `ToolInvocationError.SignalTerminated` |
| **Discriminator** | `{ kind: 'signal_terminated'; signalName: 'SIGKILL'; signalNumber: 9; likelyCause: 'out_of_memory' }` |
| **Severity** | HIGH |
| **Recovery** | fatal (stop and notify user) |
| **Caller responsibility** | `tool-invocation` distinguishes SIGKILL from normal exit (INV-T5), reports as Signal. Suggests larger memory allocation or chunked processing. |
| **User-facing message** | `"The Tool was killed by signal SIGKILL (9), likely due to an out-of-memory condition. Consider requesting more memory or processing the data in smaller chunks."` |
| **Internal log level** | ERROR |
| **Spec refs** | `invariants.md` INV-T5; `failure-modes.md` FM-T2; `features/zarr-io.feature` (MemoryError scenario) |

### FM-T3: Non-zero exit code for warnings (CDO-specific)

| Field | Value |
|-------|-------|
| **Error type** | `ToolInvocationError.NonZeroExitCode` |
| **Discriminator** | `{ kind: 'non_zero_exit_code'; exitCode: number; permissive: boolean; stderr: string }` |
| **Severity** | MEDIUM |
| **Recovery** | degradable (output may be usable with a warning flag) **only if** permissive mode is explicitly enabled; otherwise fatal |
| **Caller responsibility** | `tool-invocation` checks `permissiveExitCodes` on the ToolInvocation. If the exit code is in the list (User explicitly opted in, R4), the output is registered with a warning flag. Otherwise, the output is NOT registered (INV-T3). |
| **User-facing message** | Strict: `"CDO exited with code 1. Output has not been registered because non-zero exit codes are treated as failures by default. If this exit code is a known non-error for your Tool, you can enable permissive mode for this invocation."` Permissive: `"CDO exited with code 1 (warning). Output has been registered with a warning flag. The ProvenanceRecord records the non-zero exit code."` |
| **Internal log level** | WARN (permissive) / ERROR (strict) |
| **Spec refs** | `invariants.md` INV-T3; `resolutions.md` R4 (strict default); `failure-modes.md` FM-T3; `features/cdo-operations.feature` (exit code 1 scenarios) |

### FM-T4: Invalid operator chain (CDO)

| Field | Value |
|-------|-------|
| **Error type** | `ToolInvocationError.NonZeroExitCode` |
| **Discriminator** | `{ kind: 'non_zero_exit_code'; exitCode: number; stderr: string; cause: 'invalid_operator_chain' }` |
| **Severity** | MEDIUM |
| **Recovery** | recoverable (User corrects the chain) |
| **Caller responsibility** | `tool-invocation` captures the error and stderr, reports to `agent-interaction`. Does NOT silently correct the chain. |
| **User-facing message** | `"CDO failed with exit code {code}. The operator chain may be invalid. Error from CDO: {stderr}. Please check the operator order — CDO evaluates right-to-left."` |
| **Internal log level** | WARN |
| **Spec refs** | `failure-modes.md` FM-T4; `features/cdo-operations.feature` |

### FM-T5: Missing input file

| Field | Value |
|-------|-------|
| **Error type** | `ToolInvocationError.InputNotFound` |
| **Discriminator** | `{ kind: 'input_not_found'; datasetId: DatasetId; location: Location; cause: 'enoent' \| 'eacces' }` |
| **Severity** | HIGH |
| **Recovery** | recoverable (User provides correct path) |
| **Caller responsibility** | `tool-invocation` rejects the ToolInvocation before execution. Reports the missing path and suggests alternatives from the Dataset registry (via `data-management`). |
| **User-facing message** | `"Input Dataset '{name}' at location '{path}' could not be found (ENOENT). The ToolInvocation has been rejected. Please verify the path or select a different input Dataset."` |
| **Internal log level** | WARN |
| **Spec refs** | `invariants.md` INV-D4; `failure-modes.md` FM-T5; `features/cdo-operations.feature` (missing input scenario) |

---

## C1 — CESM (formerly C2)

### FM-M1: CESM build failure

| Field | Value |
|-------|-------|
| **Error type** | `ToolInvocationError.NonZeroExitCode` |
| **Discriminator** | `{ kind: 'non_zero_exit_code'; exitCode: number; stderr: string; caseId: CaseId; phase: 'build' }` |
| **Severity** | HIGH |
| **Recovery** | recoverable (User fixes configuration/environment) |
| **Caller responsibility** | `tool-invocation` (Case lifecycle) captures the build log, keeps the Case in CONFIGURED state (not BUILT). Reports the failure and suggests Environment corrections (via `environment-management`). |
| **User-facing message** | `"CESM build failed for Case '{name}' with exit code {code}. The Case remains in CONFIGURED state. Build log excerpt: {excerpt}. Check the compiler Environment and dependencies."` |
| **Internal log level** | ERROR |
| **Spec refs** | `invariants.md` INV-T6 (formerly INV-M1); `failure-modes.md` FM-M1; `features/cesm-submission.feature` (build failure scenario) |

### FM-M2: CESM runtime crash (MPI abort)

| Field | Value |
|-------|-------|
| **Error type** | `SchedulingError` (Job reported FAILED by SLURM) → wrapped as `ToolInvocationError.NonZeroExitCode` with `phase: 'runtime'` |
| **Discriminator** | `{ kind: 'non_zero_exit_code'; exitCode: number; caseId: CaseId; phase: 'runtime'; jobState: 'FAILED' }` |
| **Severity** | CRITICAL |
| **Recovery** | fatal (stop and notify user) |
| **Caller responsibility** | `scheduling` reports JobState FAILED (INV-S1). `tool-invocation` captures stderr (from output tree or `case.err`), marks Case as FAILED. Downstream Workflow steps do NOT start (INV-W2). Does NOT auto-resubmit. |
| **User-facing message** | `"CESM run failed for Case '{name}' (Job {jobId}, state: FAILED). This is an MPI abort — likely a configuration or numerical problem, not a transient error. Error output: {excerpt}. Downstream Workflow steps have been halted."` |
| **Internal log level** | CRITICAL |
| **Spec refs** | `invariants.md` INV-S1, INV-W2; `failure-modes.md` FM-M2; `features/cesm-submission.feature` |

### FM-M3: Wall time exceeded (TIMEOUT)

| Field | Value |
|-------|-------|
| **Error type** | `SchedulingError` (Job reported TIMEOUT) → wrapped as `ToolInvocationError.SignalTerminated` |
| **Discriminator** | `{ kind: 'signal_terminated'; signalName: 'SIGTERM'; signalNumber: 15; jobState: 'TIMEOUT'; caseId: CaseId }` |
| **Severity** | HIGH |
| **Recovery** | recoverable (resubmit with longer wall time) |
| **Caller responsibility** | `scheduling` reports TIMEOUT. `tool-invocation` reports the Signal (INV-T5) and suggests resubmission with a longer Wall Time. Does NOT resubmit with the same Wall Time. |
| **User-facing message** | `"CESM Job {jobId} exceeded its wall time of {wallTime} and was terminated (SIGTERM then SIGKILL). State: TIMEOUT. Consider resubmitting with a longer wall time or using restart files."` |
| **Internal log level** | WARN |
| **Spec refs** | `invariants.md` INV-T5, INV-T8 (formerly INV-M3); `failure-modes.md` FM-M3, FM-S4; `features/cesm-submission.feature`, `features/job-management.feature` |

### FM-M4: Node failure mid-run (NODE_FAIL)

| Field | Value |
|-------|-------|
| **Error type** | `SchedulingError` (Job reported NODE_FAIL) |
| **Discriminator** | `{ kind: 'job_state'; jobState: 'NODE_FAIL'; jobId: JobId; caseId: CaseId }` |
| **Severity** | HIGH |
| **Recovery** | recoverable (resubmit, possibly with `--exclude`) |
| **Caller responsibility** | `scheduling` reports NODE_FAIL. `tool-invocation` identifies the failed node (from SLURM) and suggests resubmission with `--exclude`. Does NOT auto-resubmit without User's decision (resume from checkpoint vs. restart). |
| **User-facing message** | `"CESM Job {jobId} failed due to a node failure on node(s) {nodeList}. State: NODE_FAIL. You may resubmit with --exclude={nodeList}. CESM's restart mechanism (if configured) may allow resuming from the last checkpoint."` |
| **Internal log level** | WARN |
| **Spec refs** | `failure-modes.md` FM-M4; `features/job-management.feature` (NODE_FAIL scenario) |

### FM-M5: CESM configure failure

| Field | Value |
|-------|-------|
| **Error type** | `ToolInvocationError.NonZeroExitCode` |
| **Discriminator** | `{ kind: 'non_zero_exit_code'; exitCode: number; stderr: string; caseId: CaseId; phase: 'configure' }` |
| **Severity** | MEDIUM |
| **Recovery** | recoverable (User fixes configuration) |
| **Caller responsibility** | `tool-invocation` (Case lifecycle) captures the error, keeps the Case in CREATED state. Reports the specific validation failure. |
| **User-facing message** | `"CESM configuration failed for Case '{name}': {error}. The Case remains in CREATED state. Check the compset, resolution, and machine target."` |
| **Internal log level** | WARN |
| **Spec refs** | `failure-modes.md` FM-M5; `features/cesm-submission.feature` (configure failure scenario) |

---

## C3 — Data Management

### FM-D1: Filesystem quota exceeded

| Field | Value |
|-------|-------|
| **Error type** | `DataError.QuotaExceeded` |
| **Discriminator** | `{ kind: 'quota_exceeded'; path: string; filesystem: string }` |
| **Severity** | HIGH |
| **Recovery** | fatal (stop and notify user — User must clean up or request more quota) |
| **Caller responsibility** | `data-management` detects ENOSPC or quota error. The ToolInvocation fails. No partial output is registered. `agent-interaction` reports the quota error and suggests cleanup. Does NOT delete old Datasets. |
| **User-facing message** | `"Filesystem quota exceeded on {filesystem}. The output write failed. No output has been registered. Please clean up old Datasets or temporary files, or request more quota, then retry."` |
| **Internal log level** | ERROR |
| **Spec refs** | `failure-modes.md` FM-D1 |

### FM-D2: Lustre/GPFS slowdown

| Field | Value |
|-------|-------|
| **Error type** | `DataError.LocationNotReadable` or `DataError.LocationNotWritable` (with `cause: 'slow'`) |
| **Discriminator** | `{ kind: 'location_not_readable' \| 'location_not_writable'; path: string; cause: 'slow'; elapsed: number }` |
| **Severity** | MEDIUM |
| **Recovery** | degradable (advise staging, reduce I/O) |
| **Caller responsibility** | `data-management` reports slow filesystem. `agent-interaction` advises the User to stage data on a faster filesystem or reduce I/O. Timeouts are generous for HPC filesystems. |
| **User-facing message** | `"Filesystem operations on {filesystem} are slow ({elapsed}s for last operation). Consider staging data on a faster filesystem (local scratch) or reducing I/O (chunked processing, fewer concurrent operations)."` |
| **Internal log level** | INFO |
| **Spec refs** | `failure-modes.md` FM-D2 |

### FM-D3: File not found / permission denied

| Field | Value |
|-------|-------|
| **Error type** | `DataError.LocationNotReadable` or `DataError.LocationNotWritable` |
| **Discriminator** | `{ kind: 'location_not_readable' \| 'location_not_writable'; path: string; cause: 'enoent' \| 'eacces' }` |
| **Severity** | HIGH |
| **Recovery** | recoverable (User provides correct path or permissions) |
| **Caller responsibility** | `data-management` reports the specific error. `tool-invocation` rejects the ToolInvocation before execution. `agent-interaction` suggests alternatives from the Dataset registry. |
| **User-facing message** | `"Dataset location '{path}' could not be accessed: {cause}. The ToolInvocation has been rejected. Please verify the path or select a different Dataset."` |
| **Internal log level** | WARN |
| **Spec refs** | `invariants.md` INV-D4; `failure-modes.md` FM-D3; `features/zarr-io.feature` (read-only scenario) |

### FM-D4: Concurrent write conflict

| Field | Value |
|-------|-------|
| **Error type** | `DataError` (wrapped as `ToolInvocationError.ConcurrentWriteConflict`) |
| **Discriminator** | `{ kind: 'concurrent_write_conflict'; path: string; existingInvocationId: ToolInvocationId }` |
| **Severity** | HIGH |
| **Recovery** | fatal (stop and notify user) |
| **Caller responsibility** | `agent-interaction` detects the duplicate (same Tool, parameters, inputs, output Location — X10) and refuses the second ToolInvocation before it starts. |
| **User-facing message** | `"Another ToolInvocation ({existingInvocationId}) is already writing to '{path}'. The second ToolInvocation has been refused to prevent output corruption."` |
| **Internal log level** | ERROR |
| **Spec refs** | `failure-modes.md` FM-D4; `cross-context/interactions.md` X10 (duplicated case) |

### FM-D5: Corrupted ZARR store

| Field | Value |
|-------|-------|
| **Error type** | `DataError.DatasetCorrupted` |
| **Discriminator** | `{ kind: 'dataset_corrupted'; datasetId: DatasetId; path: string; corruptionType: string }` |
| **Severity** | HIGH |
| **Recovery** | fatal (stop and notify user — Dataset is unusable) |
| **Caller responsibility** | `data-management` quarantines the Dataset. `provenance` (if a ProvenanceRecord exists) identifies the ToolInvocation that created the store, enabling investigation. `agent-interaction` notifies the User. |
| **User-facing message** | `"Dataset '{name}' at '{path}' is corrupted: {corruptionType}. The Dataset has been quarantined and is not available for downstream consumption. The ProvenanceRecord (if available) identifies the ToolInvocation that created this store."` |
| **Internal log level** | ERROR |
| **Spec refs** | `failure-modes.md` FM-D5; `features/zarr-io.feature` (corrupted store scenario) |

---

## C4 — Scheduling (SLURM)

### FM-S1: SLURM job rejection at submission

| Field | Value |
|-------|-------|
| **Error type** | `SchedulingError.RejectedByScheduler` |
| **Discriminator** | `{ kind: 'rejected_by_scheduler'; resourceRequest: ResourceRequest; slurmError: string }` |
| **Severity** | HIGH |
| **Recovery** | recoverable (User corrects ResourceRequest) |
| **Caller responsibility** | `scheduling` captures the SLURM error message. No Job is created (no JobID). `tool-invocation` / `agent-interaction` reports the specific rejection reason. Does NOT retry with the same ResourceRequest. |
| **User-facing message** | `"SLURM rejected the Job submission: {slurmError}. No Job was created. Check the ResourceRequest (partition, QoS, node count, wall time) and adjust accordingly."` |
| **Internal log level** | WARN |
| **Spec refs** | `failure-modes.md` FM-S1; `features/cesm-submission.feature` (SLURM rejection scenario) |

### FM-S2: SLURM daemon unavailable

| Field | Value |
|-------|-------|
| **Error type** | `SchedulingError.SchedulerUnavailable` |
| **Discriminator** | `{ kind: 'scheduler_unavailable'; command: string; error: string }` |
| **Severity** | CRITICAL |
| **Recovery** | degradable (synchronous tools still work; running Jobs continue on compute nodes) |
| **Caller responsibility** | `scheduling` marks all Job states as UNKNOWN (not COMPLETED, not RUNNING — INV-S1 caveat). Retries `squeue`/`sacct` with backoff (every 30s initially, backing off to every 5 min — R13). When SLURM recovers, reconciles via `sacct`. `agent-interaction` notifies the User. |
| **User-facing message** | `"SLURM is currently unreachable. All Job states are marked as UNKNOWN. Running Jobs on compute nodes are NOT affected and will continue. The Agent is retrying with backoff and will reconcile states when SLURM recovers. UNKNOWN is acceptable for up to 30 minutes during long-running runs."` |
| **Internal log level** | ERROR |
| **Spec refs** | `invariants.md` INV-S1; `resolutions.md` R13; `failure-modes.md` FM-S2; `features/job-management.feature` (scheduler unavailable scenario) |

### FM-S3: Stale queue data

| Field | Value |
|-------|-------|
| **Error type** | `SchedulingError.StaleQueueData` |
| **Discriminator** | `{ kind: 'stale_queue_data'; jobId: JobId; reportedState: JobState; actualState?: JobState }` |
| **Severity** | MEDIUM |
| **Recovery** | recoverable (query `sacct` for authoritative data) |
| **Caller responsibility** | `scheduling` trusts the most recent authoritative report. Terminal states are final (INV-S4) — once `sacct` shows TIMEOUT, a stale `squeue` RUNNING does not demote it. Does NOT reconcile with file existence. |
| **User-facing message** | (transparent to User — the Agent handles this internally. If the User queries a Job whose state was stale, the Agent reports the authoritative state from sacct.) |
| **Internal log level** | DEBUG |
| **Spec refs** | `invariants.md` INV-S1, INV-S4; `failure-modes.md` FM-S3; `features/job-management.feature` (stale data scenario) |

### FM-S4: Job timeout (wall time exceeded)

| Field | Value |
|-------|-------|
| **Error type** | `SchedulingError` (JobState TIMEOUT) → wrapped as `ToolInvocationError.SignalTerminated` |
| **Discriminator** | `{ kind: 'signal_terminated'; signalName: 'SIGTERM'; signalNumber: 15; jobState: 'TIMEOUT'; jobId: JobId }` |
| **Severity** | HIGH |
| **Recovery** | recoverable (resubmit with longer wall time) |
| **Caller responsibility** | `scheduling` reports TIMEOUT. `tool-invocation` reports the Signal (INV-T5). `agent-interaction` notifies the User. The ProvenanceRecord records TIMEOUT as the ExitOutcome. |
| **User-facing message** | `"Job {jobId} exceeded its wall time of {wallTime} and was terminated by SLURM (SIGTERM then SIGKILL). State: TIMEOUT. Consider resubmitting with a longer wall time."` |
| **Internal log level** | WARN |
| **Spec refs** | `invariants.md` INV-T5; `failure-modes.md` FM-S4, FM-M3; `features/job-management.feature` |

---

## C5 — Environment Management

### FM-E1: Module (uenv) not found

| Field | Value |
|-------|-------|
| **Error type** | `EnvironmentError.UenvNotFound` |
| **Discriminator** | `{ kind: 'uenv_not_found'; name: string; version: string }` |
| **Severity** | HIGH |
| **Recovery** | recoverable (User loads alternative uenv) |
| **Caller responsibility** | `environment-management` checks uenv availability via the uenv registry before attempting to mount (INV-E3). If not found, the load is refused. `tool-invocation` reports that the required Environment is not loaded. `agent-interaction` suggests alternative uenvs or versions. |
| **User-facing message** | `"uenv '{name}/{version}' is not available on this host. The Environment load has been refused. Please check the uenv name and version, or load an alternative."` |
| **Internal log level** | WARN |
| **Spec refs** | `invariants.md` INV-E3 (updated for uenv); `resolutions.md` R9; `failure-modes.md` FM-E1; `features/environment-management.feature` (module not found scenario) |

### FM-E2: Conflicting uenvs

| Field | Value |
|-------|-------|
| **Error type** | `EnvironmentError.ConflictDetected` |
| **Discriminator** | `{ kind: 'conflict_detected'; uenvA: UenvSpec; uenvB: UenvSpec; conflictPath: string; conflictType: 'path' \| 'library' \| 'compiler' }` |
| **Severity** | CRITICAL |
| **Recovery** | fatal (stop and notify user — User must choose) |
| **Caller responsibility** | `environment-management` detects the conflict before any Tool runs (INV-E2, updated for uenv: path-level, not soname-level). The load is rejected. `agent-interaction` reports the specific conflict and asks the User to choose. Does NOT merge conflicting Environments. |
| **User-facing message** | `"Conflict detected between uenv '{uenvA}' and '{uenvB}': both provide '{conflictPath}' with different versions ({conflictType}). Only one Environment may be active per execution context. Please purge the current Environment and load the desired one."` |
| **Internal log level** | ERROR |
| **Spec refs** | `invariants.md` INV-E1, INV-E2 (updated for uenv); `resolutions.md` R9; `failure-modes.md` FM-E2; `features/environment-management.feature` (conflict scenarios) |

### FM-E3: Partial uenv mount

| Field | Value |
|-------|-------|
| **Error type** | `EnvironmentError.PartialLoad` |
| **Discriminator** | `{ kind: 'partial_load'; loadedPaths: string[]; failedPaths: string[]; error: string }` |
| **Severity** | HIGH |
| **Recovery** | fatal (stop and notify user) |
| **Caller responsibility** | `environment-management` detects the partial mount (the Environment does not match the Tool's requirements). Purges all mounted paths from this load attempt. The Environment is marked as NOT active. `agent-interaction` reports which paths loaded and which failed. |
| **User-facing message** | `"Partial uenv mount: some paths loaded successfully ({loadedPaths}), but others failed ({failedPaths}). The Environment has been purged and is NOT active. Error: {error}. Please retry or choose an alternative uenv."` |
| **Internal log level** | ERROR |
| **Spec refs** | `invariants.md` INV-E2; `resolutions.md` R9; `failure-modes.md` FM-E3; `features/environment-management.feature` (partial load scenario) |

---

## C6 — Provenance

### FM-P1: ProvenanceRecord write failure

| Field | Value |
|-------|-------|
| **Error type** | `ProvenanceError.WriteFailed` |
| **Discriminator** | `{ kind: 'write_failed'; datasetId: DatasetId; error: string; retryCount: number }` |
| **Severity** | CRITICAL |
| **Recovery** | recoverable (retry with backoff); fatal if all retries fail |
| **Caller responsibility** | `provenance` retries the write with backoff. `tool-invocation` must NOT register the output Dataset as available (INV-D3). If all retries fail, `agent-interaction` notifies the User and the output Dataset is held in an unregistered state. |
| **User-facing message** | `"Failed to write ProvenanceRecord for Dataset '{name}' after {retryCount} retries. The Dataset has NOT been registered as available for downstream consumption — without Provenance, the Dataset is not scientifically valid. Error: {error}."` |
| **Internal log level** | ERROR |
| **Spec refs** | `invariants.md` INV-P1, INV-D3; `failure-modes.md` FM-P1; `features/provenance.feature` (write failure scenario) |

### FM-P2: Corrupted ProvenanceRecord

| Field | Value |
|-------|-------|
| **Error type** | `ProvenanceError.RecordCorrupted` |
| **Discriminator** | `{ kind: 'record_corrupted'; datasetId: DatasetId; corruptionType: string }` |
| **Severity** | CRITICAL |
| **Recovery** | degradable (quarantine affected Dataset only, not entire store — R11) |
| **Caller responsibility** | `provenance` quarantines the affected Dataset (not the entire store — R11). Attempts to reconstruct the ProvenanceRecord from available metadata. If reconstruction fails, `agent-interaction` notifies the User and the Dataset remains quarantined. Other Datasets with valid ProvenanceRecords remain available. |
| **User-facing message** | `"The ProvenanceRecord for Dataset '{name}' is corrupted ({corruptionType}). The Dataset has been quarantined and is not available for downstream consumption. The Agent is attempting to reconstruct the record from available metadata. Other Datasets remain available."` |
| **Internal log level** | ERROR |
| **Spec refs** | `resolutions.md` R11 (local, not systemic); `failure-modes.md` FM-P2; `features/provenance.feature` (corrupted record scenario) |

### FM-P3: Missing ProvenanceRecord before consumption

| Field | Value |
|-------|-------|
| **Error type** | `DataError.ProvenanceMissing` |
| **Discriminator** | `{ kind: 'provenance_missing'; datasetId: DatasetId; workflowStepId?: string }` |
| **Severity** | CRITICAL |
| **Recovery** | fatal (stop and notify user) |
| **Caller responsibility** | `data-management` (via `markConsumable`) checks `provenance.verifyProvenance()`. If no ProvenanceRecord exists, the Dataset is not marked consumable. `agent-interaction` (Workflow) blocks the WorkflowStep. The User is notified and may provide the missing Provenance manually or regenerate the Dataset. |
| **User-facing message** | `"Dataset '{name}' has no ProvenanceRecord and cannot be consumed by WorkflowStep '{step}'. The step has been blocked. You may provide the missing Provenance information manually or regenerate the Dataset."` |
| **Internal log level** | ERROR |
| **Spec refs** | `invariants.md` INV-D3, INV-P3, INV-W1; `failure-modes.md` FM-P3; `features/provenance.feature`, `features/workflow-execution.feature` |

---

## C7 — Agent Interaction

### FM-A1: LLM hallucinates Tool name

| Field | Value |
|-------|-------|
| **Error type** | `AgentError.LlmHallucinatedTool` |
| **Discriminator** | `{ kind: 'llm_hallucinated_tool'; requestedTool: string; availableTools: string[] }` |
| **Severity** | HIGH |
| **Recovery** | recoverable — **refuse and ask** (R12, ADR-010) |
| **Caller responsibility** | `agent-interaction` (via `validateAction`) checks the Tool name against the catalog before creating a ToolInvocation. If not found, the Agent refuses and asks the User for clarification. Does NOT invoke a non-existent Tool. Does NOT silently substitute a different Tool. |
| **User-facing message** | `"The Tool '{requestedTool}' is not in the catalog. Available Tools: {availableTools, list}. Please clarify which Tool you would like to use."` |
| **Internal log level** | WARN |
| **Spec refs** | `resolutions.md` R12 (refuse and ask); `failure-modes.md` FM-A1; `cross-context/interactions.md` X10 |

### FM-A2: LLM hallucinates parameters

| Field | Value |
|-------|-------|
| **Error type** | `AgentError.LlmHallucinatedParameters` |
| **Discriminator** | `{ kind: 'llm_hallucinated_parameters'; toolId: ToolId; invalidParameters: string[]; schema: object }` |
| **Severity** | HIGH |
| **Recovery** | recoverable — **refuse and ask** (R12, ADR-010) |
| **Caller responsibility** | `agent-interaction` (via `validateAction`) validates parameters against the Tool's schema and the input Dataset's metadata before invocation. If validation fails, the Agent refuses and asks the User. Does NOT invoke with unvalidated parameters (incorrect parameters may produce plausible-looking but wrong output). |
| **User-facing message** | `"The parameters {invalidParameters} for Tool '{toolId}' are invalid. Please check the parameter values against the Tool's schema and the input Dataset's metadata."` |
| **Internal log level** | WARN |
| **Spec refs** | `resolutions.md` R12 (refuse and ask); `failure-modes.md` FM-A2; `cross-context/interactions.md` X10 |

### FM-A3: Context window exceeded

| Field | Value |
|-------|-------|
| **Error type** | `AgentError.ContextWindowExceeded` |
| **Discriminator** | `{ kind: 'context_window_exceeded'; tokenCount: number; limit: number }` |
| **Severity** | MEDIUM |
| **Recovery** | degradable (summarize, compact, or start a new Session) |
| **Caller responsibility** | `agent-interaction` summarizes or compacts the Session context (replaces ToolInvocation details with summaries, keeps only recent Datasets and ProvenanceRecords). The User is notified that context was compacted. Alternatively, suggests starting a new Session (leveraging INV-W4 and INV-P4). Does NOT silently drop context. Does NOT lose track of running Jobs. |
| **User-facing message** | `"The Session context has been compacted to fit within the model's context window ({tokenCount} → {limit} tokens). Recent ToolInvocations have been summarized. Running Jobs and their ProvenanceRecords are preserved. If you need more detail, consider starting a new Session."` |
| **Internal log level** | INFO |
| **Spec refs** | `failure-modes.md` FM-A3; `invariants.md` INV-W4, INV-P4 |

### FM-A4: Model (LLM) unavailable

| Field | Value |
|-------|-------|
| **Error type** | `AgentError.LlmUnavailable` |
| **Discriminator** | `{ kind: 'llm_unavailable'; error: string; retryCount: number }` |
| **Severity** | HIGH |
| **Recovery** | degradable (running Jobs continue; User notified) |
| **Caller responsibility** | `agent-interaction` notifies the User that the model is unavailable. Running Jobs and ToolInvocations are NOT affected — they execute on the HPC independently. Retries the LLM with backoff. Does NOT cancel running Jobs. |
| **User-facing message** | `"The language model is currently unavailable. Running Jobs and ToolInvocations on the HPC are NOT affected and will continue. The Agent is retrying with backoff. You can continue to query Job and Dataset status."` |
| **Internal log level** | WARN |
| **Spec refs** | `failure-modes.md` FM-A4 |

---

## Cross-Cutting

### FM-X1: Network partition on compute nodes

| Field | Value |
|-------|-------|
| **Error type** | N/A (expected state, not a failure) |
| **Severity** | MEDIUM |
| **Recovery** | N/A |
| **Caller responsibility** | `agent-interaction` does not attempt to reach compute nodes directly. All communication is through SLURM and the shared filesystem. |
| **User-facing message** | (none — this is the expected operating condition) |
| **Internal log level** | DEBUG |
| **Spec refs** | `failure-modes.md` FM-X1 |

### FM-X2: Login node network loss

| Field | Value |
|-------|-------|
| **Error type** | `AgentError.NetworkLost` |
| **Discriminator** | `{ kind: 'network_lost'; node: string }` |
| **Severity** | HIGH |
| **Recovery** | fatal (stop and notify user) |
| **Caller responsibility** | `agent-interaction` detects the network loss and notifies the User (if possible). Running Jobs continue on compute nodes. The Agent does not make assumptions about Job states. |
| **User-facing message** | `"Network connectivity has been lost on the login node. Running Jobs on compute nodes are NOT affected. The Agent cannot reach the LLM, SLURM, or remote Datasets until network is restored."` |
| **Internal log level** | ERROR |
| **Spec refs** | `failure-modes.md` FM-X2 |

### FM-X3: dsh framework breaking change

| Field | Value |
|-------|-------|
| **Error type** | `DshAdapterError.FrameworkBreakingChange` |
| **Discriminator** | `{ kind: 'framework_breaking_change'; dshVersion: string; affectedExtensionPoint: string }` |
| **Severity** | CRITICAL |
| **Recovery** | fatal (stop, pin to previous version, do not upgrade without full test suite) |
| **Caller responsibility** | `dsh-adapter` is the isolation layer (ADR-005). The dsh version is pinned. The full test suite (Tier 3) is run before merging any dsh upgrade. |
| **User-facing message** | (none — this is a developer concern, not a user-facing error) |
| **Internal log level** | CRITICAL |
| **Spec refs** | `assumptions.md` A1; `failure-modes.md` FM-X3; ADR-005 |

### FM-X4: opengrads build failure (if attempted)

| Field | Value |
|-------|-------|
| **Error type** | `ToolInvocationError.NonZeroExitCode` (with `phase: 'build'`, `toolId: 'opengrads'`) |
| **Discriminator** | `{ kind: 'non_zero_exit_code'; exitCode: number; stderr: string; toolId: 'opengrads'; phase: 'build' }` |
| **Severity** | MEDIUM (opengrads is not a required Tool — R10) |
| **Recovery** | recoverable (record failure, exclude opengrads from catalog) |
| **Caller responsibility** | `tool-invocation` records the build failure and its cause. opengrads is excluded from the Tool catalog. `agent-interaction` notifies the User and suggests alternative tools (matplotlib, cartopy, xarray). |
| **User-facing message** | `"opengrads build failed: {stderr}. opengrads has been excluded from the Tool catalog. Consider using Python tools (matplotlib, cartopy, xarray) for visualization."` |
| **Internal log level** | WARN |
| **Spec refs** | `resolutions.md` R10; `failure-modes.md` FM-X4; `features/opengrads-evaluation.feature` |

### FM-X5: External mutation of Dataset

| Field | Value |
|-------|-------|
| **Error type** | `DataError.DatasetCorrupted` (with `cause: 'external_mutation'`) |
| **Discriminator** | `{ kind: 'dataset_corrupted'; datasetId: DatasetId; corruptionType: 'external_mutation'; detectedVia: 'mtime_mismatch' \| 'checksum_mismatch' }` |
| **Severity** | HIGH |
| **Recovery** | fatal (stop and notify user — Dataset is untrustworthy) |
| **Caller responsibility** | `data-management` detects the mismatch (file modification time does not match the ProvenanceRecord timestamp). The Dataset is flagged as untrustworthy and quarantined. `agent-interaction` notifies the User. The Agent's own behavior never modifies a created Dataset. |
| **User-facing message** | `"Dataset '{name}' has been modified externally (detected via {detectedVia}). The Dataset no longer matches its ProvenanceRecord and is untrustworthy. It has been quarantined. Do not use this Dataset for downstream operations without verification."` |
| **Internal log level** | ERROR |
| **Spec refs** | `invariants.md` INV-D1 (caveat); `failure-modes.md` FM-X5 |

---

## Summary Table (Updated for Resolutions)

| ID | Component | Error type | Severity | Recovery | Caller module |
|----|-----------|------------|----------|----------|---------------|
| FM-T1 | C1 Tool | `SignalTerminated` | HIGH | fatal | tool-invocation |
| FM-T2 | C1 Tool | `SignalTerminated` | HIGH | fatal | tool-invocation |
| FM-T3 | C1 Tool | `NonZeroExitCode` | MEDIUM | degradable (opt-in) | tool-invocation |
| FM-T4 | C1 Tool | `NonZeroExitCode` | MEDIUM | recoverable | tool-invocation |
| FM-T5 | C1 Tool | `InputNotFound` | HIGH | recoverable | tool-invocation |
| FM-M1 | C1 CESM | `NonZeroExitCode` | HIGH | recoverable | tool-invocation (Case) |
| FM-M2 | C1 CESM | `NonZeroExitCode` | CRITICAL | fatal | tool-invocation (Case) |
| FM-M3 | C1 CESM | `SignalTerminated` | HIGH | recoverable | tool-invocation (Case) |
| FM-M4 | C1 CESM | `SchedulingError` | HIGH | recoverable | scheduling → tool-invocation |
| FM-M5 | C1 CESM | `NonZeroExitCode` | MEDIUM | recoverable | tool-invocation (Case) |
| FM-D1 | C3 Data | `QuotaExceeded` | HIGH | fatal | data-management |
| FM-D2 | C3 Data | `LocationNotReadable/Writable` | MEDIUM | degradable | data-management |
| FM-D3 | C3 Data | `LocationNotReadable/Writable` | HIGH | recoverable | data-management |
| FM-D4 | C3 Data | `ConcurrentWriteConflict` | HIGH | fatal | agent-interaction |
| FM-D5 | C3 Data | `DatasetCorrupted` | HIGH | fatal | data-management |
| FM-S1 | C4 SLURM | `RejectedByScheduler` | HIGH | recoverable | scheduling |
| FM-S2 | C4 SLURM | `SchedulerUnavailable` | CRITICAL | degradable | scheduling |
| FM-S3 | C4 SLURM | `StaleQueueData` | MEDIUM | recoverable | scheduling |
| FM-S4 | C4 SLURM | `SignalTerminated` | HIGH | recoverable | scheduling → tool-invocation |
| FM-E1 | C5 Env | `UenvNotFound` | HIGH | recoverable | environment-management |
| FM-E2 | C5 Env | `ConflictDetected` | CRITICAL | fatal | environment-management |
| FM-E3 | C5 Env | `PartialLoad` | HIGH | fatal | environment-management |
| FM-P1 | C6 Prov | `WriteFailed` | CRITICAL | recoverable→fatal | provenance |
| FM-P2 | C6 Prov | `RecordCorrupted` | CRITICAL | degradable (local) | provenance |
| FM-P3 | C6 Prov | `ProvenanceMissing` | CRITICAL | fatal | data-management |
| FM-A1 | C7 Agent | `LlmHallucinatedTool` | HIGH | recoverable (refuse+ask) | agent-interaction |
| FM-A2 | C7 Agent | `LlmHallucinatedParameters` | HIGH | recoverable (refuse+ask) | agent-interaction |
| FM-A3 | C7 Agent | `ContextWindowExceeded` | MEDIUM | degradable | agent-interaction |
| FM-A4 | C7 Agent | `LlmUnavailable` | HIGH | degradable | agent-interaction |
| FM-X1 | Cross | N/A | MEDIUM | N/A | agent-interaction |
| FM-X2 | Cross | `NetworkLost` | HIGH | fatal | agent-interaction |
| FM-X3 | Cross | `FrameworkBreakingChange` | CRITICAL | fatal | dsh-adapter |
| FM-X4 | Cross | `NonZeroExitCode` | MEDIUM | recoverable | tool-invocation |
| FM-X5 | Cross | `DatasetCorrupted` | HIGH | fatal | data-management |
