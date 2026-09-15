/**
 * Environment-management module (C5 — uenv).
 *
 * uenv, not Lmod (R9, ADR-003). Mounts/unmounts uenvs (squashfs at
 * prescribed paths), checks availability via the uenv registry,
 * detects filesystem path conflicts, and verifies the Environment
 * is still active before invocation.
 *
 * Public surface:
 * - EnvironmentService interface and EnvironmentServiceImpl
 * - LoadUenvInput, EnvironmentManagementConfig
 * - ConflictDetector (filesystem path conflict detection)
 * - uenv parser functions (parseUenvStatus, parseUenvList, etc.)
 * - DEFAULT_ENVIRONMENT_CONFIG, createEnvironmentId
 *
 * Invariants enforced: INV-E1 (one active Environment), INV-E2
 * (conflict detection before execution), INV-E3 (uenv availability
 * verified before load).
 *
 * Failure modes handled: FM-E1 (UenvNotFound), FM-E2
 * (ConflictDetected), FM-E3 (PartialLoad).
 *
 * Spec: build-phases.md Phase 2; api-contracts.md §3;
 * module-graph.md §3; invariants.md INV-E1–E3; failure-modes.md
 * FM-E1–E3; resolutions.md R9; ADR-003.
 */

// Types
export type {
  EnvironmentService,
  LoadUenvInput,
  EnvironmentManagementConfig,
} from './types';
export {
  DEFAULT_ENVIRONMENT_CONFIG,
  createEnvironmentId,
} from './types';

// Conflict detector
export {
  ConflictDetector,
} from './conflict-detector';
export type {
  ConflictDetectorProps,
} from './conflict-detector';

// uenv parser
export {
  parseUenvStatus,
  parseUenvList,
  parseUenvNameVersion,
  parseUenvMountResult,
  parseUenvUmountResult,
} from './uenv-parser';
export type {
  UenvListEntry,
  MountResult,
} from './uenv-parser';

// Service implementation
export {
  EnvironmentServiceImpl,
} from './environment-service';
export type {
  EnvironmentServiceImplProps,
} from './environment-service';
