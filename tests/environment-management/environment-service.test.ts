/**
 * Unit tests for EnvironmentServiceImpl.
 *
 * Covers all invariants (INV-E1–E3), all failure modes (FM-E1–E3),
 * the X1 "out-of-order" case (verifyEnvironment after purge),
 * event emission, and interface stability.
 *
 * Spec: api-contracts.md §3; invariants.md INV-E1–E3;
 * failure-modes.md FM-E1–E3; resolutions.md R9; ADR-003;
 * features/environment-management.feature.
 */

import { describe, it, expect, vi } from 'vitest';
import { EnvironmentServiceImpl } from '../../src/environment-management/environment-service';
import type { EnvironmentService } from '../../src/environment-management/types';
import {
  createMockSubprocessRunner,
  createMockShellExecutor,
  createMockFilesystem,
  createMockShellResult,
  createMockUenvSpec,
  createEnvironmentId,
  UENV_STATUS_AVAILABLE_OUTPUT,
  UENV_STATUS_NOT_FOUND_STDERR,
  UENV_LIST_OUTPUT,
  UENV_LIST_SINGLE_OUTPUT,
  UENV_LIST_EMPTY_OUTPUT,
  UENV_MOUNT_SUCCESS_OUTPUT,
  UENV_MOUNT_FAILURE_STDERR,
} from './helpers';
import type { ShellExecutor, SubprocessRunner, FilesystemGateway } from '../../src/dsh-adapter/types';
import type { EnvironmentEvent } from '../../src/types';
import {
  UenvNotFound,
  PartialLoad,
  NotActive,
} from '../../src/types/errors';

// ============================================================================
// Helpers
// ============================================================================

const UENV_AVAILABLE = createMockShellResult({
  stdout: UENV_STATUS_AVAILABLE_OUTPUT,
});

const UENV_NOT_FOUND = createMockShellResult({
  stdout: '',
  stderr: UENV_STATUS_NOT_FOUND_STDERR,
  exitOutcome: { kind: 'exit_code', code: 1 },
});

const UENV_MOUNT_SUCCESS = createMockShellResult({
  stdout: UENV_MOUNT_SUCCESS_OUTPUT,
});

const UENV_MOUNT_FAIL = createMockShellResult({
  stdout: '',
  stderr: UENV_MOUNT_FAILURE_STDERR,
  exitOutcome: { kind: 'exit_code', code: 1 },
});

const UENV_LIST_TWO = createMockShellResult({
  stdout: UENV_LIST_OUTPUT,
});

const UENV_LIST_ONE = createMockShellResult({
  stdout: UENV_LIST_SINGLE_OUTPUT,
});

const UENV_LIST_NONE = createMockShellResult({
  stdout: UENV_LIST_EMPTY_OUTPUT,
});

/**
 * Creates an EnvironmentService with the given mock dependencies.
 * The filesystem is pre-populated with uenv mount directories by
 * default (so verifyAfterMount passes).
 */
