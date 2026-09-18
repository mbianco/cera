/**
 * DEV-ONLY (R14, ADR-012).
 *
 * This module is NOT used in production. Under the FirecREST
 * backend, uenv is loaded in Job scripts (F-INV-5), not by cera.
 * The EnvironmentService interface and types (Environment,
 * UenvSpec, Module, Conflict) are used by tool-invocation to
 * construct Job scripts, but the runtime service (mount/unmount/
 * verify) is only active in dev mode (--backend dev).
 *
 * Spec: resolutions-r14.md R14.3; ADR-012;
 * invariants-firecrest-primary.md FP-INV-3.
 */

/**
 * EnvironmentService implementation (C5 — uenv).
 *
 * Mounts/unmounts uenvs (squashfs at prescribed paths), checks
 * availability via the uenv registry (INV-E3), detects filesystem
 * path conflicts (INV-E2), verifies the Environment is still active
 * before invocation (X1 "out-of-order" case), and maintains at most
 * one active Environment per execution context (INV-E1).
 *
 * uenv, not Lmod (R9, ADR-003). The service uses:
 * - `SubprocessRunner` for `uenv mount`/`uenv umount` commands
 * - `ShellExecutor` for `uenv status`/`uenv list` commands
 * - `FilesystemGateway` for mount path and binary path verification
 *
 * Invariants enforced:
 * - INV-E1: At most one active Environment. Multiple uenvs may be
 *   mounted simultaneously if complementary (no path conflicts).
 *   If a conflict is detected, the second load is rejected.
 * - INV-E2: Conflicts are detected at the filesystem path level
 *   (via ConflictDetector) before any Tool runs.
 * - INV-E3: uenv availability is checked via `uenv status` before
 *   attempting to mount. If the uenv is not in the registry, the
 *   load is refused (UenvNotFound, FM-E1).
 *
 * Failure modes handled:
 * - FM-E1: UenvNotFound — uenv not in registry (exit code != 0
 *   from `uenv status`).
 * - FM-E2: ConflictDetected — filesystem path conflict between
 *   the new uenv and the currently active Environment.
 * - FM-E3: PartialLoad — mount partially succeeds (mount path or
 *   required binary paths not verified after mount).
 *
 * Spec: api-contracts.md §3; module-graph.md §3; invariants.md
 * INV-E1–E3; failure-modes.md FM-E1–E3; resolutions.md R9;
 * ADR-003; cross-context/interactions.md X1.
 */

import type {
  ShellExecutor,
  SubprocessRunner,
  ShellResult,
} from '../dsh-adapter/types';
import type {
  Conflict,
  Environment,
  EnvironmentEvent,
  EnvironmentId,
  UenvSpec,
  Module,
} from '../types';
import {
  ConflictDetected,
  NotActive,
  PartialLoad,
  UenvNotFound,
} from '../types/errors';
import {
  ConflictDetector,
} from './conflict-detector';
import type {
  EnvironmentManagementConfig,
  LoadUenvInput,
} from './types';
import {
  createEnvironmentId,
  DEFAULT_ENVIRONMENT_CONFIG,
} from './types';
import {
  parseUenvStatus,
  parseUenvList,
  parseUenvMountResult,
} from './uenv-parser';

// ============================================================================
// Internal Environment tracking
// ============================================================================

/**
 * Internal mutable Environment record. The `environment` field is
 * the immutable Environment that callers see.
 */
interface InternalEnvironmentRecord {
  environment: Environment;
  uenvSpecs: UenvSpec[];
}

// ============================================================================
// EnvironmentServiceImpl
// ============================================================================

/**
 * Constructor parameters for EnvironmentServiceImpl.
 */
export interface EnvironmentServiceImplProps {
  readonly subprocessRunner: SubprocessRunner;
  readonly shellExecutor: ShellExecutor;
  readonly filesystem: import('../dsh-adapter/types').FilesystemGateway;
  readonly config?: Partial<EnvironmentManagementConfig>;
  readonly onEvent?: (event: EnvironmentEvent) => void;
}

/**
 * uenv-based environment management service.
 *
 * INV-E1: One active Environment per execution context. Multiple
 *   uenvs may be mounted simultaneously if complementary (no path
 *   conflicts). If a conflict is detected, the load is rejected.
 * INV-E2: Conflicts are detected at the filesystem path level
 *   before any Tool runs.
 * INV-E3: uenv availability is checked via `uenv status` before
 *   mounting.
 *
 * Spec: api-contracts.md §3; invariants.md INV-E1–E3;
 * failure-modes.md FM-E1–E3; resolutions.md R9; ADR-003.
 */
