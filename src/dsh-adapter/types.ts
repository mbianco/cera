/**
 * Public types and interfaces for the dsh-adapter module.
 *
 * These are the STABLE surface that cera's domain modules depend on.
 * The adapter translates between these stable types and dsh's volatile
 * extension-point types (defined in context.ts, internal to this
 * module).
 *
 * No dsh types appear in any public signature here. Domain modules
 * import from this module and see only cera-internal types.
 *
 * Spec references: api-contracts.md §1; ADR-005; assumptions.md A1.
 */

import type { ExitOutcome, JSONSchema } from '../types';

// ============================================================================
// Shell execution (wraps ctx.shell)
// ============================================================================

/**
 * Options for shell command execution.
 *
 * Spec: api-contracts.md §1 (ShellExecuteOptions).
 */
export interface ShellExecuteOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeout?: number; // milliseconds
  readonly stdin?: string;
}

/**
 * Result of a shell command execution. Contains stdout, stderr, and
 * an ExitOutcome (exit code or signal, never both, never neither —
 * INV-T2, INV-T5).
 *
 * Spec: api-contracts.md §1 (ShellResult).
 */
export interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitOutcome: ExitOutcome;
}

/**
 * Wraps ctx.shell for CLI tool execution (CDO, NCO).
 *
 * The sole interface cera modules use for synchronous CLI calls.
 * dsh's ctx.shell is never accessed directly outside this module.
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */
export interface ShellExecutor {
  execute(command: string, options?: ShellExecuteOptions): Promise<ShellResult>;
}

// ============================================================================
// Subprocess execution (wraps ctx.subprocess)
// ============================================================================

/**
 * Options for subprocess execution.
 *
 * Spec: api-contracts.md §1 (SubprocessOptions).
 */
export interface SubprocessOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeout?: number;
  readonly stdin?: string;
}

/**
 * Handle to a spawned subprocess. Supports streaming stdout/stderr
 * for long-running processes, signal-based termination, and waiting
 * for completion.
 *
 * The `wait()` method returns a ShellResult with the translated
 * ExitOutcome.
 *
 * Spec: api-contracts.md §1 (SubprocessHandle).
 */
export interface SubprocessHandle {
  readonly pid: number;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  kill(signal?: string): Promise<void>;
  wait(): Promise<ShellResult>;
}

/**
 * Wraps ctx.subprocess for fine-grained process control.
 * Supports both synchronous execution and async streaming.
 *
 * Used by: tool-invocation, scheduling, environment-management.
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */
export interface SubprocessRunner {
  spawn(command: string, args: string[], options?: SubprocessOptions): SubprocessHandle;
  execute(command: string, args: string[], options?: SubprocessOptions): Promise<ShellResult>;
}

// ============================================================================
// Sandbox execution (wraps ctx.sandbox)
// ============================================================================

/**
 * Options for sandboxed process execution. Extends SubprocessOptions
 * with filesystem path restrictions and network access control.
 *
 * Spec: api-contracts.md §1 (SandboxOptions).
 */
export interface SandboxOptions extends SubprocessOptions {
  readonly allowedPaths?: string[]; // filesystem paths the sandboxed process may access
  readonly allowNetwork?: boolean;
}

/**
 * Wraps ctx.sandbox for process confinement. Used for executing
 * legacy binaries with restricted filesystem and network access.
 *
 * Used by: tool-invocation.
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */
export interface SandboxRunner {
  execute(command: string, options?: SandboxOptions): Promise<ShellResult>;
  spawn(command: string, args: string[], options?: SandboxOptions): SubprocessHandle;
}

// ============================================================================
// Filesystem access (wraps ctx.fs)
// ============================================================================

/**
 * File metadata returned by stat().
 *
 * Spec: api-contracts.md §1 (FileStat).
 */
export interface FileStat {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly mtime: Date;
}

/**
 * Wraps ctx.fs for filesystem access and validation.
 *
 * Used by: data-management, provenance, environment-management.
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */
export interface FilesystemGateway {
  exists(path: string): Promise<boolean>;
  isReadable(path: string): Promise<boolean>;
  isWritable(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  readDir(path: string): Promise<string[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
}

// ============================================================================
// Background jobs (wraps ctx.jobs)
// ============================================================================

/**
 * Background work submitted to dsh's job system. This is NOT a SLURM
 * Job — it is work that dsh manages internally (e.g., async tasks,
 * event processing). SLURM Jobs are submitted via the scheduling
 * module using SubprocessRunner for CLI access.
 *
 * Spec: api-contracts.md §1 (BackgroundWork); module-graph.md §1.
 */
export interface BackgroundWork {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeout?: number;
}

/**
 * Status of background work, queried from dsh's job system.
 * The exitOutcome is null until the work reaches a terminal state.
 *
 * Spec: api-contracts.md §1 (BackgroundWorkStatus); module-graph.md §1.
 */
export interface BackgroundWorkStatus {
  readonly workId: string;
  readonly state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly exitOutcome: ExitOutcome | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * Wraps ctx.jobs for background work submission.
 *
 * Used by: scheduling (for internal dsh background tasks, not SLURM
 * Jobs — those use SubprocessRunner for CLI access).
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */
export interface JobBackend {
  submit(work: BackgroundWork): Promise<string>; // returns work ID
  query(workId: string): Promise<BackgroundWorkStatus>;
  cancel(workId: string): Promise<void>;
}

// ============================================================================
// Tool capability registry (wraps ctx.tools)
// ============================================================================

/**
 * A capability registered on dsh's ctx.tools so the LLM can discover
 * and invoke it. The parameters schema is a JSON Schema for validation.
 * The handler is called when the LLM invokes the capability.
 *
 * This is the adapter-level representation. The domain-level Action
 * (C7, R3) is translated into one or more ToolCapabilities by the
 * agent-interaction module.
 *
 * Spec: api-contracts.md §1 (ToolCapability); module-graph.md §1;
 * resolutions.md R3.
 */
export interface ToolCapability {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
  readonly handler: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Wraps ctx.tools for model-facing capability registration.
 *
 * Used by: agent-interaction (to register Actions as LLM-discoverable
 * capabilities).
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */
export interface ToolRegistry {
  register(capability: ToolCapability): Promise<void>;
  list(): Promise<ToolCapability[]>;
}

// ============================================================================
// Human command registry (wraps ctx.commands)
// ============================================================================

/**
 * A human-facing command registered on dsh's ctx.commands for
 * dispatch. The handler is called with parsed command-line arguments.
 *
 * Spec: api-contracts.md §1 (HumanCommand); module-graph.md §1.
 */
export interface HumanCommand {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly handler: (args: readonly string[]) => Promise<void>;
}

/**
 * Wraps ctx.commands for human-command dispatch.
 *
 * Used by: agent-interaction.
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */
export interface CommandRegistry {
  register(command: HumanCommand): Promise<void>;
  list(): Promise<HumanCommand[]>;
}
