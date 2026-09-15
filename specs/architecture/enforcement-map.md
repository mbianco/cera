# Enforcement Map — cera

> Maps every invariant from `invariants.md` (updated per
> `resolutions.md`) to an enforcement point, mechanism, status, and
> violation handling.
>
> After R1, C2 (Model Execution) is collapsed into C1. INV-M1–M4 are
> renumbered as INV-T6–T9. Total: **28 invariants** (9 C1, 4 C3, 4 C4,
> 3 C5, 4 C6, 4 C7).

---

## C1 — Tool Invocation (including CESM)

### INV-T1: Environment loaded before invocation

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `tool-invocation.invokeTool()` — pre-execution gate. Calls `environment-management.verifyEnvironment()` immediately before entering RUNNING state. |
| **Enforcement mechanism** | Runtime check. If `verifyEnvironment()` returns false or throws, the ToolInvocation is rejected with `ToolInvocationError.EnvironmentNotLoaded`. Type system: `ToolInvocationRequest` requires an `EnvironmentId` reference. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | `ToolInvocationError.EnvironmentNotLoaded` (FM-E1, FM-E3). ToolInvocation remains in NOT_STARTED state. No output is produced. The User is offered to load the required Environment. |
| **Spec refs** | `invariants.md` INV-T1; `cross-context/interactions.md` X1; `features/cdo-operations.feature` (env not loaded scenario); `features/environment-management.feature` (env required by Tool scenario) |

### INV-T2: Single exit outcome per invocation

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `tool-invocation.invokeTool()` — post-execution result construction. The `ExitOutcome` type is a discriminated union: either `{ kind: 'exit_code'; code: number }` or `{ kind: 'signal'; name: string; number: number }`, never both, never neither. |
| **Enforcement mechanism** | Type system (discriminated union makes both-null and both-set impossible at the type level). Runtime assertion: once `state ∈ {COMPLETED, FAILED}`, exactly one variant is non-null. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | Type error at compile time. Runtime assertion failure triggers `ToolInvocationError` (internal error — should never occur if types are correct). |
| **Spec refs** | `invariants.md` INV-T2 |

### INV-T3: Output registration gated on success

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `tool-invocation.invokeTool()` — post-execution gate. After the ToolInvocation terminates, the ExitOutcome is checked. If success (exit code 0, or in `permissiveExitCodes` per R4), the output Dataset is registered via `data-management.registerDataset()` and a ProvenanceRecord is written. If failure, no output Dataset is registered. |
| **Enforcement mechanism** | Runtime check. The `permissiveExitCodes` field on `ToolInvocationRequest` is empty by default (R4: strict). The check is: `exitOutcome.kind === 'exit_code' && (exitOutcome.code === 0 || permissiveExitCodes.includes(exitOutcome.code))`. Signal termination always blocks registration. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | If the ExitOutcome does not indicate success, the output Dataset is NOT registered. A ProvenanceRecord is still written (with null output) to record the failure. The User is notified. |
| **Spec refs** | `invariants.md` INV-T3; `resolutions.md` R4 (strict default); `cross-context/interactions.md` X3, X4; `features/cdo-operations.feature` (exit code scenarios) |

### INV-T4: Input immutability during invocation

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `tool-invocation.invokeTool()` — filesystem access policy. Input Datasets are opened for reading only, never for writing. The Agent does not hand out write handles to inputs. |
| **Enforcement mechanism** | Runtime check. The `dsh-adapter.FilesystemGateway` is used with `'read'` mode for input Datasets. The Agent does not recommend modifying an input Dataset while a consuming ToolInvocation is RUNNING. Test assertion: verify no write handle is opened for an input Dataset during a ToolInvocation. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | If an external process modifies the input during the invocation, the result is flagged as potentially compromised (FM-X5). The Agent cannot enforce this at the OS level (INV-D1 caveat), but the Agent's own behavior never violates it. |
| **Spec refs** | `invariants.md` INV-T4; `failure-modes.md` FM-X5; `features/cdo-operations.feature` (concurrent modification scenario) |

