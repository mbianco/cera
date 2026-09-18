## Finding: `--client-secret` visible in `ps` output — CLI accepts secret as argument, no explicit warning
Severity: Medium
Category: Security > Secret handling
Location: `src/cli.ts` lines 40, 104, 154–159
Spec reference: F-INV-2 (JWT token valid for every request); FM-F-2 (JWT token expired)

### Description

The CLI accepts `--client-secret` as a command-line argument (line
40: `'client-secret': { type: 'string' }`). Command-line arguments
are visible in `ps` output on any Unix system, and may be logged by
shell history, system accounting, and monitoring tools.

The help text at line 157 says: "(For security, prefer the
environment variable.)" — this is a passive suggestion, not a
warning. The CLI does **not**:

1. Print an explicit warning when `--client-secret` is used as a
   CLI argument (e.g., "WARNING: --client-secret is visible in ps
   output and shell history. Use CERA_CLIENT_SECRET instead.")
2. Refuse `--client-secret` entirely and require `CERA_CLIENT_SECRET`.
3. Redact the secret in any startup log output.

The `clientSecret` variable (line 104) is used to construct an
`OidcTokenProvider` (lines 202–205 in the commented-out code). The
token provider sends the secret to the OIDC token endpoint over
HTTPS. The secret itself is never logged, but its presence on the
command line is the risk.

**Existing CLI best practices:**
- `--firecrest-url` is validated to be HTTPS (line 135). This shows
  the CLI can enforce security constraints on arguments.
- `CERA_CLIENT_SECRET` is supported as an environment variable
  (line 104). This is the secure alternative.

### Evidence

1. `src/cli.ts` line 40: `'client-secret': { type: 'string' },` —
   accepts the secret as a CLI argument.
2. `src/cli.ts` line 104: `const clientSecret = args['client-secret']
   ?? process.env.CERA_CLIENT_SECRET ?? '';` — CLI arg takes
   precedence over env var.
3. `src/cli.ts` line 157: `(For security, prefer the environment
   variable.)` — passive suggestion, no active warning.
4. No code prints a warning when `args['client-secret']` is set
   (vs. `process.env.CERA_CLIENT_SECRET`).

### Suggested resolution

When `--client-secret` is provided as a CLI argument (not via
`CERA_CLIENT_SECRET`), print a warning to stderr: "WARNING:
--client-secret is visible in ps output and shell history. Consider
using the CERA_CLIENT_SECRET environment variable instead." Add a
test that verifies the warning is present.
