/**
 * Test helpers for the dsh-adapter module.
 *
 * Provides mock DshContext factories and mock raw types so that
 * tests can verify adapter delegation and error translation without
 * a real dsh installation.
 *
 * Spec: build-phases.md Phase 1 (Tier 1 — unit tests with mock dsh).
 */

import { vi } from 'vitest';
import type {
  DshContext,
  DshRawExecutionResult,
  DshRawFileStat,
  DshRawJobStatus,
  DshRawProcessHandle,
  DshRawToolCapability,
  DshRawHumanCommand,
} from '../../src/dsh-adapter/context';

// ============================================================================
// Mock raw dsh types
// ============================================================================

/** Creates a mock DshRawExecutionResult with sensible defaults. */
export function createMockRawResult(
  overrides: Partial<DshRawExecutionResult> = {},
): DshRawExecutionResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signalName: null,
    signalNumber: null,
    ...overrides,
  };
}

/** Creates a mock DshRawProcessHandle with sensible defaults. */
export function createMockProcessHandle(
  overrides: Partial<DshRawProcessHandle> = {},
): DshRawProcessHandle {
  return {
    pid: 12345,
    stdout: (async function* () {
      /* empty stream */
    })(),
    stderr: (async function* () {
      /* empty stream */
    })(),
    kill: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(createMockRawResult()),
    ...overrides,
  };
}

/** Creates a mock DshRawFileStat with sensible defaults. */
export function createMockFileStat(
  overrides: Partial<DshRawFileStat> = {},
): DshRawFileStat {
  return {
    size: 1024,
    isFile: true,
    isDirectory: false,
    mtime: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Creates a mock DshRawJobStatus with sensible defaults. */
export function createMockJobStatus(
  overrides: Partial<DshRawJobStatus> = {},
): DshRawJobStatus {
  return {
    workId: 'work-001',
    state: 'pending',
    exitCode: null,
    signalName: null,
    signalNumber: null,
    ...overrides,
  };
}

/** Creates a mock DshRawToolCapability with sensible defaults. */
export function createMockToolCapability(
  overrides: Partial<DshRawToolCapability> = {},
): DshRawToolCapability {
  return {
    name: 'test-tool',
    description: 'A test tool capability',
    parameters: { type: 'object', properties: {} },
    handler: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Creates a mock DshRawHumanCommand with sensible defaults. */
export function createMockHumanCommand(
  overrides: Partial<DshRawHumanCommand> = {},
): DshRawHumanCommand {
  return {
    name: 'test-command',
    description: 'A test human command',
    usage: 'test-command [options]',
    handler: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ============================================================================
// Mock DshContext factory
// ============================================================================

/**
 * Creates a mock DshContext with all 7 extension points. Each method
 * is a vi.fn() with a sensible default return value, so tests can
 * override specific behaviors and assert on calls.
 *
 * Usage:
 *   const ctx = createMockDshContext();
 *   ctx.shell.execute.mockResolvedValue(createMockRawResult({ exitCode: 0 }));
 *   const executor = new ShellExecutorImpl(ctx);
 *   const result = await executor.execute('echo hello');
 *   expect(ctx.shell.execute).toHaveBeenCalledWith('echo hello', undefined);
 */
export function createMockDshContext(): DshContext {
  return {
    shell: {
      execute: vi.fn().mockResolvedValue(createMockRawResult()),
    },
    subprocess: {
      spawn: vi.fn().mockReturnValue(createMockProcessHandle()),
      execute: vi.fn().mockResolvedValue(createMockRawResult()),
    },
    sandbox: {
      execute: vi.fn().mockResolvedValue(createMockRawResult()),
      spawn: vi.fn().mockReturnValue(createMockProcessHandle()),
    },
    fs: {
      exists: vi.fn().mockResolvedValue(true),
      isReadable: vi.fn().mockResolvedValue(true),
      isWritable: vi.fn().mockResolvedValue(true),
      stat: vi.fn().mockResolvedValue(createMockFileStat()),
      readFile: vi.fn().mockResolvedValue(Buffer.from('test')),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readDir: vi.fn().mockResolvedValue(['file1.txt', 'file2.txt']),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
    jobs: {
      submit: vi.fn().mockResolvedValue('work-001'),
      query: vi.fn().mockResolvedValue(createMockJobStatus()),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
    tools: {
      register: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([createMockToolCapability()]),
    },
    commands: {
      register: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([createMockHumanCommand()]),
    },
  };
}