### INV-T5: Signal vs. exit-code distinction preserved

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `tool-invocation.invokeTool()` — process termination handling. The `ExitOutcome` discriminated union ensures signals and exit codes are distinct. The module maps OS-reported signals to the `signal` variant and never to a synthetic exit code. |
| **Enforcement mechanism** | Type system (ExitOutcome is a discriminated union). Runtime: the `dsh-adapter.SubprocessRunner` / `ShellExecutor` distinguishes signal death from normal exit via the OS process status. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | If a signal is reported, `ExitOutcome.kind = 'signal'` with the signal name and number. `exitCode` is null (type system enforces this). The User is notified of the signal (FM-T1, FM-T2). |
| **Spec refs** | `invariants.md` INV-T5; `features/cdo-operations.feature` (signal scenarios) |

### INV-T6: Submit requires built Case (formerly INV-M1)

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `tool-invocation.submitCase()` — pre-submission gate. Checks `case.state === 'BUILT'` before calling `scheduling.submitJob()`. |
| **Enforcement mechanism** | Runtime check. `CaseState` is a union type with a finite set of values. The `submitCase()` function has a precondition assertion: `if (case.state !== 'BUILT') throw ToolInvocationError.CaseNotBuilt`. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | `ToolInvocationError.CaseNotBuilt` (FM-M1). The Case remains in its current state (CREATED or CONFIGURED). No Job is created. The User is advised to build the Case first. |
| **Spec refs** | `invariants.md` INV-M1 (now INV-T6 per R1); `resolutions.md` R1; `features/cesm-submission.feature` (submit unbuilt Case scenario) |

### INV-T7: One running Job per Case (formerly INV-M2)

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `tool-invocation.submitCase()` — pre-submission gate. Checks that no existing Job for this Case is in RUNNING state (via `scheduling.queryJob()`). |
| **Enforcement mechanism** | Runtime check. The Case aggregates its Job references. Before `submitCase()`, the module queries `scheduling.queryJob(case.jobId)` if `case.jobId` is non-null. If the Job is RUNNING, submission is rejected. Resubmission requires the prior Job to have reached a terminal state (INV-S4). |
| **Status** | ENFORCED (designed) |
| **Violation handling** | `ToolInvocationError.CaseAlreadyRunning`. The User is notified that the Case already has a RUNNING Job. |
| **Spec refs** | `invariants.md` INV-M2 (now INV-T7 per R1); `resolutions.md` R1; `features/cesm-submission.feature` (resubmission while RUNNING scenario) |

### INV-T8: Run length bounded by Wall Time (formerly INV-M3)

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `tool-invocation.submitCase()` — pre-submission validation. Compares `case.runLength` against `resourceRequest.wallTime`. |
| **Enforcement mechanism** | Runtime check. `if (case.runLength > resourceRequest.wallTime) throw ToolInvocationError.RunLengthExceedsWallTime`. The comparison is done at submission time, not at runtime. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | `ToolInvocationError.RunLengthExceedsWallTime`. The submission is rejected. The User is advised to increase the wall time or use restart files. |
| **Spec refs** | `invariants.md` INV-M3 (now INV-T8 per R1); `resolutions.md` R1; `features/cesm-submission.feature` (run length exceeds wall time scenario) |

### INV-T9: Output tree location known before submission (formerly INV-M4)

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `tool-invocation.createCase()` — sets `case.outputTreeLocation` at creation time (R5). `tool-invocation.submitCase()` — validates `case.outputTreeLocation` is non-null and writable before submission. |
| **Enforcement mechanism** | Runtime check. `createCase()` determines and sets the output tree Location (R5: always the same, determined at Case creation). `submitCase()` validates the Location is writable via `data-management.validateLocation(location, 'write')`. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | `ToolInvocationError.OutputLocationNotSet` or `DataError.LocationNotWritable`. The submission is rejected. |
| **Spec refs** | `invariants.md` INV-M4 (now INV-T9 per R1); `resolutions.md` R1, R5 (output location fixed at creation); `features/cesm-submission.feature` (output tree location scenarios) |

---

## C3 — Data Management

