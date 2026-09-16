# API Reference

cera's public surface consists of 7 modules, each exporting a set
of TypeScript interfaces. All interfaces are backend-agnostic —
the same interface works with both the local (dsh-adapter) and
FirecREST (firecrest-adapter) backends.

## Module index

### dsh-adapter — Local backend

Wraps dsh's extension points (`ctx.shell`, `ctx.subprocess`,
`ctx.sandbox`, `ctx.fs`, `ctx.jobs`, `ctx.tools`, `ctx.commands`)
into stable cera-internal interfaces. This is the only module
that imports dsh directly (ADR-005).

| Interface | Wraps | Purpose |
|-----------|-------|---------|
| `ShellExecutor` | `ctx.shell` | CLI tool execution (CDO, NCO) |
| `SubprocessRunner` | `ctx.subprocess` | Fine-grained process control with streaming |
| `SandboxRunner` | `ctx.sandbox` | Process confinement for legacy binaries |
| `FilesystemGateway` | `ctx.fs` | Filesystem access and validation |
| `JobBackend` | `ctx.jobs` | Background work submission |
| `ToolRegistry` | `ctx.tools` | Model-facing capability registration |
| `CommandRegistry` | `ctx.commands` | Human-command dispatch |

```typescript
import { createDshAdapter } from 'cera';

const adapter = createDshAdapter(dshContext);
// adapter.shellExecutor, adapter.subprocessRunner, adapter.filesystemGateway, ...
```

### firecrest-adapter — Remote backend

Implements the same interfaces as dsh-adapter via FirecREST's REST
API (ADR-011). All ToolInvocations are submitted as SLURM Jobs
(F-INV-6). Authentication is OIDC (JWT Bearer token, F-INV-2).

```typescript
import { createFirecrestBackend, OidcTokenProvider } from 'cera';

const backend = createFirecrestBackend({
  firecrestUrl: 'https://firecrest.cscs.ch',
  systemName: 'daint',
  tokenProvider: new OidcTokenProvider({
    tokenEndpoint: 'https://idp.cscs.ch/auth/realms/cscs/protocol/openid-connect/token',
    clientId: 'cera-client',
    clientSecret: process.env.CERA_CLIENT_SECRET!,
  }),
});
// backend.shellExecutor, backend.subprocessRunner, backend.filesystemGateway, ...
```

### scheduling — SLURM job management

Submits Jobs via `sbatch`, queries state via `squeue` (active) and
`sacct` (historical), cancels via `scancel`. SLURM-only (ADR-004).

| Method | Description |
|--------|-------------|
| `submitJob(request)` | Submit a Job, returns Job with SLURM-assigned JobID (INV-S3) |
| `queryJob(jobId)` | Query Job state — authoritative from SLURM (INV-S1) |
| `queryJobsByUser(username)` | Query all Jobs for a User (proactive reporting, R7) |
| `cancelJob(jobId)` | Cancel a Job via `scancel` |
| `reconcileViaSacct(jobIds)` | Reconcile Job states after SLURM outage (R13) |

### environment-management — uenv management

Mounts/unmounts uenvs (squashfs at prescribed paths). Conflict
detection at filesystem path level (not Lmod soname, ADR-003).

| Method | Description |
|--------|-------------|
| `checkUenvAvailability(name, version)` | Check if uenv exists in registry (INV-E3) |
| `loadUenv(request)` | Mount uenv, verify conflict-free (INV-E1, INV-E2) |
| `unloadUenv(environmentId)` | Unmount uenv |
| `verifyEnvironment(environmentId)` | Re-verify before invocation (X1 out-of-order) |
| `detectConflicts(uenvSpecs)` | Detect filesystem path conflicts |
| `getActiveEnvironment()` | Returns the currently active Environment or null |

### provenance — Immutable records

Writes immutable ProvenanceRecords (JSON on HPC filesystem).
Local quarantine (R11) — only the affected Dataset is isolated.

| Method | Description |
|--------|-------------|
| `writeProvenanceRecord(input)` | Write immutable record (INV-P1, INV-P2) |
| `queryProvenanceRecord(datasetId)` | Query record for a Dataset |
| `queryProvenanceForJob(jobId)` | Query record for a Job outcome |
| `queryLineage(datasetId)` | Trace full lineage chain |
| `verifyProvenance(datasetId)` | Verify record exists and is valid (INV-P3) |
| `reconstructProvenanceRecord(input)` | Best-effort reconstruction |
| `quarantineDataset(datasetId, reason)` | Local quarantine (R11) |

### data-management — Dataset lifecycle

Dataset registration, querying, Location validation, marking
consumable (joint with provenance, INV-D3/INV-P3).

| Method | Description |
|--------|-------------|
| `registerDataset(input)` | Register new Dataset (INV-D1, INV-D2, INV-D4) |
| `queryDataset(id)` | Query Dataset by identity |
| `listDatasets(filter?)` | List Datasets with optional filter |
| `validateLocation(location, mode)` | Validate Location resolves (read/write) |
| `markConsumable(datasetId)` | Mark as consumable (requires Provenance, INV-D3) |
| `quarantineDataset(datasetId, reason)` | Quarantine corrupted Dataset |

### tool-invocation — Tool execution + CESM

