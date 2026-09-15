/**
 * Internal types describing the shape of the dsh context that cera
 * needs. These are NOT dsh types — they are cera's own abstractions
 * of what dsh's extension points must provide. When dsh is installed,
 * a binding function maps dsh's actual context to this interface.
 *
 * If a dsh extension point changes shape, only the raw types here
 * and the adapter's translation logic need updating (ADR-005). No
 * domain module is affected.
 *
 * Spec references: ADR-005; assumptions.md A1; api-contracts.md §1.
 */

import type { JSONSchema } from '../types';

// ============================================================================
// Raw dsh return types
// ============================================================================

/**
 * Raw result from a dsh shell or subprocess execution. Contains both
 * exit code and signal information — the adapter translates this to
 * an ExitOutcome (signal takes precedence per INV-T5).
 *
 * Internal to dsh-adapter. Never exposed to domain modules.
 */
export interface DshRawExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signalName: string | null;
  readonly signalNumber: number | null;
}

/**
 * Raw handle to a dsh-spawned process. The adapter wraps this in a
 * SubprocessHandle that translates the wait() result.
 *
 * Internal to dsh-adapter. Never exposed to domain modules.
 */
export interface DshRawProcessHandle {
  readonly pid: number;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  kill(signal?: string): Promise<void>;
  wait(): Promise<DshRawExecutionResult>;
}

/**
 * Raw file stat from dsh's ctx.fs. Matches the cera FileStat shape
 * directly, so translation is trivial — but the indirection ensures
 * that if dsh's stat format changes, only this type and the adapter
 * translation need updating.
 *
 * Internal to dsh-adapter. Never exposed to domain modules.
 */
export interface DshRawFileStat {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly mtime: Date;
}

/**
 * Raw job status from dsh's ctx.jobs. The adapter translates this to
 * a BackgroundWorkStatus with a proper ExitOutcome.
 *
 * Internal to dsh-adapter. Never exposed to domain modules.
 */
export interface DshRawJobStatus {
  readonly workId: string;
  readonly state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly exitCode: number | null;
  readonly signalName: string | null;
  readonly signalNumber: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * Raw tool capability as dsh's ctx.tools sees it. Matches the cera
 * ToolCapability shape directly.
 *
 * Internal to dsh-adapter. Never exposed to domain modules.
 */
export interface DshRawToolCapability {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
  readonly handler: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Raw human command as dsh's ctx.commands sees it. Matches the cera
 * HumanCommand shape directly.
 *
 * Internal to dsh-adapter. Never exposed to domain modules.
 */
export interface DshRawHumanCommand {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly handler: (args: readonly string[]) => Promise<void>;
}

// ============================================================================
// DshContext — the shape cera needs from dsh
// ============================================================================

/**
 * The shape of the dsh context that cera's adapter requires. This is
 * a cera-internal abstraction — it describes what cera needs from
 * dsh's extension points, without importing dsh directly.
 *
 * When dsh is installed on the HPC, a factory function binds dsh's
 * actual context to this interface. If dsh's extension points change
 * shape between versions, only this type and the adapter's translation
 * logic need updating (ADR-005, FM-X3).
 *
 * The binding function (createDshAdapter) accepts any object that
 * satisfies this interface. In tests, a mock object is used. In
 * production, dsh's context is passed after verifying it satisfies
 * this interface.
 *
 * Spec: ADR-005; assumptions.md A1; api-contracts.md §1.
 */
export interface DshContext {
  /** Wraps dsh's ctx.shell extension point. */
  readonly shell: {
    execute(
      command: string,
      options?: {
        readonly cwd?: string;
        readonly env?: Record<string, string>;
        readonly timeout?: number;
        readonly stdin?: string;
      },
    ): Promise<DshRawExecutionResult>;
  };

  /** Wraps dsh's ctx.subprocess extension point. */
  readonly subprocess: {
    spawn(
      command: string,
      args: string[],
      options?: {
        readonly cwd?: string;
        readonly env?: Record<string, string>;
        readonly timeout?: number;
        readonly stdin?: string;
      },
    ): DshRawProcessHandle;
    execute(
      command: string,
      args: string[],
      options?: {
        readonly cwd?: string;
        readonly env?: Record<string, string>;
        readonly timeout?: number;
        readonly stdin?: string;
      },
    ): Promise<DshRawExecutionResult>;
  };

  /** Wraps dsh's ctx.sandbox extension point. */
  readonly sandbox: {
    execute(
      command: string,
      options?: {
        readonly cwd?: string;
        readonly env?: Record<string, string>;
        readonly timeout?: number;
        readonly stdin?: string;
        readonly allowedPaths?: string[];
        readonly allowNetwork?: boolean;
      },
    ): Promise<DshRawExecutionResult>;
    spawn(
      command: string,
      args: string[],
      options?: {
        readonly cwd?: string;
        readonly env?: Record<string, string>;
        readonly timeout?: number;
        readonly stdin?: string;
        readonly allowedPaths?: string[];
        readonly allowNetwork?: boolean;
      },
    ): DshRawProcessHandle;
  };

  /** Wraps dsh's ctx.fs extension point. */
  readonly fs: {
    exists(path: string): Promise<boolean>;
    isReadable(path: string): Promise<boolean>;
    isWritable(path: string): Promise<boolean>;
    stat(path: string): Promise<DshRawFileStat>;
    readFile(path: string): Promise<Buffer>;
    writeFile(path: string, data: Buffer): Promise<void>;
    readDir(path: string): Promise<string[]>;
    mkdir(path: string, recursive?: boolean): Promise<void>;
  };

  /** Wraps dsh's ctx.jobs extension point. */
  readonly jobs: {
    submit(work: {
      readonly command: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly timeout?: number;
    }): Promise<string>;
    query(workId: string): Promise<DshRawJobStatus>;
    cancel(workId: string): Promise<void>;
  };

  /** Wraps dsh's ctx.tools extension point. */
  readonly tools: {
    register(capability: DshRawToolCapability): Promise<void>;
    list(): Promise<DshRawToolCapability[]>;
  };

  /** Wraps dsh's ctx.commands extension point. */
  readonly commands: {
    register(command: DshRawHumanCommand): Promise<void>;
    list(): Promise<DshRawHumanCommand[]>;
  };
}