### INV-D1: Dataset immutability

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `data-management.registerDataset()` — creates a new Dataset, never modifies an existing one. `tool-invocation.invokeTool()` — opens input Datasets for reading only. |
| **Enforcement mechanism** | Runtime check + type system. `Dataset` type is immutable (all fields are `readonly`). `registerDataset()` always creates a new entity with a new identity. No write handle is ever opened for an input Dataset. The Agent's own behavior never modifies a created Dataset (external mutation is flagged via FM-X5). |
| **Status** | ENFORCED (designed) |
| **Violation handling** | External mutation is detected via mtime/checksum mismatch (FM-X5). The Dataset is flagged as untrustworthy and quarantined. The Agent's own behavior cannot violate this invariant by design. |
| **Spec refs** | `invariants.md` INV-D1; `failure-modes.md` FM-X5; `features/grid-conversion.feature` (immutability scenario); `features/zarr-io.feature` (original unchanged scenario) |

### INV-D2: One Format, one Grid per Dataset

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `data-management.registerDataset()` — validates `format` and `grid` are non-null. These fields are `readonly` on the `Dataset` type. |
| **Enforcement mechanism** | Type system. `Dataset.format: Format` and `Dataset.grid: Grid` are non-nullable, readonly fields. `Format` is a union: `'netcdf' | 'zarr' | 'grib2'`. `Grid` is a tagged union. A "format conversion" or "grid conversion" calls `registerDataset()` with different values, producing a new Dataset. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | Type error at compile time if code attempts to mutate `format` or `grid`. Runtime: `registerDataset()` rejects null format/grid. |
| **Spec refs** | `invariants.md` INV-D2; `features/grid-conversion.feature` (one Grid per Dataset scenario) |

### INV-D3: Provenance before consumption

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `data-management.markConsumable()` — calls `provenance.verifyProvenance(datasetId)` before marking the Dataset as available. `agent-interaction.startWorkflow()` — checks `provenance.verifyProvenance()` for each step's input Datasets before starting the step (INV-W1). |
| **Enforcement mechanism** | Runtime check. `markConsumable()` throws `DataError.ProvenanceMissing` if `verifyProvenance()` returns false. `startWorkflow()` checks each input Dataset and blocks the step if Provenance is missing. |
| **Status** | ENFORCED (designed) — jointly owned by C3 and C6 |
| **Violation handling** | `DataError.ProvenanceMissing` (FM-P3). The Dataset is not marked consumable. The WorkflowStep is blocked. The User is notified and may provide the missing Provenance or regenerate the Dataset. |
| **Spec refs** | `invariants.md` INV-D3, INV-P3 (jointly owned); `cross-context/interactions.md` X7; `features/provenance.feature` (missing ProvenanceRecord scenario); `features/workflow-execution.feature` (step lacks Provenance scenario) |

### INV-D4: Location resolves to a real path before use

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `data-management.validateLocation()` — called by `tool-invocation.invokeTool()` immediately before the ToolInvocation reads or writes a Dataset's Location. |
| **Enforcement mechanism** | Runtime check. `validateLocation(location, 'read')` checks the path exists and is readable. `validateLocation(location, 'write')` checks the path is writable (or its parent directory is writable for new files). Uses `dsh-adapter.FilesystemGateway.exists()`, `.isReadable()`, `.isWritable()`. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | `DataError.LocationNotReadable` or `DataError.LocationNotWritable` (FM-D3). The ToolInvocation is rejected before execution. |
| **Spec refs** | `invariants.md` INV-D4; `failure-modes.md` FM-D3; `features/cdo-operations.feature` (missing input scenario) |

---

## C4 — Scheduling (SLURM)

