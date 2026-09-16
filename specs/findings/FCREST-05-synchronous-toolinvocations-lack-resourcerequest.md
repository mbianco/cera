## Finding: Synchronous ToolInvocations lack `resourceRequest` but F-INV-6 requires a SLURM Job
Severity: Critical
Category: Correctness > Edge cases; Correctness > Implicit coupling
Location: `src/tool-invocation/types.ts` lines 54–80 (ToolInvocationRequest); `src/tool-invocation/tool-invocation-service.ts` lines 464–471; `specs/firecrest/invariants.md` F-INV-6
Spec reference: F-INV-6 (all ToolInvocations are parallel); `specs/architecture/api-contracts.md` §6 (ToolInvocationRequest)

### Description

F-INV-6 states: "Every ToolInvocation, regardless of its declared `executionModel`, is submitted as a SLURM Job via the FirecREST compute endpoints."

The existing `ToolInvocationRequest` (api-contracts.md §6; `src/tool-invocation/types.ts` line 68) has `executionModel: 'synchronous' | 'parallel'` and `resourceRequest?: ResourceRequest` (optional, "Required for 'parallel' execution"). The validation at `tool-invocation-service.ts` lines 464–471 throws `InvalidParameters` when `request.executionModel === 'parallel' && !request.resourceRequest`.

**The gap:** Under FirecREST, a `ToolInvocation` with `executionModel: 'synchronous'` (e.g., a short CDO command: `cdo -timmean input.nc output.nc`) has no `resourceRequest` — it was never required for synchronous execution. F-INV-6 requires it to be submitted as a SLURM Job, which needs a `ResourceRequest` (nodes, coresPerNode, memory, wallTime, partition, qos).

The spec does not answer: **What `ResourceRequest` does a formerly-synchronous ToolInvocation get under FirecREST?**

Options that are unspecified:
1. **A default minimal ResourceRequest** (e.g., 1 node, 1 core, 1GB, 5 min, partition "normal", qos "default"). If so, what are the defaults? Are they configurable? The `FirecrestConfig` has no `defaultResourceRequest` field.
2. **The Tool's own ResourceRequest.** But CLI Tools (CDO, NCO) may not have a `ResourceRequest` in their definition — they were designed for synchronous execution.
3. **The User provides one explicitly.** But then F-INV-6 ("all ToolInvocations are parallel") is not transparent — the User must know to provide a `ResourceRequest` even for a 2-second CDO command. The existing `invokeTool` validation rejects parallel requests without `resourceRequest`.

If option 1 is chosen, the validation at line 464–471 must be relaxed (under FirecREST, `resourceRequest` is not required because a default is supplied). If option 3 is chosen, every synchronous ToolInvocation request must be modified to include a `ResourceRequest` — a breaking change to the API contract.

**Additional coupling:** `submitJob` (`SubmitJobInput`) requires a `command: string` (the sbatch script). Under the local backend, synchronous execution uses `ShellExecutor.execute(command)` with `ShellExecuteOptions` (cwd, env, timeout, stdin). Under FirecREST, the synchronous command must be wrapped in a Job script (with optional `uenv start` prefix per F-INV-5). The mapping from `ShellExecuteOptions` to `SubmitJobInput` (e.g., `cwd` → working directory, `env` → environmentVars, `timeout` → wallTime) is not specified. If a synchronous ToolInvocation passes `timeout: 5000` (5 seconds), does that become a 5-second wallTime? If so, SLURM may reject it (minimum wallTime varies by partition).

### Evidence

1. `src/tool-invocation/types.ts` line 68: `readonly executionModel: 'synchronous' | 'parallel';`
2. `src/tool-invocation/types.ts` lines 70–72: `readonly resourceRequest?: ResourceRequest;` — "Required for 'parallel' execution."
3. `src/tool-invocation/tool-invocation-service.ts` lines 464–471: throws if `executionModel === 'parallel' && !resourceRequest`.
4. `specs/firecrest/invariants.md` F-INV-6: "Every ToolInvocation, regardless of its declared `executionModel`, is submitted as a SLURM Job."
5. `specs/firecrest/assumptions.md` F-A-1: "A 2-second CDO command becomes a 30-second Job." — implies a minimal Job, but no `ResourceRequest` is specified.
6. `src/scheduling/types.ts` lines 33–39: `SubmitJobInput.resourceRequest: ResourceRequest` (required, not optional).
7. `src/firecrest-adapter/types.ts` lines 62–81: `FirecrestConfig` has no `defaultResourceRequest` field.

### Suggested resolution

1. Add a `defaultResourceRequest: ResourceRequest` to `FirecrestConfig` (with sensible defaults: 1 node, 1 core, minimal memory, short wallTime, default partition/qos). The `FirecRESTShellExecutor` uses this when the ToolInvocation's `resourceRequest` is absent.
2. Specify the mapping from `ShellExecuteOptions` to `SubmitJobInput` (especially `timeout` → `wallTime`, `cwd` → `workingDirectory`, `env` → `environmentVars`).
3. Add a Gherkin scenario: "Given a synchronous ToolInvocation with no resourceRequest, When cera processes it under the FirecREST backend, Then cera uses the default ResourceRequest and submits a SLURM Job."
4. Relax the validation at `tool-invocation-service.ts` lines 464–471 under FirecREST (or provide the default before validation).