export class EnvironmentServiceImpl {
  #subprocessRunner: SubprocessRunner;
  #shellExecutor: ShellExecutor;
  #filesystem: import('../dsh-adapter/types').FilesystemGateway;
  #config: EnvironmentManagementConfig;
  #conflictDetector: ConflictDetector;
  #onEvent?: (event: EnvironmentEvent) => void;
  #activeEnvironment: InternalEnvironmentRecord | null = null;

  constructor(props: EnvironmentServiceImplProps) {
    this.#subprocessRunner = props.subprocessRunner;
    this.#shellExecutor = props.shellExecutor;
    this.#filesystem = props.filesystem;
    this.#config = { ...DEFAULT_ENVIRONMENT_CONFIG, ...props.config };
    this.#conflictDetector = new ConflictDetector({
      filesystem: props.filesystem,
    });
    this.#onEvent = props.onEvent;
  }

  // ========================================================================
  // checkUenvAvailability (INV-E3)
  // ========================================================================

  /**
   * Checks whether a uenv exists in the uenv registry (INV-E3).
   * Runs `uenv status <name>/<version>` via ShellExecutor.
   *
   * @returns true if the uenv is available (exit code 0), false
   *   otherwise.
   *
   * Spec: invariants.md INV-E3; resolutions.md R9; ADR-003.
   */
  async checkUenvAvailability(
    name: string,
    version: string,
  ): Promise<boolean> {
    const command = `uenv status ${name}/${version}`;
    let result: ShellResult;
    try {
      result = await this.#shellExecutor.execute(command, {
        timeout: this.#config.commandTimeoutMs,
      });
    } catch {
      // If the command itself fails (not just non-zero exit), treat
      // as unavailable.
      return false;
    }

    return parseUenvStatus(result.exitOutcome);
  }

  // ========================================================================
  // loadUenv (INV-E1, INV-E2, INV-E3; FM-E1, FM-E2, FM-E3)
  // ========================================================================

  /**
   * Mounts a uenv (squashfs) at its prescribed path, verifies the
   * mount is conflict-free (INV-E1, INV-E2), and returns an active
   * Environment.
   *
   * Flow:
   * 1. Check uenv availability via `uenv status` (INV-E3).
   *    If not available → throw UenvNotFound (FM-E1).
   * 2. Detect conflicts with the currently active Environment
   *    (INV-E1, INV-E2). If conflicts → throw ConflictDetected
   *    (FM-E2).
   * 3. Mount via `uenv mount <name>/<version>`.
   * 4. Verify the mount (if `verifyAfterMount` is enabled):
   *    Check that the mount path exists and required binary paths
   *    are available. If verification fails → unmount, throw
   *    PartialLoad (FM-E3).
   * 5. Create or update the active Environment and return it.
   *
   * Spec: api-contracts.md §3; invariants.md INV-E1, INV-E2, INV-E3;
   * failure-modes.md FM-E1, FM-E2, FM-E3; ADR-003.
   */
  async loadUenv(request: LoadUenvInput): Promise<Environment> {
    const { uenvSpec, requiredBinaryPaths } = request;

    // INV-E3: Check uenv availability before mounting
    const available = await this.checkUenvAvailability(
      uenvSpec.name,
      uenvSpec.version,
    );
    if (!available) {
      throw new UenvNotFound({
        name: uenvSpec.name,
        version: uenvSpec.version,
      });
    }

    // INV-E1, INV-E2: Detect conflicts with currently active uenvs
    const currentSpecs =
      this.#activeEnvironment?.uenvSpecs ?? [];
    const allSpecs = [...currentSpecs, uenvSpec];
    const conflicts = await this.#conflictDetector.detectConflicts(allSpecs);
    if (conflicts.length > 0) {
      const conflict = conflicts[0];
      if (conflict !== undefined) {
        this.#emitConflictDetected(conflict);
        throw new ConflictDetected({
          conflict,
        });
      }
    }

    // Mount the uenv via `uenv mount <name>/<version>`
    const mountResult = await this.#subprocessRunner.execute(
      'uenv',
      ['mount', `${uenvSpec.name}/${uenvSpec.version}`],
      { timeout: this.#config.commandTimeoutMs },
    );

    const parsed = parseUenvMountResult(
      mountResult.exitOutcome,
      mountResult.stderr,
    );
    if (!parsed.success) {
      // Mount failed — treat as partial load (FM-E3)
      this.#emitVerificationFailed(uenvSpec, 'partial_mount');
      throw new PartialLoad({
        loadedPaths: [],
        failedPaths: [uenvSpec.mountPath],
        error: parsed.error ?? 'uenv mount failed',
      });
    }

    // FM-E3: Verify the mount (if enabled)
    if (this.#config.verifyAfterMount) {
      const verification = await this.#verifyMount(uenvSpec, requiredBinaryPaths);
      if (!verification.verified) {
        // Partial mount — unmount and throw
        await this.#unmountUenv(uenvSpec);
        this.#emitVerificationFailed(uenvSpec, 'partial_mount');
        throw new PartialLoad({
          loadedPaths: verification.loadedPaths,
          failedPaths: verification.failedPaths,
          error: verification.error ?? 'Mount verification failed',
        });
      }
    }

    // Create or update the active Environment
    const newSpecs = [...currentSpecs, uenvSpec];
    const environmentId = createEnvironmentId(
      `env-${newSpecs.map((s) => s.name).join('-')}-${Date.now()}`,
    );

    // Build modules from the uenv specs (each uenv is a Module)
    const modules: Module[] = newSpecs.map((spec) => ({
      name: spec.name,
      version: spec.version,
      prefix: spec.mountPath,
    }));

    const environment: Environment = {
      id: environmentId,
      uenvSpecs: newSpecs,
      modules,
      conflictFree: true,
      active: true,
      loadedAt: new Date(),
    };

    this.#activeEnvironment = {
      environment,
      uenvSpecs: newSpecs,
    };

    this.#emitEnvironmentLoaded(environment);
    return environment;
  }

  // ========================================================================
  // unloadUenv
  // ========================================================================

  /**
   * Unmounts a uenv.
   *
   * If the Environment has multiple uenvs, all are unmounted and
   * the Environment is set to inactive. If the Environment is not
   * found or not active, `NotActive` is thrown.
   *
   * Spec: api-contracts.md §3.
   */
  async unloadUenv(environmentId: EnvironmentId): Promise<void> {
    const record = this.#activeEnvironment;
    if (record === null || record.environment.id !== environmentId) {
      throw new NotActive({
        userMessage: `Environment '${environmentId}' is no longer active.`,
        internalDetails: `Environment ${environmentId} not found or not active`,
        recoveryHint: 'Reload the required uenv.',
        specRef: 'api-contracts.md §3; invariants.md INV-E1',
      });
    }

    // Unmount all uenvs in the Environment
    for (const spec of record.uenvSpecs) {
      await this.#unmountUenv(spec);
    }

    // Mark the Environment as inactive
    record.environment = {
      ...record.environment,
      active: false,
    };
    this.#activeEnvironment = null;

    this.#emitEnvironmentUnloaded(environmentId, 'user_requested');
  }

  // ========================================================================
  // verifyEnvironment (X1 "out-of-order" case)
  // ========================================================================

  /**
   * Re-verifies an Environment is still active and conflict-free
   * (X1 "out-of-order" case: env may have been purged or replaced
   * by another process between load and invocation).
   *
   * @returns true if the Environment is still active and
   *   conflict-free.
   * @throws {NotActive} if the Environment is no longer active
   *   (uenv unmounted by another process).
   * @throws {ConflictDetected} if a conflict has appeared since
   *   the initial load.
   *
   * Spec: api-contracts.md §3; cross-context/interactions.md X1;
   * invariants.md INV-E2.
   */
  async verifyEnvironment(environmentId: EnvironmentId): Promise<boolean> {
    const record = this.#activeEnvironment;
    if (record === null || record.environment.id !== environmentId) {
      throw new NotActive({
        userMessage: `Environment '${environmentId}' is no longer active.`,
        internalDetails: `Environment ${environmentId} not found or not active`,
        recoveryHint: 'Reload the required uenv before invoking the Tool.',
        specRef: 'cross-context/interactions.md X1; invariants.md INV-E1',
      });
    }

    // Check if the uenvs are still mounted by running `uenv list`
    const mountedUenvs = await this.#runUenvList();
    const mountedSet = new Set(
      mountedUenvs.map((e) => `${e.name}/${e.version}`),
    );

    for (const spec of record.uenvSpecs) {
      const specKey = `${spec.name}/${spec.version}`;
      if (!mountedSet.has(specKey)) {
        // The uenv was unmounted by another process (X1)
        this.#activeEnvironment = null;
        this.#emitVerificationFailed(environmentId, 'not_active');
        throw new NotActive({
          userMessage: `uenv '${specKey}' is no longer mounted. The Environment has been purged.`,
          internalDetails: `uenv ${specKey} not in uenv list output`,
          recoveryHint: 'Reload the required uenv before invoking the Tool.',
          specRef: 'cross-context/interactions.md X1; invariants.md INV-E1',
        });
      }
    }

    // Re-check for conflicts (INV-E2)
    const conflicts = await this.#conflictDetector.detectConflicts(
      record.uenvSpecs,
    );
    if (conflicts.length > 0) {
      const conflict = conflicts[0];
      if (conflict !== undefined) {
        this.#emitConflictDetected(conflict);
        throw new ConflictDetected({
          conflict,
        });
      }
    }

    return true;
  }

  // ========================================================================
  // detectConflicts (INV-E2)
  // ========================================================================

  /**
   * Detects filesystem path conflicts between uenvs (INV-E2).
   * Delegates to the ConflictDetector.
   *
   * Spec: api-contracts.md §3; invariants.md INV-E2; ADR-003.
   */
  async detectConflicts(uenvSpecs: UenvSpec[]): Promise<Conflict[]> {
    return this.#conflictDetector.detectConflicts(uenvSpecs);
  }

  // ========================================================================
  // getActiveEnvironment (INV-E1)
  // ========================================================================

  /**
   * Returns the currently active Environment, or null if none.
   * At most one Environment is active per execution context (INV-E1).
   *
   * Spec: api-contracts.md §3; invariants.md INV-E1.
   */
  getActiveEnvironment(): Environment | null {
    return this.#activeEnvironment?.environment ?? null;
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /**
   * Runs `uenv list` via ShellExecutor and returns the parsed
   * output.
   */
  async #runUenvList(): Promise<ReturnType<typeof parseUenvList>> {
    const result = await this.#shellExecutor.execute('uenv list', {
      timeout: this.#config.commandTimeoutMs,
    });
    return parseUenvList(result.stdout);
  }

  /**
   * Unmounts a single uenv via `uenv umount <name>/<version>`.
   * Does not throw on failure (best-effort cleanup).
   */
  async #unmountUenv(spec: UenvSpec): Promise<void> {
    try {
      await this.#subprocessRunner.execute(
        'uenv',
        ['umount', `${spec.name}/${spec.version}`],
        { timeout: this.#config.commandTimeoutMs },
      );
    } catch {
      // Best-effort unmount — ignore errors during cleanup
    }
  }

  /**
   * Verifies that a uenv mount succeeded by checking:
   * 1. The mount path exists (FilesystemGateway.exists).
   * 2. All required binary paths exist (FilesystemGateway.exists).
   *
   * @returns An object with `verified`, `loadedPaths`,
   *   `failedPaths`, and `error`.
   */
  async #verifyMount(
    spec: UenvSpec,
    requiredBinaryPaths?: readonly string[],
  ): Promise<{
    verified: boolean;
    loadedPaths: string[];
    failedPaths: string[];
    error?: string;
  }> {
    const loadedPaths: string[] = [];
    const failedPaths: string[] = [];

    // Check the mount path
    const mountExists = await this.#filesystem.exists(spec.mountPath);
    if (mountExists) {
      loadedPaths.push(spec.mountPath);
    } else {
      failedPaths.push(spec.mountPath);
    }

    // Check required binary paths
    if (requiredBinaryPaths !== undefined) {
      for (const binPath of requiredBinaryPaths) {
        const fullPath = spec.mountPath + '/usr/bin/' + binPath;
        const binExists = await this.#filesystem.exists(fullPath);
        if (binExists) {
          loadedPaths.push(fullPath);
        } else {
          failedPaths.push(fullPath);
        }
      }
    }

    if (failedPaths.length > 0) {
      return {
        verified: false,
        loadedPaths,
        failedPaths,
        error: `Paths not found after mount: ${failedPaths.join(', ')}`,
      };
    }

    return {
      verified: true,
      loadedPaths,
      failedPaths: [],
    };
  }

  // ========================================================================
  // Event emission
  // ========================================================================

  #emitEnvironmentLoaded(environment: Environment): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'environment_loaded',
        environmentId: environment.id,
        uenvSpecs: environment.uenvSpecs,
        conflictFree: environment.conflictFree,
        timestamp: new Date(),
      });
    }
  }

  #emitEnvironmentUnloaded(
    environmentId: EnvironmentId,
    reason: 'user_requested' | 'conflict' | 'session_end',
  ): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'environment_unloaded',
        environmentId,
        reason,
        timestamp: new Date(),
      });
    }
  }

  #emitConflictDetected(conflict: Conflict): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'environment_conflict_detected',
        conflict,
        timestamp: new Date(),
      });
    }
  }

  #emitVerificationFailed(
    environmentId: EnvironmentId | UenvSpec,
    reason: 'not_active' | 'conflict_appeared' | 'partial_mount',
  ): void {
    if (this.#onEvent) {
      // If environmentId is a UenvSpec (load-time failure), use a
      // temporary ID. Otherwise, use the real EnvironmentId.
      const id =
        typeof environmentId === 'string'
          ? (environmentId as EnvironmentId)
          : (environmentId.name as unknown as EnvironmentId);
      this.#onEvent({
        kind: 'environment_verification_failed',
        environmentId: id,
        reason,
        timestamp: new Date(),
      });
    }
  }
}