### INV-S1: Scheduler is authoritative for Job State

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `scheduling.queryJob()` — returns JobState directly from SLURM output (`squeue`, `sacct`). The module never infers states from file existence, process presence, or elapsed time. |
| **Enforcement mechanism** | Runtime design. The `SchedulingService.queryJob()` implementation only parses SLURM output. There is no code path that sets JobState based on file existence or elapsed time. When SLURM is unreachable, the module sets JobState to `UNKNOWN` (not COMPLETED, not RUNNING). |
| **Status** | ENFORCED (designed) |
| **Violation handling** | If SLURM is unreachable, JobState is set to `UNKNOWN` (R13: acceptable for up to 30 minutes). The module retries with backoff and reconciles via `sacct` when SLURM recovers. The module never silently promotes a Job to COMPLETED or RUNNING based on non-Scheduler evidence. |
| **Spec refs** | `invariants.md` INV-S1; `resolutions.md` R13; `failure-modes.md` FM-S2; `features/job-management.feature` (scheduler authoritative scenario) |

### INV-S2: Resource Request immutable after submission

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `scheduling.submitJob()` — after submission, the `Job.resourceRequest` field is `readonly`. The module exposes no method to modify a submitted Job's ResourceRequest. |
| **Enforcement mechanism** | Type system. `Job.resourceRequest: ResourceRequest` is a `readonly` field. `ResourceRequest` itself is an immutable type (all fields readonly). The API exposes no `updateResourceRequest()` method. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | Type error at compile time. Runtime: the User is advised that changing resources requires cancelling and resubmitting. |
| **Spec refs** | `invariants.md` INV-S2; `features/job-management.feature` (ResourceRequest immutable scenario) |

### INV-S3: Unique JobID

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `scheduling.submitJob()` — the JobID is assigned by SLURM (`sbatch`), never generated by the Agent. |
| **Enforcement mechanism** | Runtime design. The `SchedulingService.submitJob()` implementation parses the JobID from `sbatch` output. There is no code path that generates a JobID client-side. `Job.jobId: JobId` is non-nullable after submission. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | If `sbatch` does not return a JobID, the submission is treated as failed (`SchedulingError.RejectedByScheduler`). |
| **Spec refs** | `invariants.md` INV-S3; `features/job-management.feature` (unique JobID scenario) |

### INV-S4: Terminal state is final

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `scheduling.queryJob()` — once a terminal state (COMPLETED, FAILED, TIMEOUT, CANCELLED, OUT_OF_MEMORY, NODE_FAIL) is observed, subsequent queries that return non-terminal states are treated as stale and ignored. |
| **Enforcement mechanism** | Runtime check. The `Job` type has a `terminalState: JobState | null` field that is set once a terminal state is observed. `queryJob()` checks: if `job.terminalState !== null`, ignore any non-terminal state from stale `squeue` output. Use `sacct` for historical data (authoritative for terminal states). |
| **Status** | ENFORCED (designed) |
| **Violation handling** | Stale `squeue` data showing RUNNING after COMPLETED is ignored (FM-S3). The Agent does not treat reaped Jobs as still running. |
| **Spec refs** | `invariants.md` INV-S4; `failure-modes.md` FM-S3; `features/job-management.feature` (terminal state is final scenario) |

---

## C5 — Environment Management (uenv)

### INV-E1: One active Environment per execution context

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `environment-management.loadUenv()` — before mounting a new uenv, checks for conflicts with the currently active Environment. If conflicting, the load is rejected (the User must purge first). |
| **Enforcement mechanism** | Runtime check. `loadUenv()` calls `detectConflicts()` comparing the new uenv against the currently active Environment. If conflicts are found, `EnvironmentError.ConflictDetected` is thrown. If no conflicts, the new uenv is mounted and becomes part of the active Environment. |
| **Status** | ENFORCED (designed) — updated for uenv semantics: multiple uenvs may be mounted simultaneously if complementary (no path conflicts), but only one logical Environment (the set of active mount paths in PATH/LD_LIBRARY_PATH) is active at a time. |
| **Violation handling** | `EnvironmentError.ConflictDetected` (FM-E2). The load is rejected. The User is notified of the specific conflict and advised to purge the current Environment first. |
| **Spec refs** | `invariants.md` INV-E1; `resolutions.md` R9 (uenv, multiple mounts possible); `features/environment-management.feature` (one active Environment scenarios) |

