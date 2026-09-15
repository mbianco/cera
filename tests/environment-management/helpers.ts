/**
 * Test helpers for the environment-management module.
 *
 * Provides mock SubprocessRunner, ShellExecutor, and
 * FilesystemGateway factories, and uenv output data factories so
 * tests can verify uenv parsing, conflict detection, and invariant
 * enforcement without a real uenv installation.
 *
 * Spec: build-phases.md Phase 2 (Tier 1 — unit tests with mock uenv).
 */

import { vi } from 'vitest';
import type {
  ShellResult,
  ShellExecutor,
  SubprocessRunner,
  SubprocessOptions,
  FilesystemGateway,
} from '../../src/dsh-adapter/types';
import type {
  Environment,
  EnvironmentId,
  ExitOutcome,
  UenvSpec,
  Module,
} from '../../src/types';

// ============================================================================
// uenv output string constants
// ============================================================================

/**
 * uenv status success output — uenv is available.
 */
export const UENV_STATUS_AVAILABLE_OUTPUT = 'cdo/2.0.5: available\n';

/**
 * uenv status failure output — uenv not found.
 */
export const UENV_STATUS_NOT_FOUND_STDERR = 'uenv: error: cdo/99.99.99 not found\n';

/**
 * uenv list output — two uenvs mounted.
 */
export const UENV_LIST_OUTPUT = [
  'cdo/2.0.5 /user-environment/env/cdo/2.0.5',
  'python-science/3.11.6 /user-environment/env/python-science/3.11.6',
].join('\n') + '\n';

/**
 * uenv list output — single uenv mounted.
 */
export const UENV_LIST_SINGLE_OUTPUT = 'cdo/2.0.5 /user-environment/env/cdo/2.0.5\n';

/**
 * uenv list output — empty (no uenvs mounted).
 */
export const UENV_LIST_EMPTY_OUTPUT = '';

/**
 * uenv mount success output.
 */
export const UENV_MOUNT_SUCCESS_OUTPUT = 'Mounted cdo/2.0.5 at /user-environment/env/cdo/2.0.5\n';

/**
 * uenv mount failure output (partial mount, IO error).
 */
export const UENV_MOUNT_FAILURE_STDERR = 'uenv: error: mount failed: Input/output error\n';

// ============================================================================
// Mock ShellResult factory
// ============================================================================

export function createMockShellResult(
  overrides: Partial<ShellResult> = {},
): ShellResult {
  return {
    stdout: '',
    stderr: '',
    exitOutcome: { kind: 'exit_code', code: 0 },
    ...overrides,
  };
}

// ============================================================================
// Mock ExitOutcome factory
// ============================================================================

export function createMockExitOutcome(
  overrides: Partial<ExitOutcome> = {},
): ExitOutcome {
  return {
    kind: 'exit_code',
    code: 0,
    ...overrides,
  } as ExitOutcome;
}

// ============================================================================
// Mock SubprocessRunner factory
// ============================================================================

export interface MockSubprocessResponse {
  readonly match: string;
  readonly result: ShellResult;
  readonly exact?: boolean;
}

export function createMockSubprocessRunner(
  overrides: {
    responses?: MockSubprocessResponse[];
    defaultResult?: ShellResult;
  } = {},
): SubprocessRunner & {
  readonly calls: { command: string; args: readonly string[] }[];
} {
  const responses = overrides.responses ?? [];
  const defaultResult =
    overrides.defaultResult ?? createMockShellResult();
  const calls: { command: string; args: readonly string[] }[] = [];

  const findResponse = (
    command: string,
    args: readonly string[],
  ): ShellResult => {
    for (const r of responses) {
      const cmdMatch = r.exact
        ? command === r.match
        : command.startsWith(r.match);
      if (cmdMatch) return r.result;
      // Also match on command + first arg
      const firstArg = args[0];
      if (firstArg !== undefined && firstArg.startsWith(r.match)) {
        return r.result;
      }
    }
    return defaultResult;
  };

  const runner = {
    execute: vi.fn(
      async (
        command: string,
        args: string[],
        _options?: SubprocessOptions,
      ): Promise<ShellResult> => {
        calls.push({ command, args });
        return findResponse(command, args);
      },
    ),
    spawn: vi.fn(),
    calls,
  };

  return runner;
}

// ============================================================================
// Mock ShellExecutor factory
// ============================================================================

export function createMockShellExecutor(
  overrides: {
    responses?: { readonly match: string; readonly result: ShellResult }[];
    defaultResult?: ShellResult;
  } = {},
): ShellExecutor & {
  readonly calls: { command: string }[];
} {
  const responses = overrides.responses ?? [];
  const defaultResult =
    overrides.defaultResult ?? createMockShellResult();
  const calls: { command: string }[] = [];

  const findResponse = (command: string): ShellResult => {
    for (const r of responses) {
      if (command.includes(r.match)) {
        return r.result;
      }
    }
    return defaultResult;
  };

  const executor = {
    execute: vi.fn(
      async (
        command: string,
        _options?: { cwd?: string; env?: Record<string, string>; timeout?: number; stdin?: string },
      ): Promise<ShellResult> => {
        calls.push({ command });
        return findResponse(command);
      },
    ),
    calls,
  };

  return executor;
}