Creates and executes ToolInvocations with the full lifecycle:
validate → verify Environment → validate Locations → start →
monitor → complete/fail. Strict exit codes by default (ADR-008).
CESM is a Model Tool with a multi-step Case lifecycle (ADR-001).

| Service | Method | Description |
|---------|--------|-------------|
| `ToolCatalogService` | `registerTool(tool)` | Register a Tool (CLI, Python, Model) |
| | `getTool(toolId)` | Query Tool by identity |
| | `getToolCatalog()` | List all registered Tools |
| `ToolInvocationService` | `invokeTool(request)` | Execute a ToolInvocation (INV-T1–T5) |
| | `monitorInvocation(id)` | AsyncObservable of ToolInvocationEvents |
| `CaseService` | `createCase(input)` | Create CESM Case (INV-T9, output fixed at creation) |
| | `configureCase(caseId, config)` | CESM case.setup (CREATED → CONFIGURED) |
| | `buildCase(caseId)` | CESM case.build (CONFIGURED → BUILT, FM-M1) |
| | `submitCase(caseId, resourceRequest)` | CESM case.submit (BUILT → SUBMITTED, INV-T6–T8) |
| | `monitorCase(caseId)` | AsyncObservable of CaseState changes |
| | `registerCaseOutput(caseId)` | Register output Datasets after COMPLETED |

### agent-interaction — LLM-facing surface

Session (proactive Job reporting, R7), Experiment (first-class,
ADR-002), Workflow (persisted, ADR-006), Action (LLM-facing,
R3/ADR-010).

| Service | Method | Description |
|---------|--------|-------------|
| `SessionService` | `startSession(user)` | Start Session, proactive Job report (R7) |
| | `endSession(sessionId)` | End Session, Jobs NOT cancelled (INV-W4) |
| | `reportJobStatus(sessionId)` | Report current Job states |
| `ExperimentService` | `createExperiment(input)` | Create Experiment (R2) |
| | `addWorkflowToExperiment(expId, wfId)` | Add Workflow (throws WorkflowAlreadyAssigned) |
| | `addCaseToExperiment(expId, caseId)` | Add Case (eventual consistency, FINDING-02) |
| `WorkflowService` | `createWorkflow(input)` | Create Workflow (validates Experiment) |
| | `addWorkflowStep(wfId, step)` | Add a step |
| | `startWorkflow(wfId)` | Start (INV-W1 inputs verified, INV-W2 failure halts) |
| | `resumeWorkflow(wfId)` | Resume from persisted state (R6) |
| `ActionService` | `registerAction(action)` | Register Action (R3) |
| | `validateAction(request)` | Validate — refuse and ask if hallucinated (R12, ADR-010) |
| | `listActions()` | List all registered Actions |

## Error hierarchy

```
CeraError (base)
├── DshAdapterError
│   ├── FrameworkBreakingChange (FM-X3)
│   └── AdapterInternal
├── ToolInvocationError
│   ├── EnvironmentNotLoaded (INV-T1)
│   ├── InputNotFound (FM-T5)
│   ├── InputMissingProvenance (INV-D3, INV-W1)
│   ├── InvalidParameters (FM-A2, FM-T4)
│   ├── ToolNotFound (FM-A1, R12)
│   ├── NonZeroExitCode (FM-T3, R4)
│   ├── SignalTerminated (FM-T1, FM-T2, INV-T5)
│   ├── CaseNotBuilt (INV-T6)
│   ├── CaseAlreadyRunning (INV-T7)
│   ├── RunLengthExceedsWallTime (INV-T8)
│   └── OutputLocationNotSet (INV-T9)
├── SchedulingError
│   ├── RejectedByScheduler (FM-S1)
│   ├── SchedulerUnavailable (FM-S2)
│   └── StaleQueueData (FM-S3)
├── EnvironmentError
│   ├── UenvNotFound (FM-E1)
│   ├── ConflictDetected (FM-E2)
│   └── PartialLoad (FM-E3)
├── DataError
│   ├── LocationNotReadable (FM-D3)
│   ├── LocationNotWritable (FM-D3)
│   ├── DataQuotaExceeded (FM-D1)
│   ├── ProvenanceMissing (INV-D3, FM-P3)
│   └── DatasetCorrupted (FM-D5)
├── ProvenanceError
│   ├── WriteFailed (FM-P1)
│   └── RecordCorrupted (FM-P2, R11)
└── AgentError
    ├── LlmHallucinatedTool (FM-A1, R12)
    ├── LlmHallucinatedParameters (FM-A2, R12)
    ├── ContextWindowExceeded (FM-A3)
    ├── LlmUnavailable (FM-A4)
    ├── NetworkLost (FM-X2)
    ├── WorkflowAlreadyAssigned (R2)
    ├── ExperimentNotFound (FINDING-02)
    └── CaseAlreadyAssigned (R2)
```

FirecREST-specific errors (in `firecrest-adapter/types.ts`):

```
FirecrestError (base)
├── FirecrestTimeout (FM-F-1)
├── FirecrestUnauthorized (FM-F-2)
├── FirecrestRateLimited (FM-F-3)
├── FirecrestUnavailable (FM-F-4)
├── FirecrestSshError (FM-F-5)
├── FirecrestSystemNotFound (FM-F-7)
└── FirecrestFileTooLarge (FM-F-8)
```