### INV-E2: Conflict detection before execution

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `environment-management.loadUenv()` — calls `detectConflicts()` before mounting. `tool-invocation.invokeTool()` — calls `environment-management.verifyEnvironment()` immediately before the ToolInvocation starts. |
| **Enforcement mechanism** | Runtime check. Conflict detection is at the filesystem path level (R9: uenv conflicts are path-level, not soname-level). Two uenvs conflict if they provide different versions of the same library at paths that would both appear in `LD_LIBRARY_PATH` or `PATH`. `verifyEnvironment()` re-checks for conflicts that may have appeared since the initial load. |
| **Status** | ENFORCED (designed) — updated for uenv path-level conflict detection |
| **Violation handling** | `EnvironmentError.ConflictDetected` (FM-E2). The load is rejected before any Tool runs. The ToolInvocation is rejected if the Environment is found to have conflicts at re-verification. |
| **Spec refs** | `invariants.md` INV-E2; `resolutions.md` R9 (path-level conflicts); `cross-context/interactions.md` X1; `features/environment-management.feature` (conflict detection scenarios) |

### INV-E3: Module (uenv) availability verified before load

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `environment-management.loadUenv()` — calls `checkUenvAvailability()` before attempting to mount. |
| **Enforcement mechanism** | Runtime check. `checkUenvAvailability()` queries the uenv registry/mount system (replaces `module avail` / `module spider` per R9). If the uenv does not exist, `EnvironmentError.UenvNotFound` is thrown before any mount is attempted. |
| **Status** | ENFORCED (designed) — updated for uenv registry/mount check |
| **Violation handling** | `EnvironmentError.UenvNotFound` (FM-E1). The load is refused. The User is notified with the specific uenv name and version. |
| **Spec refs** | `invariants.md` INV-E3; `resolutions.md` R9 (uenv registry, not module avail); `features/environment-management.feature` (module availability scenarios) |

> **SPEC GAP:** `features/environment-management.feature` still
> references `module avail` and `module spider`. These commands are
> Lmod-specific and must be replaced with uenv registry/mount checks.
> See `specs/escalations/001-environment-feature-needs-uenv-rewrite.md`.

---

## C6 — Provenance

### INV-P1: ProvenanceRecord immutability

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `provenance.writeProvenanceRecord()` — creates a new immutable record. The `ProvenanceRecord` type is immutable (all fields readonly). No update method is exposed. |
| **Enforcement mechanism** | Type system. `ProvenanceRecord` has all `readonly` fields. The API exposes `writeProvenanceRecord()` (create) and `queryProvenanceRecord()` (read), but no `updateProvenanceRecord()`. Corrections create a new record linked to the original via a "corrects" relationship. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | Type error at compile time if code attempts to mutate a ProvenanceRecord. Runtime: write operations always create new records. |
| **Spec refs** | `invariants.md` INV-P1; `features/provenance.feature` (immutability scenario) |

### INV-P2: Provenance captures full reproducibility tuple

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `provenance.writeProvenanceRecord()` — validates all fields (tool, parameters, environment, inputs, output, timestamp, exitOutcome) are non-null before writing. |
| **Enforcement mechanism** | Runtime check. `writeProvenanceRecord()` validates each field of the `WriteProvenanceInput`. If any field in the reproducibility tuple is null (except `output` for failed invocations, and `jobId`/`jobState` for non-Job records), `ProvenanceError.MissingField` is thrown. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | `ProvenanceError.MissingField` (INV-P2). The record is not written. The User is notified of which field is missing. |
| **Spec refs** | `invariants.md` INV-P2; `features/provenance.feature` (full tuple scenario, missing field scenario) |

### INV-P3: Provenance exists before consumption (restated)

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `data-management.markConsumable()` — calls `provenance.verifyProvenance()`. `agent-interaction.startWorkflow()` — checks Provenance for each step's input Datasets. |
| **Enforcement mechanism** | Runtime check. Same as INV-D3 (jointly owned). |
| **Status** | ENFORCED (designed) — jointly owned by C3 and C6 |
| **Violation handling** | Same as INV-D3. |
| **Spec refs** | `invariants.md` INV-P3, INV-D3; `cross-context/interactions.md` X7 |

