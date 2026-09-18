## Finding: `--uenv-specs` is optional in the CLI but F-INV-5 and INV-E1 require uenv in every Job
Severity: Critical
Category: Correctness > Missing negatives; Specification compliance
Location: `src/cli.ts` lines 41, 105, 162–164; `src/startup.ts` lines 82–83 (`JobScriptConfig.uenvSpecs?`); `specs/invariants-firecrest-primary.md` F-INV-5, INV-E1
Spec reference: F-INV-5 (uenv loaded in Job scripts); INV-E1 (re-evaluated: one Environment per Job); resolutions-r14.md R14.3

### Description

R14.3 states: "uenv is always loaded in Job scripts, not by cera."
F-INV-5 (elevated to primary production mechanism) states: "uenv is
loaded in Job scripts." INV-E1 (re-evaluated) states: "Each Job has
exactly one Environment — the uenv specified in the Job script."

However, the CLI and API contracts make uenv specs **optional**:

1. `src/cli.ts` line 41: `'uenv-specs': { type: 'string' }` — no
   `default`, no validation that it is provided for the FirecREST
   backend.
2. `src/cli.ts` line 105: `const uenvSpecsStr = args['uenv-specs'] ??
   process.env.CERA_UENV_SPECS ?? '';` — defaults to empty string.
3. `src/cli.ts` lines 162–164: when empty, `uenvSpecs` becomes
   `undefined` — no uenv specs are passed to `JobScriptConfig`.
4. `src/startup.ts` lines 82–83: `readonly uenvSpecs?: readonly
   string[]` — the `?` makes it optional.
5. `api-contracts-firecrest.md` `JobScriptConfig.uenvSpecs?` — also
   optional.

If a user runs `cera --firecrest-url ... --system daint ...` (without
`--uenv-specs`), the Job script is submitted with no `uenv start`
prefix. This means:
- **F-INV-5 is violated**: uenv is NOT loaded in the Job script.
- **INV-E1 (re-evaluated) is violated**: the Job has zero
  Environments, not exactly one.
- **INV-T1 (re-evaluated) is violated**: the Tool's required
  Environment is not loaded before the Tool command runs.

The spec does not address whether some Tools legitimately need no
uenv (e.g., a static binary with no dependencies). If such Tools
exist, the invariants need to be weakened. If not, `--uenv-specs`
must be required for the FirecREST backend.

### Evidence

1. `src/cli.ts` line 162: `const uenvSpecs = uenvSpecsStr ? ... :
   undefined;` — absent uenvSpecs is a valid state.
2. `specs/invariants-firecrest-primary.md` line 549: "F-INV-5: uenv
   is loaded in Job scripts, not by cera" — stated as the "only
   production mechanism."
3. `specs/invariants-firecrest-primary.md` lines 310–316: "Each Job
   has exactly one Environment — the uenv specified in the Job script"
   — requires exactly one, not zero.
4. `specs/resolutions-r14.md` R14.3: "uenv is always loaded in Job
   scripts" — "always" is contradicted by the optional CLI flag.

### Suggested resolution

Either (a) make `--uenv-specs` required for the FirecREST backend
(reject startup with a clear error if absent), or (b) document that
some Tools may have no uenv requirements and adjust INV-E1 and
F-INV-5 to say "if the Tool requires an Environment, uenv is loaded
in the Job script."
