# API Reference

cera's public surface consists of 8 modules, each exporting a set of
TypeScript interfaces. All interfaces are backend-agnostic — the same
interface works with both the dev (dsh-adapter) and production
(firecrest-adapter) backends.

## Startup

The `createCeraSystem()` factory wires all 8 modules based on the
selected backend (ADR-012, R14).

```typescript
import { createCeraSystem } from 'cera';
import { OidcTokenProvider } from 'cera';

// Production (FirecREST backend — default)
const system = createCeraSystem({
  backend: {
    type: 'firecrest',
    firecrestConfig: {
      firecrestUrl: 'https://firecrest.cscs.ch',
      systemName: 'daint',
      tokenProvider: new OidcTokenProvider({
        tokenEndpoint: 'https://idp.cscs.ch/auth/realms/cscs/protocol/openid-connect/token',
        clientId: 'cera-client',
        clientSecret: process.env.CERA_CLIENT_SECRET!,
      }),
    },
  },
  jobScriptConfig: {
    uenvSpecs: ['cdo:2.0.5', 'python:3.11.6'],
  },
});

// Dev (local backend — development only)
const devSystem = createCeraSystem({
  backend: {
    type: 'dev',
    dshConfig: { systemName: 'daint' },
  },
  username: process.env.USER,
});
```

### CeraSystem

| Field | Type | Production | Dev |
|-------|------|------------|-----|
| `shellExecutor` | `ShellExecutor` | `FirecrestShellExecutor` | dsh-adapter |
| `subprocessRunner` | `SubprocessRunner` | `FirecrestSubprocessRunner` | dsh-adapter |
| `filesystemGateway` | `FilesystemGateway` | `FirecrestFilesystemGateway` | dsh-adapter |
| `schedulingService` | `SchedulingService` | `FirecRESTSchedulingService` | SLURM CLI |
| `toolInvocationService` | `ToolInvocationService` | no EnvironmentService (FP-INV-3) | with EnvironmentService |
| `toolCatalogService` | `ToolCatalogService` | `ToolCatalogServiceImpl` | same |
| `dataManagementService` | `DataManagementService` | with FirecREST FS | with dsh-adapter FS |
| `provenanceService` | `ProvenanceService` | with FirecREST FS | with dsh-adapter FS |
| `environmentService` | `EnvironmentService?` | `undefined` (FP-INV-3) | `EnvironmentServiceImpl` |
| `backendType` | `'firecrest' \| 'dev'` | `'firecrest'` | `'dev'` |

## Module index

### dsh-adapter — Dev backend

Wraps dsh's extension points into stable cera-internal interfaces.
This is the only module that imports dsh directly (ADR-005). **Dev-only**
(ADR-012, FP-INV-4).

| Interface | Wraps | Purpose |
|-----------|-------|---------|
| `ShellExecutor` | `ctx.shell` | CLI tool execution (CDO, NCO) |
| `SubprocessRunner` | `ctx.subprocess` | Fine-grained process control with streaming |
| `SandboxRunner` | `ctx.sandbox` | Process confinement for legacy binaries |
| `FilesystemGateway` | `ctx.fs` | Filesystem access and validation |
| `JobBackend` | `ctx.jobs` | Background work submission |
| `ToolRegistry` | `ctx.tools` | Model-facing capability registration |
| `CommandRegistry` | `ctx.commands` | Human-command dispatch |

### firecrest-adapter — Production backend

Implements the same interfaces as dsh-adapter via FirecREST's REST API
(ADR-012). All ToolInvocations are submitted as SLURM Jobs (F-INV-6).
Authentication is OIDC (JWT Bearer token, F-INV-2). HTTPS required
(FCREST-04). Redirects disabled (FCREST-04).

Key types:

| Type | Purpose |
|------|---------|
| `FirecrestConfig` | URL, system name, token provider, timeouts, transfer method, default ResourceRequest |
| `JwtTokenProvider` | Interface for token acquisition/refresh |
| `OidcTokenProvider` | Default impl: client credentials grant |
| `StaticTokenProvider` | Testing impl: pre-existing token |
| `JobScriptConfig` | uenv specs + default ResourceRequest for ToolInvocationService |
| `BackendSelection` | `{ type: 'firecrest' \| 'dev', firecrestConfig?, dshConfig? }` |
| `CeraSystemConfig` | Backend selection + jobScriptConfig + username |
| `CeraSystem` | All 8 wired module interfaces + backendType |

