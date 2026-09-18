## Finding: `--backend dev` on a login node bypasses all FirecREST security — no runtime guard
Severity: High
Category: Security > Dev mode safety; Correctness > Missing negatives
Location: `src/cli.ts` lines 99, 113–121, 234–264; `specs/invariants-firecrest-primary.md` FP-INV-2; `specs/architecture/build-phases-firecrest.md` Phase A
Spec reference: FP-INV-2 (local backend is not a production path); R14.5; R14.7

### Description

FP-INV-2 states: "No production deployment uses `--backend dev`." The
enforcement is described as "CLI help text says 'development only'.
Documentation describes only FirecREST." This is **documentation-only
enforcement** — there is no runtime guard.

**Scenario:** A scientist is on an Alps login node (where dsh and
SLURM CLI are available). They run `cera --backend dev` by mistake
(perhaps copy-pasting from old notes, or muscle memory from a
previous version). On the login node:

1. `createDevSystem()` succeeds if `dshConfig` is provided (or if the
   CLI stub is replaced with real dev wiring that auto-detects dsh).
2. The agent runs **all HPC operations via local subprocess**:
   - `SubprocessRunner.execute("sbatch", ...)` — direct SLURM, no
     JWT, no FirecREST audit trail.
   - `SubprocessRunner.execute("uenv", "mount", ...)` — direct uenv,
     no F-INV-5.
   - `FilesystemGateway.readFile("/scratch/...")` — direct filesystem
     access, no FirecREST stat.
3. **All FirecREST security is bypassed:**
   - No JWT authentication (F-INV-2 bypassed).
   - No FirecREST audit trail (operations are not logged via REST).
   - No 5-second timeout (F-INV-3 bypassed).
   - No large-file async handling (F-INV-4 bypassed).
   - Synchronous execution is possible (F-INV-6 bypassed).

**Current mitigations (insufficient):**
- `createDevSystem()` throws if `dshConfig` is not provided
  (`startup.ts` lines 298–303). But on a login node, the user could
  provide `dshConfig: { systemName: "daint" }` trivially.
- CLI help text says "development only" (`cli.ts` line 85). But help
  text is not shown unless `--help` is passed.
- `runDevBackend()` logs "development only" (`cli.ts` line 235). But
  this is a `console.log`, not a warning, and could be missed in
  logs.

**Missing:**
1. No check for `NODE_ENV=production` or similar environment markers.
2. No explicit warning printed when `--backend dev` is used (e.g.,
   "WARNING: --backend dev bypasses FirecREST security and is not a
   production path. All HPC operations will be unauthenticated.")
3. No test that verifies the warning is present in dev mode.
4. No documentation of the specific risk (unauthenticated HPC
   operations on a login node).
5. No mechanism to disable `--backend dev` entirely in a production
   build.

### Evidence

1. `src/cli.ts` line 99: `const backend = args.backend ??
   process.env.CERA_BACKEND ?? 'firecrest';` — no warning for `dev`.
2. `src/cli.ts` lines 113–121: `if (backend === 'dev') {
   await runDevBackend(); }` — no additional guard.
3. `src/cli.ts` line 235: `console.log('cera — starting with dev
   backend (development only)');` — info log, not a warning.
4. `specs/invariants-firecrest-primary.md` lines 599–612: FP-INV-2
   enforcement is "No user-facing documentation mentions `--backend
   dev` as a production option" — documentation only, no runtime
   guard.
5. `specs/architecture/build-phases-firecrest.md` Phase A: no mention
   of a runtime warning for `--backend dev`.

### Suggested resolution

Add a runtime warning (printed to stderr in yellow/red) when
`--backend dev` is used, clearly stating: (a) this is not a
production path, (b) all HPC operations will bypass FirecREST
security (no JWT, no audit trail), (c) do not use on an HPC login
node in production. Add a test that verifies the warning is present.
Consider adding a `--allow-dev-in-production` escape hatch for
explicit override, or disabling `--backend dev` entirely when
`NODE_ENV=production`.
