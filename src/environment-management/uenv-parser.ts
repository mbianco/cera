/**
 * uenv CLI output parser.
 *
 * Parses output from the uenv CLI commands (mount, umount, status,
 * list) into cera's domain types. The parser is the foundation for
 * INV-E3 (availability verified via uenv registry, not module avail)
 * and INV-E2 (conflict detection at the filesystem path level).
 *
 * uenv, not Lmod (R9, ADR-003). The CLI commands are:
 * - `uenv status <name>/<version>` — check availability. Exit 0 if
 *   available, non-zero if not.
 * - `uenv mount <name>/<version>` — mount the squashfs at the
 *   prescribed path. Exit 0 on success.
 * - `uenv umount <name>/<version>` — unmount. Exit 0 on success.
 * - `uenv list` — list mounted uenvs. One per line:
 *   `<name>/<version> <mount_path>`.
 *
 * Spec: api-contracts.md §3; module-graph.md §3; invariants.md
 * INV-E2, INV-E3; resolutions.md R9; ADR-003.
 */

import type { ExitOutcome } from '../types';

// ============================================================================
// Name/version parsing
// ============================================================================

/**
 * Parses a uenv name/version string in the format `<name>/<version>`.
 *
 * @returns An object with `name` and `version` properties.
 * @throws {Error} if the string is not in the expected format.
 *
 * Spec: ADR-003; features/environment-management.feature
 * (uenv name/version format).
 */
export function parseUenvNameVersion(
  spec: string,
): { readonly name: string; readonly version: string } {
  const trimmed = spec.trim();
  if (trimmed === '') {
    throw new Error('Cannot parse empty uenv name/version string');
  }
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    throw new Error(
      `Invalid uenv name/version format (expected '<name>/<version>'): '${trimmed}'`,
    );
  }
  const name = trimmed.slice(0, slashIndex);
  const version = trimmed.slice(slashIndex + 1);
  return { name, version };
}

// ============================================================================
// uenv status parsing
// ============================================================================

/**
 * Parses the result of `uenv status <name>/<version>`.
 *
 * uenv is available if the exit code is 0 (INV-E3). Non-zero exit
 * codes indicate the uenv is not in the registry.
 *
 * @returns true if the uenv is available (exit code 0), false
 *   otherwise.
 *
 * Spec: invariants.md INV-E3; resolutions.md R9; ADR-003.
 */
export function parseUenvStatus(exitOutcome: ExitOutcome): boolean {
  return exitOutcome.kind === 'exit_code' && exitOutcome.code === 0;
}

// ============================================================================
// uenv list parsing
// ============================================================================

/**
 * A parsed entry from `uenv list` output: name, version, and mount path.
 */
export interface UenvListEntry {
  readonly name: string;
  readonly version: string;
  readonly mountPath: string;
}

/**
 * Parses `uenv list` output.
 *
 * Output format: one line per mounted uenv, space-separated:
 *   cdo/2.0.5 /user-environment/env/cdo/2.0.5
 *   python-science/3.11.6 /user-environment/env/python-science/3.11.6
 *
 * Blank lines are skipped. Each line must have exactly two fields:
 * name/version and mount path.
 *
 * @returns Array of parsed entries (empty if input is empty).
 * @throws {Error} on any malformed line.
 *
 * Spec: ADR-003; features/environment-management.feature
 * (uenv list output).
 */
export function parseUenvList(stdout: string): UenvListEntry[] {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return [];
  }
  const lines = trimmed.split('\n');
  const entries: UenvListEntry[] = [];
  for (const line of lines) {
    const lineTrimmed = line.trim();
    if (lineTrimmed === '') {
      continue;
    }
    const parts = lineTrimmed.split(/\s+/);
    if (parts.length < 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new Error(
        `Malformed uenv list line (expected '<name>/<version> <mount_path>'): '${lineTrimmed}'`,
      );
    }
    const nameVersion = parseUenvNameVersion(parts[0]);
    entries.push({
      name: nameVersion.name,
      version: nameVersion.version,
      mountPath: parts[1],
    });
  }
  return entries;
}

// ============================================================================
// uenv mount result parsing
// ============================================================================

/**
 * The result of a `uenv mount` command.
 */
export interface MountResult {
  readonly success: boolean;
  readonly error?: string;
}

/**
 * Parses the result of `uenv mount <name>/<version>`.
 *
 * The mount succeeds if the exit code is 0. Non-zero exit codes
 * indicate a failure (partial mount, IO error, etc.).
 *
 * @returns A MountResult indicating success or failure.
 *
 * Spec: ADR-003; failure-modes.md FM-E3.
 */
export function parseUenvMountResult(
  exitOutcome: ExitOutcome,
  stderr: string = '',
): MountResult {
  if (exitOutcome.kind === 'exit_code' && exitOutcome.code === 0) {
    return { success: true };
  }
  return {
    success: false,
    error: stderr.trim() || `uenv mount failed (exit outcome: ${exitOutcome.kind})`,
  };
}

// ============================================================================
// uenv umount result parsing
// ============================================================================

/**
 * Parses the result of `uenv umount <name>/<version>`.
 *
 * The unmount succeeds if the exit code is 0.
 *
 * @returns true if the unmount succeeded.
 *
 * Spec: ADR-003.
 */
export function parseUenvUmountResult(exitOutcome: ExitOutcome): boolean {
  return exitOutcome.kind === 'exit_code' && exitOutcome.code === 0;
}
