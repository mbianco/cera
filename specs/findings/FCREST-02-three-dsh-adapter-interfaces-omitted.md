## Finding: FirecREST backend omits 3 of 7 dsh-adapter interfaces with no specification
Severity: Critical
Category: Correctness > Specification compliance; Architecture > module boundary
Location: `specs/firecrest/api-contracts.md` (FirecRESTBackend); `src/dsh-adapter/types.ts` (7 interfaces); `src/firecrest-adapter/types.ts` (FirecRESTBackend); `specs/architecture/module-graph.md` §1
Spec reference: ADR-005 (dsh isolation layer — 7 interfaces); ADR-011 (FirecREST as second backend)

### Description

ADR-005 defines **7** cera-internal interfaces that the dsh-adapter provides: `ShellExecutor`, `SubprocessRunner`, `SandboxRunner`, `FilesystemGateway`, `JobBackend`, `ToolRegistry`, `CommandRegistry`. The module graph (§1) lists all 7 with their consumers.

The `FirecRESTBackend` aggregate (`specs/firecrest/api-contracts.md`; `src/firecrest-adapter/types.ts` line 330–335) provides only **4**:
- `shellExecutor: ShellExecutor`
- `subprocessRunner: SubprocessRunner`
- `filesystemGateway: FilesystemGateway`
- `schedulingService: SchedulingService`

Three dsh-adapter interfaces are **completely absent** from the FirecREST spec, with no statement of their fate:

1. **`SandboxRunner`** — Used by `tool-invocation` for process confinement (executing legacy binaries with restricted filesystem and network access). Under FirecREST, all execution is via SLURM Jobs (F-INV-6), which are inherently confined to compute nodes. But the spec does not say:
   - Is `SandboxRunner` not needed under FirecREST? (If so, does `tool-invocation` break because it depends on it?)
   - Does `FirecRESTShellExecutor` provide confinement by default?
   - Is `SandboxOptions` (allowedPaths, allowNetwork) ignored, applied to the Job script, or rejected?

2. **`ToolRegistry`** — Used by `agent-interaction` to register Actions as LLM-discoverable capabilities via `ctx.tools`. The FirecREST spec doesn't mention agent-interaction at all. Does `agent-interaction` still use dsh's `ctx.tools` directly under the FirecREST backend? If so, the "FirecREST backend is a complete replacement" claim is false — `agent-interaction` would still depend on dsh-adapter.

3. **`CommandRegistry`** — Used by `agent-interaction` for human-command dispatch via `ctx.commands`. Same issue as `ToolRegistry`.

Additionally, **`JobBackend`** (dsh-adapter interface for background work submission, distinct from SLURM Jobs) is absent. The `FirecRESTSchedulingService` replaces SLURM job management but `JobBackend` is a different concept (dsh-internal background tasks, not SLURM Jobs). Is `JobBackend` needed under FirecREST? If `agent-interaction` or other modules use background work, the FirecREST backend doesn't provide it.

### Evidence

1. `src/dsh-adapter/types.ts` defines 7 interfaces: `ShellExecutor` (54), `SubprocessRunner` (100), `SandboxRunner` (128), `FilesystemGateway` (156), `JobBackend` (209), `ToolRegistry` (246), `CommandRegistry` (275).
2. `src/firecrest-adapter/types.ts` line 330–335: `FirecRESTBackend` has only 4 fields. `SandboxRunner`, `JobBackend`, `ToolRegistry`, `CommandRegistry` are absent.
3. `specs/architecture/module-graph.md` §1: "`dsh-adapter`... provides stable TypeScript interfaces wrapping each dsh extension point that cera uses" — 7 listed.
4. `specs/firecrest/api-contracts.md`: "This is the FirecREST analog of `createDshAdapter(context)`" — but it provides 4 interfaces, not 7.
5. `specs/firecrest/invariants.md` F-INV-1: "every HPC operation... goes through the FirecREST REST API" — but `SandboxRunner`, `ToolRegistry`, `CommandRegistry`, `JobBackend` are not "HPC operations" and their handling is undefined.

### Suggested resolution

The architect must explicitly specify, for each omitted interface:
- Whether it is **not needed** under FirecREST (and why — e.g., sandboxing is inherent in SLURM Jobs), or
- Whether it is **still provided by dsh-adapter** under the FirecREST backend (i.e., the FirecREST backend is a partial replacement that coexists with dsh-adapter for non-HPC interfaces), or
- Whether it needs a **FirecREST-specific implementation** (e.g., `FirecRESTToolRegistry`).

The `FirecRESTBackend` aggregate and the module graph must be updated to reflect this. If `agent-interaction` continues to use dsh-adapter's `ToolRegistry` and `CommandRegistry` under FirecREST, ADR-011's "no modification to existing modules" is further violated (the backend selection at startup must inject a mix of FirecREST and dsh-adapter interfaces).
