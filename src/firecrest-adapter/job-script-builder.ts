/**
 * Job script builder for the FirecREST backend (F-INV-5).
 *
 * Under the FirecREST backend, cera runs on a laptop and has no
 * direct access to the HPC CLI. FirecREST does not expose uenv
 * management endpoints. Therefore, uenv is loaded inside the Job
 * script submitted via FirecREST — not by cera directly.
 *
 * This helper builds a Job script that:
 * 1. Starts with `#!/bin/bash`
 * 2. Optionally prepends `uenv start <spec> --` for each uenv spec
 *    (F-INV-5)
 * 3. Optionally prepends `export KEY=VALUE` for each environment
 *    variable
 * 4. Appends the command last
 *
 * Spec: specs/firecrest/invariants.md F-INV-5;
 * specs/firecrest/features/firecrest-backend.feature (uenv scenarios);
 * ADR-011.
 */

/**
 * Options for building a Job script.
 */
export interface BuildJobScriptOptions {
  /** uenv specs to load inside the Job (e.g., "cdo:2.0.5"). */
  readonly uenvSpecs?: readonly string[];
  /** Environment variables to set inside the Job. */
  readonly env?: Record<string, string>;
}

/**
 * Builds a Job script for FirecREST submission.
 *
 * The script starts with `#!/bin/bash`, optionally includes uenv
 * start commands (F-INV-5), optionally includes export statements
 * for environment variables, and ends with the command to execute.
 *
 * @param command - The command to execute (e.g., "cdo -timmean in.nc out.nc")
 * @param options - Optional uenv specs and environment variables
 * @returns A complete Job script string
 *
 * Spec: specs/firecrest/invariants.md F-INV-5;
 * ADR-011 (FirecREST as second backend).
 */
export function buildJobScript(
  command: string,
  options?: BuildJobScriptOptions,
): string {
  const lines: string[] = ['#!/bin/bash'];

  // F-INV-5: uenv is loaded inside the Job script, not by cera.
  // Each spec is prepended as `uenv start <spec> --`.
  if (options?.uenvSpecs !== undefined) {
    for (const spec of options.uenvSpecs) {
      lines.push(`uenv start ${spec} --`);
    }
  }

  // Environment variables are set via export statements.
  if (options?.env !== undefined) {
    for (const [key, value] of Object.entries(options.env)) {
      lines.push(`export ${key}=${value}`);
    }
  }

  // The command is appended last.
  lines.push(command);

  return lines.join('\n');
}
