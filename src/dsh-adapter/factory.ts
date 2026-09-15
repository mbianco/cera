/**
 * Factory for the dsh-adapter module.
 *
 * Creates all 7 adapter instances from a DshContext. This is the
 * single entry point for binding cera to dsh — domain modules
 * receive the adapter instances and never see DshContext or any
 * raw dsh type.
 *
 * When dsh is installed on the HPC, a binding function (added later)
 * will accept dsh's actual context, verify it satisfies DshContext,
 * and call createDshAdapter. If dsh's shape changes between versions,
 * only the binding and context.ts need updating (ADR-005, FM-X3).
 *
 * Spec: ADR-005; assumptions.md A1; build-phases.md Phase 1.
 */

import type { DshContext } from './context';
import { CommandRegistryImpl } from './command-registry';
import { FilesystemGatewayImpl } from './filesystem-gateway';
import { JobBackendImpl } from './job-backend';
import { SandboxRunnerImpl } from './sandbox-runner';
import { ShellExecutorImpl } from './shell-executor';
import { SubprocessRunnerImpl } from './subprocess-runner';
import { ToolRegistryImpl } from './tool-registry';
import type {
  CommandRegistry,
  FilesystemGateway,
  JobBackend,
  SandboxRunner,
  ShellExecutor,
  SubprocessRunner,
  ToolRegistry,
} from './types';

/**
 * Aggregate of all 7 dsh-adapter interfaces. Domain modules receive
 * this aggregate (or individual interfaces) and never see DshContext
 * or any raw dsh type.
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */
export interface DshAdapter {
  readonly shellExecutor: ShellExecutor;
  readonly subprocessRunner: SubprocessRunner;
  readonly sandboxRunner: SandboxRunner;
  readonly filesystemGateway: FilesystemGateway;
  readonly jobBackend: JobBackend;
  readonly toolRegistry: ToolRegistry;
  readonly commandRegistry: CommandRegistry;
}

/**
 * Creates a DshAdapter from a DshContext. This is the single binding
 * point between cera and dsh.
 *
 * @param context - The dsh context (or a mock for testing). Must
 *   satisfy the DshContext interface — all 7 extension points must
 *   be present with the methods cera needs.
 * @returns A DshAdapter with all 7 adapter interfaces.
 *
 * Spec: ADR-005; assumptions.md A1; build-phases.md Phase 1.
 */
export function createDshAdapter(context: DshContext): DshAdapter {
  return {
    shellExecutor: new ShellExecutorImpl(context),
    subprocessRunner: new SubprocessRunnerImpl(context),
    sandboxRunner: new SandboxRunnerImpl(context),
    filesystemGateway: new FilesystemGatewayImpl(context),
    jobBackend: new JobBackendImpl(context),
    toolRegistry: new ToolRegistryImpl(context),
    commandRegistry: new CommandRegistryImpl(context),
  };
}