### scheduling — SLURM job management

Submits Jobs via `sbatch`, queries state via `squeue` (active) and
`sacct` (historical), cancels via `scancel`. SLURM-only (ADR-004).
**The CLI implementation is dev-only** (ADR-012, FP-INV-4). In
production, `FirecRESTSchedulingService` implements the same interface
via FirecREST compute endpoints.

| Method | Description |
|--------|-------------|
| `submitJob(request)` | Submit a Job, returns Job with SLURM-assigned JobID (INV-S3) |
| `queryJob(jobId)` | Query Job state — authoritative from SLURM (INV-S1) |
| `queryJobsByUser(username)` | Query all Jobs for a User (proactive reporting, R7) |
| `cancelJob(jobId)` | Cancel a Job via `scancel` |
| `reconcileViaSacct(jobIds)` | Reconcile Job states after SLURM outage (R13) |

### environment-management — uenv management (dev-only runtime)

Mounts/unmounts uenvs (squashfs at prescribed paths). Conflict detection
at filesystem path level (not Lmod soname, ADR-003). **The runtime
service is dev-only** (ADR-012, FP-INV-3). In production, uenv is
loaded in Job scripts (F-INV-5) and the EnvironmentService is not used.

Types (`Environment`, `UenvSpec`, `Module`, `Conflict`) are used by
`tool-invocation` to construct Job scripts in production.

| Method | Description |
|--------|-------------|
| `checkUenvAvailability(name, version)` | Check if uenv exists in registry (INV-E3, dev-only) |
| `loadUenv(request)` | Mount uenv, verify conflict-free (INV-E1, INV-E2, dev-only) |
| `unloadUenv(environmentId)` | Unmount uenv (dev-only) |
| `verifyEnvironment(environmentId)` | Re-verify before invocation (X1, dev-only) |
| `detectConflicts(uenvSpecs)` | Detect filesystem path conflicts (dev-only) |
| `getActiveEnvironment()` | Returns the currently active Environment or null (dev-only) |

### provenance — Immutable records

Writes immutable ProvenanceRecords (JSON on HPC filesystem). In
production, writes go through FirecREST file endpoints (F-INV-7).
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
consumable (joint with provenance, INV-D3/INV-P3). In production,
Location validation uses FirecREST stat/list endpoints.

| Method | Description |
|--------|-------------|
| `registerDataset(input)` | Register new Dataset (INV-D1, INV-D2, INV-D4) |
| `queryDataset(id)` | Query Dataset by identity |
| `listDatasets(filter?)` | List Datasets with optional filter |
| `validateLocation(location, mode)` | Validate Location resolves (read/write) |
| `markConsumable(datasetId)` | Mark as consumable (requires Provenance, INV-D3) |
| `quarantineDataset(datasetId, reason)` | Quarantine corrupted Dataset |

### tool-invocation — Tool execution + CESM

Creates and executes ToolInvocations with the full lifecycle: validate
→ (skip Environment in production, FP-INV-3) → validate Locations →
start → monitor → complete/fail. **All ToolInvocations are parallel in
production** (F-INV-6) — the `executionModel` field is ignored when
`jobScriptConfig` is provided. Strict exit codes by default (ADR-008).
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
│   ├── EnvironmentNotLoaded (INV-T1, dev-only in production)
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
│   ├── SchedulerUnavailable (FM-S2, dev-only; FM-F-4 in production)
│   └── StaleQueueData (FM-S3)
├── EnvironmentError (dev-only runtime)
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

FirecREST-specific errors (in `firecrest-adapter/types.ts`, production
only):

```
FirecrestError (base)
├── FirecrestTimeout (FM-F-1, F-INV-3)
├── FirecrestUnauthorized (FM-F-2, F-INV-2)
├── FirecrestRateLimited (FM-F-3)
├── FirecrestUnavailable (FM-F-4)
├── FirecrestSshError (FM-F-5)
├── FirecrestSystemNotFound (FM-F-7)
└── FirecrestFileTooLarge (FM-F-8, F-INV-4)
```
