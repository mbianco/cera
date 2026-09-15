/**
 * Public types for the environment-management module (C5 — uenv).
 *
 * uenv, not Lmod (R9, ADR-003). Environments are squashfs mounts at
 * prescribed paths. Conflict detection is at the filesystem path
 * level, not the soname level (INV-E2, updated for uenv).
 *
 * Invariants enforced:
 * - INV-E1: At most one active Environment per execution context.
 *   Multiple uenvs may be mounted simultaneously if complementary
 *   (no path conflicts).
 * - INV-E2: Conflicts are detected at the filesystem PATH level
 *   before any Tool runs.
 * - INV-E3: uenv availability is checked via the uenv registry
 *   before attempting to mount.
 *
 * Spec references: api-contracts.md §3; module-graph.md §3;
 * invariants.md INV-E1–E3; resolutions.md R9; ADR-003.
 */

import type {
  Conflict,
  Environment,
  EnvironmentId,
  UenvSpec,
} from '../types';

// ============================================================================
// LoadUenvInput
// ============================================================================

/**
 * Input for loading (mounting) a uenv.
 *
 * The uenv is mounted at its prescribed path (from `uenvSpec.mountPath`).
 * `requiredBinaryPaths` are tool binary paths that must be available
 * after loading — used for INV-T1 verification (the Environment must
 * contain the Tool's binary).
 *
 * Spec: api-contracts.md §3 (LoadUenvInput).
 */
export interface LoadUenvInput {
  readonly uenvSpec: UenvSpec;
  /**
   * Tool binary paths that must be available after loading.
   * Used for INV-T1 verification: the Environment must contain
   * the Tool's binary. (Subsumes X14.)
   */
  readonly requiredBinaryPaths?: readonly string[];
}

// ============================================================================
// EnvironmentManagementConfig
// ============================================================================

/**
 * Configuration for the environment-management module.
 *
 * uenv CLI commands are executed via `SubprocessRunner`. The
 * `commandTimeoutMs` limits how long each command may run.
 *
 * The `uenvRegistryPath` is the filesystem path where the uenv
 * registry is located. Used for informational purposes — the actual
 * availability check is done via `uenv status`.
 *
 * Spec: ADR-003; invariants.md INV-E3.
 */
export interface EnvironmentManagementConfig {
  /** Timeout for individual uenv CLI commands (milliseconds). Default: 30000. */
  readonly commandTimeoutMs: number;
  /** Filesystem path to the uenv registry. Default: '/user-environment/env/'. */
  readonly uenvRegistryPath: string;
  /**
   * Whether to verify the mount after `uenv mount` (check that
   * the mount path exists and required binary paths are available).
   * Default: true (FM-E3: partial mount detection).
   */
  readonly verifyAfterMount: boolean;
}

/**
 * Default environment-management configuration per ADR-003.
 *
 * uenv registry path: `/user-environment/env/` (Alps standard).
 * Command timeout: 30s (same as SLURM commands).
 * Verify after mount: true (FM-E3).
 */
export const DEFAULT_ENVIRONMENT_CONFIG: EnvironmentManagementConfig = {
  commandTimeoutMs: 30_000,
  uenvRegistryPath: '/user-environment/env/',
  verifyAfterMount: true,
};

// ============================================================================
// EnvironmentService interface
// ============================================================================

/**
 * uenv-based environment management. Not Lmod (R9, ADR-003).
 * Environments are squashfs mounts at prescribed paths.
 *
 * INV-E1: At most one active Environment per execution context.
 *   Multiple uenvs may be mounted simultaneously if complementary
 *   (no path conflicts), but only one logical Environment is active.
 * INV-E2: Conflicts are detected at the filesystem path level
 *   before any Tool runs.
 * INV-E3: uenv availability is checked via the uenv registry before
 *   attempting to mount.
 *
 * Spec: api-contracts.md §3; module-graph.md §3; invariants.md
 * INV-E1–E3; resolutions.md R9; ADR-003.
 */
export interface EnvironmentService {
  /**
   * Checks whether a uenv exists in the uenv registry (INV-E3).
   * Replaces `module avail` / `module spider`.
   *
   * @returns true if the uenv is available, false otherwise.
   *
   * Spec: invariants.md INV-E3; resolutions.md R9; ADR-003.
   */
  checkUenvAvailability(name: string, version: string): Promise<boolean>;

  /**
   * Mounts a uenv (squashfs) at its prescribed path, verifies the
   * mount is conflict-free (INV-E1, INV-E2), and returns an active
   * Environment.
   *
   * @throws {import('../types').EnvironmentError & { kind: 'uenv_not_found' }}
   *   if the uenv does not exist (FM-E1).
   * @throws {import('../types').EnvironmentError & { kind: 'conflict_detected' }}
   *   if the uenv conflicts with the currently active Environment
   *   (FM-E2).
   * @throws {import('../types').EnvironmentError & { kind: 'partial_load' }}
   *   if the mount partially succeeds (FM-E3).
   *
   * Spec: api-contracts.md §3; invariants.md INV-E1, INV-E2, INV-E3;
   * failure-modes.md FM-E1, FM-E2, FM-E3.
   */
  loadUenv(request: LoadUenvInput): Promise<Environment>;

  /**
   * Unmounts a uenv.
   *
   * @throws {import('../types').EnvironmentError & { kind: 'not_active' }}
   *   if the Environment is no longer active.
   *
   * Spec: api-contracts.md §3.
   */
  unloadUenv(environmentId: EnvironmentId): Promise<void>;

  /**
   * Re-verifies an Environment is still active and conflict-free.
   * Called by tool-invocation immediately before a ToolInvocation
   * starts (X1 "out-of-order" case: env may have been purged or
   * replaced by another process between load and invocation).
   *
   * @returns true if the Environment is still active and
   *   conflict-free. false if it is no longer active.
   * @throws {import('../types').EnvironmentError & { kind: 'conflict_detected' }}
   *   if a conflict has appeared since the initial load.
   *
   * Spec: api-contracts.md §3; cross-context/interactions.md X1;
   * invariants.md INV-E2.
   */
  verifyEnvironment(environmentId: EnvironmentId): Promise<boolean>;

  /**
   * Detects filesystem path conflicts between uenvs (INV-E2,
   * updated for uenv: path-level, not soname-level).
   *
   * @returns Array of conflicts (empty if no conflicts).
   *
   * Spec: api-contracts.md §3; invariants.md INV-E2; ADR-003.
   */
  detectConflicts(uenvSpecs: UenvSpec[]): Promise<Conflict[]>;

  /**
   * Returns the currently active Environment, or null if none.
   * At most one Environment is active per execution context (INV-E1).
   *
   * Spec: api-contracts.md §3; invariants.md INV-E1.
   */
  getActiveEnvironment(): Environment | null;
}

// ============================================================================
// Branded ID helper (internal to this module)
// ============================================================================

/**
 * Creates an EnvironmentId from a string. Uses a type assertion
 * because the brand symbol is private to value-objects.ts.
 */
export function createEnvironmentId(id: string): EnvironmentId {
  return id as EnvironmentId;
}