### INV-P4: Provenance survives Session end

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `provenance.writeProvenanceRecord()` — persists to a filesystem store that is independent of Session lifecycle. `provenance.queryProvenanceRecord()` — queries across Sessions by Dataset identity. |
| **Enforcement mechanism** | Runtime design. The Provenance store is filesystem-based on the HPC system (via `dsh-adapter.FilesystemGateway`). Records are keyed by Dataset identity and are not scoped to a Session. A query in Session `s2` finds records written in Session `s1`. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | If the Provenance store is unavailable (filesystem error), `ProvenanceError.WriteFailed` (FM-P1) for new writes. Existing records remain on the filesystem. |
| **Spec refs** | `invariants.md` INV-P4; `resolutions.md` R6 (Workflow persists, Provenance persists); `features/provenance.feature` (cross-session query scenarios) |

---

## C7 — Agent Interaction (including Experiment, Workflow)

### INV-W1: Step inputs exist before step starts

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Enforcement point** | `agent-interaction.startWorkflow()` — for each WorkflowStep, checks that all declared input Datasets exist in `data-management` and have Provenance in `provenance`. |
| **Enforcement mechanism** | Runtime check. For each input Dataset `d` of a step: `data-management.queryDataset(d.id)` must return non-null AND `provenance.verifyProvenance(d.id)` must return true. If either fails, the step is blocked (WorkflowState = BLOCKED). |
| **Status** | ENFORCED (designed) |
| **Violation handling** | `DataError.ProvenanceMissing` (FM-P3). The WorkflowStep does not start. WorkflowState = BLOCKED. The User is notified which Dataset is missing or lacks Provenance. |
| **Spec refs** | `invariants.md` INV-W1, INV-D3; `features/workflow-execution.feature` (step inputs must exist scenarios) |

### INV-W2: Failure halts downstream

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `agent-interaction.startWorkflow()` — Workflow execution loop. When a WorkflowStep fails (non-success ExitOutcome, or Job reaches non-COMPLETED terminal State), dependent downstream steps are not started. |
| **Enforcement mechanism** | Runtime check. The Workflow execution loop tracks each step's state. When a step fails, the loop sets `workflow.state = FAILED` and notifies the User. Dependent steps remain in `NOT_STARTED` state. The User must explicitly resume after addressing the failure. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | WorkflowState = FAILED. Downstream steps are not started. The User is notified that `{stepName}` failed and downstream steps are halted. |
| **Spec refs** | `invariants.md` INV-W2; `features/workflow-execution.feature` (failure halts downstream scenario) |

### INV-W3: Workflow describes real dependencies

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Enforcement point** | `agent-interaction.addWorkflowStep()` — validates declared inputs. `tool-invocation.invokeTool()` — records actual inputs in the ProvenanceRecord. Post-execution comparison. |
| **Enforcement mechanism** | Runtime check (post-execution). After a ToolInvocation completes, the set of Datasets declared as inputs to the WorkflowStep is compared against the set of Datasets the underlying Tool actually read (as recorded in the ProvenanceRecord). Declared-but-unused inputs are flagged as noise. Used-but-undeclared inputs are flagged as breaking Provenance. |
| **Status** | ENFORCED (designed) — MEDIUM severity, best-effort detection |
| **Violation handling** | The Agent notifies the User of the discrepancy. The ProvenanceRecord is flagged as defective if actual inputs differ from declared inputs. |
| **Spec refs** | `invariants.md` INV-W3; `features/workflow-execution.feature` (declared inputs match actual inputs scenario, declared input not used scenario) |

