/**
 * dsh-adapter module — the isolation layer between dsh and cera.
 *
 * This is the ONLY module in cera that imports dsh directly (when
 * dsh is installed). All other modules import from here and see only
 * cera-internal types.
 *
 * Public surface (stable, cera-internal):
 * - ShellExecutor, SubprocessRunner, SandboxRunner,
 *   FilesystemGateway, JobBackend, ToolRegistry, CommandRegistry
 * - ShellResult, SubprocessHandle, FileStat, BackgroundWork,
 *   BackgroundWorkStatus, ToolCapability, HumanCommand
 * - createDshAdapter factory
 *
 * Internal (for binding and testing only):
 * - DshContext and raw dsh types (in context.ts)
 *
 * Spec: ADR-005; assumptions.md A1; api-contracts.md §1;
 * module-graph.md §1; build-phases.md Phase 1.
 */

// Public types and interfaces
export type {
  ShellExecutor,
  ShellExecuteOptions,
  ShellResult,
  SubprocessRunner,
  SubprocessOptions,
  SubprocessHandle,
  SandboxRunner,
  SandboxOptions,
  FilesystemGateway,
  FileStat,
  JobBackend,
  BackgroundWork,
  BackgroundWorkStatus,
  ToolRegistry,
  ToolCapability,
  CommandRegistry,
  HumanCommand,
} from './types';

// Factory
export { createDshAdapter } from './factory';
export type { DshAdapter } from './factory';

// Implementation classes (exported for direct use if needed, but
// domain modules should prefer the interfaces)
export { ShellExecutorImpl } from './shell-executor';
export { SubprocessRunnerImpl } from './subprocess-runner';
export { SandboxRunnerImpl } from './sandbox-runner';
export { FilesystemGatewayImpl } from './filesystem-gateway';
export { JobBackendImpl } from './job-backend';
export { ToolRegistryImpl } from './tool-registry';
export { CommandRegistryImpl } from './command-registry';

// DshContext — exported for binding (production) and mocking (tests).
// NOT a dsh type — it is cera's own abstraction of what dsh must
// provide. Domain modules should not import this directly.
export type { DshContext } from './context';
