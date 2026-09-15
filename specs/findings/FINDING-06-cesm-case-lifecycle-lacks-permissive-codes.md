## Finding: CESM Case lifecycle steps have no permissiveExitCodes mechanism
Severity: High
Category: Correctness > Edge cases
Location: specs/architecture/api-contracts.md (lines 615–714, CaseService); specs/architecture/adr/ADR-008.md (lines 42–58, permissiveExitCodes on ToolInvocationRequest)
Spec reference: resolutions.md R4; ADR-008; invariants.md INV-T3

### Description

R4 (strict exit codes) and ADR-008 state that `permissiveExitCodes`
is an optional field on `ToolInvocationRequest`, allowing the User
to override the strict default for a specific ToolInvocation.

The CESM Case lifecycle methods (`configureCase`, `buildCase`) are
ToolInvocations per R1. Their contracts in api-contracts.md
(lines 626–648) declare:

```
@throws {ToolInvocationError.NonZeroExitCode} if configuration fails.
@throws {ToolInvocationError.NonZeroExitCode} if build fails.
```

However, `CaseService.configureCase()` takes `(caseId, config:
CaseConfig)` and `CaseService.buildCase()` takes `(caseId)` —
**neither accepts a `permissiveExitCodes` field**. Compare with
`ToolInvocationService.invokeTool()` which takes a full
`ToolInvocationRequest` with `permissiveExitCodes?: number[]`.

If CESM's `case.build` or `case.setup` returns a non-zero exit code
for a non-fatal warning (a known possibility per the original
spec's FM-T3 discussion), the Case is stuck in CONFIGURED or
CREATED state with no User override mechanism.

### Evidence

1. `CaseConfig` (api-contracts.md lines 708–713) has no
   `permissiveExitCodes` field.
2. `CreateCaseInput` (lines 699–706) has no
   `permissiveExitCodes` field.
3. `buildCase(caseId)` signature has no parameter for exit code
   policy.
4. `invokeTool(request: ToolInvocationRequest)` has
   `permissiveExitCodes?: number[]` (line 599).
5. The task description (point 7) asks: "CESM's case.build or
   case.submit might return non-zero for warnings. Is this handled
   in the Case lifecycle contracts?" — No, it is not.

### Suggested resolution

Architect should either:
A. Add `permissiveExitCodes?: number[]` to `CaseConfig` and
   `CreateCaseInput`, passed through to the underlying
   ToolInvocation.
B. Wrap the Case lifecycle methods to accept a
   `ToolInvocationRequest`-like options object including
   `permissiveExitCodes`.
