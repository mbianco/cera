## Finding: CLI validation gaps — no schema validation for resource request, no env var, no uenv format validation, no limit on number of specs
Severity: Medium
Category: Robustness > Input validation; Correctness > Edge cases
Location: `src/cli.ts` lines 41–42, 105–106, 162–176; `src/startup.ts` lines 82–89 (JobScriptConfig)
Spec reference: FP-INV-5 (default ResourceRequest); F-INV-5 (uenv in Job scripts); build-phases-firecrest.md Phase A

### Description

The CLI (`src/cli.ts`) was modified in Phase A to add `--uenv-specs`
and `--default-resource-request` flags. Several validation gaps
remain:

**Gap 1: `--default-resource-request` has no schema validation.**
The CLI parses it as `Record<string, unknown>` (line 167) — any
valid JSON is accepted. A malformed input like `{"foo": "bar"}` is
accepted and passed to `JobScriptConfig.defaultResourceRequest`. The
error only surfaces when SLURM rejects the Job (FM-S1 re-evaluated).
The spec (`build-phases-firecrest.md` Phase A, line 73–75) mentions
a test for correct parsing but not for schema validation.

**Gap 2: `--default-resource-request` has no environment variable
equivalent.** All other flags have both CLI and env var forms
(`CERA_BACKEND`, `CERA_FIRECREST_URL`, `CERA_SYSTEM`,
`CERA_TOKEN_ENDPOINT`, `CERA_CLIENT_ID`, `CERA_CLIENT_SECRET`,
`CERA_UENV_SPECS`). `--default-resource-request` reads only from
`args['default-resource-request']` (line 106), not from
`CERA_DEFAULT_RESOURCE_REQUEST`. This is inconsistent with the
established pattern and prevents users from setting it in a shell
profile.

**Gap 3: `--uenv-specs` has no format validation.** Each spec is a
comma-separated string parsed as `string.split(',').map(s =>
s.trim()).filter(s => s.length > 0)` (lines 162–164). There is no
validation that each spec is in the expected format (e.g.,
`name:version`). A spec like `invalid spec with spaces and : : :`
is accepted and embedded in the Job script. The Job fails at
runtime (FM-F-9) with a less clear error than if the format was
validated at the CLI level.

**Gap 4: No limit on the number of `--uenv-specs`.** The CLI
accepts an unbounded number of uenv specs. With hundreds of specs:
- The Job script could exceed SLURM's script size limit (typically
  4MB for `sbatch`, but practical limits are much lower).
- The uenv mount process could be slow (each uenv is a squashfs
  mount).
- The ProvenanceRecord could become very large (all uenv specs are
  recorded).

None of these resource exhaustion scenarios are documented in the
failure modes.

**Gap 5: `--default-resource-request` is passed redundantly.** The
CLI stub (lines 196–218) passes `defaultResourceRequest` in both
`firecrestConfig.defaultResourceRequest` and
`jobScriptConfig.defaultResourceRequest`. The spec says the default
comes from `FirecrestConfig.defaultResourceRequest` and is passed to
`ToolInvocationService` via `JobScriptConfig.defaultResourceRequest`.
The redundancy is confusing — if they differ, which is authoritative?

### Evidence

1. `src/cli.ts` line 167: `let defaultResourceRequest: Record<string,
   unknown> | undefined;` — no `ResourceRequest` type.
2. `src/cli.ts` line 106: `const defaultResourceRequestStr =
   args['default-resource-request'] ?? '';` — no env var.
3. `src/cli.ts` lines 162–164: `uenvSpecsStr.split(',').map(s =>
   s.trim()).filter(s => s.length > 0)` — no format validation.
4. `src/cli.ts` lines 207–211: `firecrestConfig: { ...
   defaultResourceRequest, }` and `jobScriptConfig: { ...
   defaultResourceRequest, }` — redundant.
5. `specs/failure-modes-firecrest-primary.md`: no failure mode for
   "Job script too large" or "too many uenv specs."

### Suggested resolution

(a) Validate `--default-resource-request` against the `ResourceRequest`
schema (parse JSON, check required fields: nodes, coresPerNode,
memory, wallTime, partition, qos). (b) Add `CERA_DEFAULT_RESOURCE_REQUEST`
environment variable. (c) Validate each uenv spec format (e.g.,
`^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$`). (d) Document a practical
limit on the number of uenv specs (e.g., 32) and enforce it at the
CLI level. (e) Clarify that `FirecrestConfig.defaultResourceRequest`
is the source of truth, and `JobScriptConfig.defaultResourceRequest`
is derived from it (not independently configurable).
