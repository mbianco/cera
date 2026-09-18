## Finding: ProvenanceRecord Environment identity is a placeholder, not the uenv spec — violates INV-P2 under R14
Severity: Critical
Category: Correctness > Specification compliance; Semantic drift
Location: `src/tool-invocation/tool-invocation-service.ts` lines 597–598; `specs/invariants-firecrest-primary.md` lines 440–443; `specs/architecture/build-phases-firecrest.md` Phase B
Spec reference: INV-P2 (full reproducibility tuple); invariants-firecrest-primary.md INV-P2 (UNCHANGED); F-INV-5 (uenv in Job scripts)

### Description

INV-P2 requires every ProvenanceRecord to include "Environment identity
(all Modules with versions)." The R14 re-evaluation
(`invariants-firecrest-primary.md` lines 440–443) states: "Under R14,
the Environment identity in the ProvenanceRecord is the uenv spec
embedded in the Job script (not a cera-managed Environment object). The
fields are identical; the source of Environment identity changes."

However, the existing code at `tool-invocation-service.ts` lines
597–598 uses a **static placeholder** instead of the actual uenv specs:

```typescript
envIdForProvenance = 'firecrest-backend' as EnvironmentId;
envDescriptionForProvenance = 'uenv loaded in Job script (F-INV-5)';
```

This placeholder is identical for every ToolInvocation under the
FirecREST backend. It does NOT contain the uenv specs (e.g.,
`cdo:2.0.5,python:3.11.6`), which are available in
`this.#jobScriptConfig?.uenvSpecs`.

The R14 build phases (`build-phases-firecrest.md` Phase B) describe
modifications to `invokeTool()` for dispatch, default ResourceRequest,
uenv embedding, and `validateExecutionModel` bypass — but **never
mention updating the ProvenanceRecord environment fields** from the
placeholder to the actual uenv specs. The impact-analysis.md §6
similarly omits this.

### Evidence

1. `src/tool-invocation/tool-invocation-service.ts` line 597:
   `envIdForProvenance = 'firecrest-backend' as EnvironmentId` —
   static string, not the uenv spec.
2. `src/tool-invocation/tool-invocation-service.ts` line 598:
   `envDescriptionForProvenance = 'uenv loaded in Job script (F-INV-5)'`
   — generic description, not the actual specs.
3. `specs/invariants-firecrest-primary.md` lines 440–443: "the
   Environment identity in the ProvenanceRecord is the uenv spec
   embedded in the Job script" — spec requires the actual spec, code
   uses a placeholder.
4. `specs/architecture/build-phases-firecrest.md` Phase B: five items
   listed, none mention updating ProvenanceRecord environment fields.
5. `specs/impact-analysis.md` §6: "What changes" list does not include
   ProvenanceRecord environment field updates.

### Suggested resolution

Add a step to Phase B (or a new item in impact-analysis §6) specifying
that the ProvenanceRecord's `environmentId` and
`environmentDescription` fields must be populated from
`this.#jobScriptConfig?.uenvSpecs` when the EnvironmentService is
absent. The `environmentId` should be a deterministic hash of the uenv
specs (so the same specs produce the same ID), and the
`environmentDescription` should list the actual specs (e.g.,
`"uenv: cdo:2.0.5, python:3.11.6"`).