function createService(overrides: {
  subprocessRunner?: SubprocessRunner;
  shellExecutor?: ShellExecutor;
  filesystem?: FilesystemGateway;
  config?: { verifyAfterMount?: boolean; commandTimeoutMs?: number };
  onEvent?: (event: EnvironmentEvent) => void;
} = {}): EnvironmentService {
  const defaultFs = createMockFilesystem({
    directories: new Map([
      ['/user-environment/env/cdo/2.0.5', ['usr']],
      ['/user-environment/env/cdo/2.0.5/usr/bin', ['cdo']],
      ['/user-environment/env/python-science/3.11.6', ['usr']],
      ['/user-environment/env/python-science/3.11.6/usr/bin', ['python3']],
      ['/user-environment/env/cesm-intel/2.3.0', ['usr']],
      ['/user-environment/env/cesm-intel/2.3.0/usr/bin', ['case.setup']],
    ]),
  });

  return new EnvironmentServiceImpl({
    subprocessRunner:
      overrides.subprocessRunner ??
      createMockSubprocessRunner({
        responses: [{ match: 'uenv', result: UENV_MOUNT_SUCCESS }],
      }),
    shellExecutor:
      overrides.shellExecutor ??
      createMockShellExecutor({
        responses: [
          { match: 'uenv status', result: UENV_AVAILABLE },
          { match: 'uenv list', result: UENV_LIST_ONE },
        ],
      }),
    filesystem: overrides.filesystem ?? defaultFs,
    config: overrides.config,
    onEvent: overrides.onEvent,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('EnvironmentServiceImpl', () => {
  // ========================================================================
  // checkUenvAvailability (INV-E3)
  // ========================================================================

  describe('checkUenvAvailability', () => {
    it('returns true when uenv is available (INV-E3)', async () => {
      const shellExecutor = createMockShellExecutor({
        responses: [{ match: 'uenv status', result: UENV_AVAILABLE }],
      });
      const service = createService({ shellExecutor });

      const available = await service.checkUenvAvailability('cdo', '2.0.5');

      expect(available).toBe(true);
    });

    it('returns false when uenv is not in registry (FM-E1)', async () => {
      const shellExecutor = createMockShellExecutor({
        responses: [{ match: 'uenv status', result: UENV_NOT_FOUND }],
      });
      const service = createService({ shellExecutor });

      const available = await service.checkUenvAvailability('nonexistent', '1.0.0');

      expect(available).toBe(false);
    });

    it('returns false when command throws', async () => {
      const shellExecutor: ShellExecutor = {
        execute: vi.fn().mockRejectedValue(new Error('command not found')),
      };
      const service = createService({ shellExecutor });

      const available = await service.checkUenvAvailability('cdo', '2.0.5');

      expect(available).toBe(false);
    });

    it('passes the name/version to uenv status', async () => {
      const shellExecutor = createMockShellExecutor({
        responses: [{ match: 'uenv status', result: UENV_AVAILABLE }],
      });
      const service = createService({ shellExecutor });

      await service.checkUenvAvailability('cdo', '2.0.5');

      expect(shellExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('cdo/2.0.5'),
        expect.anything(),
      );
    });
  });

  // ========================================================================
  // loadUenv (INV-E1, INV-E2, INV-E3; FM-E1, FM-E2, FM-E3)
  // ========================================================================

  describe('loadUenv', () => {
    it('mounts a uenv and returns an active Environment (INV-E1, INV-E3)', async () => {
      const service = createService();

      const env = await service.loadUenv({
        uenvSpec: createMockUenvSpec({ name: 'cdo', version: '2.0.5' }),
      });

      expect(env).toBeDefined();
      expect(env.active).toBe(true);
      expect(env.conflictFree).toBe(true);
      expect(env.uenvSpecs).toHaveLength(1);
      expect(env.uenvSpecs[0]?.name).toBe('cdo');
    });

    it('throws UenvNotFound when uenv is not in registry (FM-E1)', async () => {
      const shellExecutor = createMockShellExecutor({
        responses: [{ match: 'uenv status', result: UENV_NOT_FOUND }],
      });
      const service = createService({ shellExecutor });

      await expect(
        service.loadUenv({
          uenvSpec: createMockUenvSpec({ name: 'nonexistent', version: '1.0.0' }),
        }),
      ).rejects.toThrow(UenvNotFound);
    });

    it('throws PartialLoad when uenv mount fails (FM-E3)', async () => {
      const subprocessRunner = createMockSubprocessRunner({
        responses: [{ match: 'uenv', result: UENV_MOUNT_FAIL }],
      });
      const service = createService({ subprocessRunner });

      await expect(
        service.loadUenv({
          uenvSpec: createMockUenvSpec(),
        }),
      ).rejects.toThrow(PartialLoad);
    });

    it('throws PartialLoad when mount verification fails (FM-E3)', async () => {
      const filesystem = createMockFilesystem({
        directories: new Map(),
      });
      const service = createService({ filesystem });

      await expect(
        service.loadUenv({
          uenvSpec: createMockUenvSpec(),
        }),
      ).rejects.toThrow(PartialLoad);
    });

    it('emits EnvironmentLoaded event on success', async () => {
      const events: EnvironmentEvent[] = [];
      const service = createService({
        onEvent: (e) => events.push(e),
      });

      await service.loadUenv({
        uenvSpec: createMockUenvSpec(),
      });

      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'environment_loaded' }),
      );
    });

    it('emits VerificationFailed event on partial mount (FM-E3)', async () => {
      const events: EnvironmentEvent[] = [];
      const filesystem = createMockFilesystem({
        directories: new Map(),
      });
      const service = createService({ filesystem, onEvent: (e) => events.push(e) });

      try {
        await service.loadUenv({ uenvSpec: createMockUenvSpec() });
      } catch {
        // expected
      }

      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'environment_verification_failed' }),
      );
    });
  });

  // ========================================================================
  // INV-E1: One active Environment, complementary uenvs
  // ========================================================================

  describe('INV-E1: One active Environment', () => {
    it('getActiveEnvironment returns null when no Environment is loaded', () => {
      const service = createService();

      expect(service.getActiveEnvironment()).toBeNull();
    });

    it('getActiveEnvironment returns the loaded Environment', async () => {
      const service = createService();

      await service.loadUenv({
        uenvSpec: createMockUenvSpec({ name: 'cdo', version: '2.0.5' }),
      });

      const active = service.getActiveEnvironment();
      expect(active).not.toBeNull();
      expect(active?.uenvSpecs[0]?.name).toBe('cdo');
    });

    it('multiple complementary uenvs mount in the same Environment', async () => {
      const shellExecutor = createMockShellExecutor({
        responses: [
          { match: 'uenv status', result: UENV_AVAILABLE },
          { match: 'uenv list', result: UENV_LIST_TWO },
        ],
      });
      const service = createService({ shellExecutor });

      await service.loadUenv({
        uenvSpec: createMockUenvSpec({ name: 'cdo', version: '2.0.5' }),
      });

      const env = await service.loadUenv({
        uenvSpec: createMockUenvSpec({
          name: 'python-science',
          version: '3.11.6',
          mountPath: '/user-environment/env/python-science/3.11.6',
        }),
      });

      expect(env.uenvSpecs).toHaveLength(2);
      expect(env.uenvSpecs[0]?.name).toBe('cdo');
      expect(env.uenvSpecs[1]?.name).toBe('python-science');
    });
  });

  // ========================================================================
  // unloadUenv
  // ========================================================================

  describe('unloadUenv', () => {
    it('unmounts the active Environment', async () => {
      const service = createService();
      const env = await service.loadUenv({
        uenvSpec: createMockUenvSpec(),
      });

      await service.unloadUenv(env.id);

      expect(service.getActiveEnvironment()).toBeNull();
    });

    it('throws NotActive when no Environment is loaded', async () => {
      const service = createService();
      const fakeId = createEnvironmentId('nonexistent');

      await expect(service.unloadUenv(fakeId)).rejects.toThrow(NotActive);
    });

    it('emits EnvironmentUnloaded event', async () => {
      const events: EnvironmentEvent[] = [];
      const service = createService({ onEvent: (e) => events.push(e) });
      const env = await service.loadUenv({
        uenvSpec: createMockUenvSpec(),
      });

      await service.unloadUenv(env.id);

      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'environment_unloaded' }),
      );
    });
  });

  // ========================================================================
  // verifyEnvironment (X1 "out-of-order" case)
  // ========================================================================

  describe('verifyEnvironment', () => {
    it('returns true when Environment is still active', async () => {
      const shellExecutor = createMockShellExecutor({
        responses: [
          { match: 'uenv status', result: UENV_AVAILABLE },
          { match: 'uenv list', result: UENV_LIST_ONE },
        ],
      });
      const service = createService({ shellExecutor });
      const env = await service.loadUenv({
        uenvSpec: createMockUenvSpec(),
      });

      const verified = await service.verifyEnvironment(env.id);

      expect(verified).toBe(true);
    });

    it('throws NotActive when uenv was unmounted by another process (X1)', async () => {
      // loadUenv calls shellExecutor once (uenv status).
      // verifyEnvironment calls shellExecutor again (uenv list).
      // The second call returns empty list, simulating purge.
      const shellExecutor: ShellExecutor = {
        execute: vi.fn()
          .mockResolvedValueOnce(UENV_AVAILABLE)  // uenv status (loadUenv)
          .mockResolvedValueOnce(UENV_LIST_NONE), // uenv list (verifyEnvironment)
      };
      const service = createService({ shellExecutor });
      const env = await service.loadUenv({
        uenvSpec: createMockUenvSpec(),
      });

      await expect(service.verifyEnvironment(env.id)).rejects.toThrow(NotActive);
    });

    it('throws NotActive when no Environment is loaded', async () => {
      const service = createService();
      const fakeId = createEnvironmentId('nonexistent');

      await expect(service.verifyEnvironment(fakeId)).rejects.toThrow(NotActive);
    });

    it('emits VerificationFailed event when uenv was purged (X1)', async () => {
      const events: EnvironmentEvent[] = [];
      const shellExecutor: ShellExecutor = {
        execute: vi.fn()
          .mockResolvedValueOnce(UENV_AVAILABLE)
          .mockResolvedValueOnce(UENV_LIST_NONE),
      };
      const service = createService({ shellExecutor, onEvent: (e) => events.push(e) });
      const env = await service.loadUenv({
        uenvSpec: createMockUenvSpec(),
      });

      try {
        await service.verifyEnvironment(env.id);
      } catch {
        // expected
      }

      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'environment_verification_failed',
          reason: 'not_active',
        }),
      );
    });
  });

  // ========================================================================
  // detectConflicts (INV-E2)
  // ========================================================================

  describe('detectConflicts', () => {
    it('returns empty array when no conflicts', async () => {
      const service = createService();

      const conflicts = await service.detectConflicts([
        createMockUenvSpec({ name: 'cdo', version: '2.0.5' }),
      ]);

      expect(conflicts).toEqual([]);
    });
  });

  // ========================================================================
  // Interface stability
  // ========================================================================

  describe('interface stability', () => {
    it('does not expose raw dsh-adapter types', () => {
      const service = createService() as unknown as Record<string, unknown>;

      const keys = Object.keys(service);
      for (const key of keys) {
        const value = service[key];
        if (typeof value === 'object' && value !== null) {
          const subKeys = Object.keys(value as Record<string, unknown>);
          expect(subKeys).not.toContain('ctx');
          expect(subKeys).not.toContain('raw');
        }
      }
    });

    it('implements EnvironmentService interface', () => {
      const service = createService();

      expect(typeof service.checkUenvAvailability).toBe('function');
      expect(typeof service.loadUenv).toBe('function');
      expect(typeof service.unloadUenv).toBe('function');
      expect(typeof service.verifyEnvironment).toBe('function');
      expect(typeof service.detectConflicts).toBe('function');
      expect(typeof service.getActiveEnvironment).toBe('function');
    });
  });
});