// ============================================================================
// Mock FilesystemGateway factory (in-memory)
// ============================================================================

/**
 * An in-memory mock FilesystemGateway with configurable directory
 * listings. Directories are pre-populated with file names to
 * simulate uenv mount contents.
 *
 * Usage:
 *   const fs = createMockFilesystem({
 *     directories: new Map([
 *       ['/uenv/cdo/2.0.5/usr/bin', ['cdo', 'ncdump']],
 *       ['/uenv/cdo/2.0.5/usr/lib', ['libnetcdf.so.4', 'libimf.so']],
 *     ]),
 *   });
 */
export function createMockFilesystem(overrides: {
  readonly directories?: ReadonlyMap<string, readonly string[]>;
  readonly failOnExists?: boolean;
} = {}): FilesystemGateway & {
  readonly dirContents: Map<string, Set<string>>;
  readonly existsCalls: string[];
} {
  const dirContents = new Map<string, Set<string>>();
  if (overrides.directories) {
    for (const [path, entries] of overrides.directories) {
      dirContents.set(path, new Set(entries));
    }
  }
  const existsCalls: string[] = [];
  const fileSet = new Set<string>(); // for individual files

  const fs: FilesystemGateway = {
    async exists(path: string): Promise<boolean> {
      existsCalls.push(path);
      if (fileSet.has(path)) return true;
      // Check if it's a directory
      for (const dirPath of dirContents.keys()) {
        if (dirPath === path) return true;
        if (dirPath.startsWith(path + '/')) return true;
      }
      // Check if it's a file in a directory
      const lastSlash = path.lastIndexOf('/');
      if (lastSlash > 0) {
        const dir = path.slice(0, lastSlash);
        const file = path.slice(lastSlash + 1);
        const entries = dirContents.get(dir);
        if (entries !== undefined && entries.has(file)) {
          return true;
        }
      }
      return false;
    },

    async isReadable(path: string): Promise<boolean> {
      return dirContents.has(path) || fileSet.has(path);
    },

    async isWritable(_path: string): Promise<boolean> {
      return true;
    },

    async stat(path: string) {
      const entries = dirContents.get(path);
      if (entries !== undefined) {
        return {
          size: 0,
          isFile: false,
          isDirectory: true,
          mtime: new Date(),
        };
      }
      const lastSlash = path.lastIndexOf('/');
      if (lastSlash > 0) {
        const dir = path.slice(0, lastSlash);
        const file = path.slice(lastSlash + 1);
        const dirEntries = dirContents.get(dir);
        if (dirEntries !== undefined && dirEntries.has(file)) {
          return {
            size: 100,
            isFile: true,
            isDirectory: false,
            mtime: new Date(),
          };
        }
      }
      return {
        size: 0,
        isFile: false,
        isDirectory: false,
        mtime: new Date(),
      };
    },

    async readFile(_path: string): Promise<Buffer> {
      return Buffer.from('', 'utf-8');
    },

    async writeFile(path: string, _data: Buffer): Promise<void> {
      fileSet.add(path);
    },

    async readDir(path: string): Promise<string[]> {
      const entries = dirContents.get(path);
      if (entries !== undefined) {
        return Array.from(entries);
      }
      return [];
    },

    async mkdir(path: string, _recursive?: boolean): Promise<void> {
      if (!dirContents.has(path)) {
        dirContents.set(path, new Set());
      }
    },
  };

  return {
    ...fs,
    dirContents,
    existsCalls,
  };
}

// ============================================================================
// UenvSpec factory
// ============================================================================

export function createMockUenvSpec(overrides: {
  name?: string;
  version?: string;
  mountPath?: string;
} = {}): UenvSpec {
  return {
    name: overrides.name ?? 'cdo',
    version: overrides.version ?? '2.0.5',
    mountPath:
      overrides.mountPath ?? '/user-environment/env/cdo/2.0.5',
  };
}

// ============================================================================
// Environment factory
// ============================================================================

export function createMockEnvironment(overrides: {
  id?: EnvironmentId;
  uenvSpecs?: readonly UenvSpec[];
  modules?: readonly Module[];
  conflictFree?: boolean;
  active?: boolean;
  loadedAt?: Date;
} = {}): Environment {
  const uenvSpecs = overrides.uenvSpecs ?? [createMockUenvSpec()];
  const modules: readonly Module[] =
    overrides.modules ??
    uenvSpecs.map((spec) => ({
      name: spec.name,
      version: spec.version,
      prefix: spec.mountPath,
    }));

  return {
    id: overrides.id ?? createEnvironmentId('env-test-001'),
    uenvSpecs,
    modules,
    conflictFree: overrides.conflictFree ?? true,
    active: overrides.active ?? true,
    loadedAt: overrides.loadedAt ?? new Date('2026-09-15T10:00:00Z'),
  };
}

// ============================================================================
// Branded ID factory
// ============================================================================

export function createEnvironmentId(id: string): EnvironmentId {
  return id as EnvironmentId;
}