### INV-W4: Session can outlive its Jobs' completion

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Enforcement point** | `agent-interaction.endSession()` — does NOT cancel running Jobs. `agent-interaction.startSession()` — proactively queries `scheduling.queryJobsByUser()` for Jobs from previous Sessions. |
| **Enforcement mechanism** | Runtime design. `endSession()` sets SessionState to ENDED but does not call `scheduling.cancelJob()` for any Job. `startSession()` calls `scheduling.queryJobsByUser(user.slurmUsername)` and reports Job states to the User (R7, proactive). Jobs are discoverable by JobID in later Sessions via `scheduling.queryJob()`. |
| **Status** | ENFORCED (designed) |
| **Violation handling** | If `endSession()` fails to persist Job references (bug), the Jobs still run on the cluster (SLURM does not cancel them). The User can manually query Job states by JobID. |
| **Spec refs** | `invariants.md` INV-W4; `resolutions.md` R7 (proactive reporting); `cross-context/interactions.md` X8; `features/workflow-execution.feature` (Session outlives Jobs scenarios); `features/cesm-submission.feature` (cross-session recovery scenario) |

---

## Summary Table

| ID | Context | Severity | Enforcement point | Mechanism | Status |
|----|---------|----------|-------------------|-----------|--------|
| INV-T1 | C1 | CRITICAL | `invokeTool()` pre-gate | runtime check | ENFORCED |
| INV-T2 | C1 | HIGH | `invokeTool()` post-result | type system | ENFORCED |
| INV-T3 | C1 | CRITICAL | `invokeTool()` post-gate | runtime check (R4 strict) | ENFORCED |
| INV-T4 | C1 | CRITICAL | `invokeTool()` fs policy | runtime check | ENFORCED |
| INV-T5 | C1 | HIGH | `invokeTool()` termination | type system | ENFORCED |
| INV-T6 | C1 | CRITICAL | `submitCase()` pre-gate | runtime check | ENFORCED |
| INV-T7 | C1 | HIGH | `submitCase()` pre-gate | runtime check | ENFORCED |
| INV-T8 | C1 | CRITICAL | `submitCase()` validation | runtime check | ENFORCED |
| INV-T9 | C1 | HIGH | `createCase()` + `submitCase()` | runtime check | ENFORCED |
| INV-D1 | C3 | CRITICAL | `registerDataset()` + `invokeTool()` | type system + runtime | ENFORCED |
| INV-D2 | C3 | HIGH | `registerDataset()` | type system | ENFORCED |
| INV-D3 | C3 | CRITICAL | `markConsumable()` + `startWorkflow()` | runtime check | ENFORCED |
| INV-D4 | C3 | HIGH | `validateLocation()` | runtime check | ENFORCED |
| INV-S1 | C4 | CRITICAL | `queryJob()` | runtime design | ENFORCED |
| INV-S2 | C4 | HIGH | `submitJob()` + type | type system | ENFORCED |
| INV-S3 | C4 | HIGH | `submitJob()` parsing | runtime design | ENFORCED |
| INV-S4 | C4 | HIGH | `queryJob()` stale handling | runtime check | ENFORCED |
| INV-E1 | C5 | CRITICAL | `loadUenv()` conflict check | runtime check (uenv) | ENFORCED |
| INV-E2 | C5 | CRITICAL | `loadUenv()` + `verifyEnvironment()` | runtime check (path-level) | ENFORCED |
| INV-E3 | C5 | HIGH | `checkUenvAvailability()` | runtime check (uenv registry) | ENFORCED |
| INV-P1 | C6 | CRITICAL | `writeProvenanceRecord()` | type system | ENFORCED |
| INV-P2 | C6 | CRITICAL | `writeProvenanceRecord()` | runtime check | ENFORCED |
| INV-P3 | C6 | CRITICAL | `markConsumable()` + `startWorkflow()` | runtime check | ENFORCED |
| INV-P4 | C6 | HIGH | Provenance store design | runtime design | ENFORCED |
| INV-W1 | C7 | CRITICAL | `startWorkflow()` | runtime check | ENFORCED |
| INV-W2 | C7 | HIGH | `startWorkflow()` loop | runtime check | ENFORCED |
| INV-W3 | C7 | MEDIUM | post-execution comparison | runtime check (best-effort) | ENFORCED |
| INV-W4 | C7 | HIGH | `endSession()` + `startSession()` | runtime design (R7 proactive) | ENFORCED |

**All 28 invariants have enforcement points. None are UNIMPLEMENTED or UNKNOWN.**
