/**
 * Unit tests for the dsh-adapter factory.
 *
 * Verifies:
 * - createDshAdapter returns all 7 adapter interfaces
 * - Each adapter delegates to the provided DshContext
 * - The factory is the single binding point between cera and dsh
 * - No dsh types leak through the factory's return type
 *
 * Spec: build-phases.md Phase 1; ADR-005; api-contracts.md §1.
 */

import { describe, it, expect, vi } from 'vitest';
import { createDshAdapter } from '../../src/dsh-adapter/factory';
import type { DshAdapter } from '../../src/dsh-adapter/factory';
import type {
  CommandRegistry,
  FilesystemGateway,
  JobBackend,
  SandboxRunner,
  ShellExecutor,
  SubprocessRunner,
  ToolRegistry,
} from '../../src/dsh-adapter/types';
import { createMockDshContext } from './helpers';

describe('createDshAdapter', () => {
  it('returns a DshAdapter with all 7 interfaces', () => {
    const ctx = createMockDshContext();
    const adapter = createDshAdapter(ctx);

    expect(adapter.shellExecutor).toBeDefined();
    expect(adapter.subprocessRunner).toBeDefined();
    expect(adapter.sandboxRunner).toBeDefined();
    expect(adapter.filesystemGateway).toBeDefined();
    expect(adapter.jobBackend).toBeDefined();
    expect(adapter.toolRegistry).toBeDefined();
    expect(adapter.commandRegistry).toBeDefined();
  });

  it('each interface implements its expected methods', () => {
    const ctx = createMockDshContext();
    const adapter: DshAdapter = createDshAdapter(ctx);

    // ShellExecutor
    const executor: ShellExecutor = adapter.shellExecutor;
    expect(typeof executor.execute).toBe('function');

    // SubprocessRunner
    const runner: SubprocessRunner = adapter.subprocessRunner;
    expect(typeof runner.spawn).toBe('function');
    expect(typeof runner.execute).toBe('function');

    // SandboxRunner
    const sandbox: SandboxRunner = adapter.sandboxRunner;
    expect(typeof sandbox.execute).toBe('function');
    expect(typeof sandbox.spawn).toBe('function');

    // FilesystemGateway
    const fs: FilesystemGateway = adapter.filesystemGateway;
    expect(typeof fs.exists).toBe('function');
    expect(typeof fs.isReadable).toBe('function');
    expect(typeof fs.isWritable).toBe('function');
    expect(typeof fs.stat).toBe('function');
    expect(typeof fs.readFile).toBe('function');
    expect(typeof fs.writeFile).toBe('function');
    expect(typeof fs.readDir).toBe('function');
    expect(typeof fs.mkdir).toBe('function');

    // JobBackend
    const jobs: JobBackend = adapter.jobBackend;
    expect(typeof jobs.submit).toBe('function');
    expect(typeof jobs.query).toBe('function');
    expect(typeof jobs.cancel).toBe('function');

    // ToolRegistry
    const tools: ToolRegistry = adapter.toolRegistry;
    expect(typeof tools.register).toBe('function');
    expect(typeof tools.list).toBe('function');

    // CommandRegistry
    const commands: CommandRegistry = adapter.commandRegistry;
    expect(typeof commands.register).toBe('function');
    expect(typeof commands.list).toBe('function');
  });

  it('all adapters share the same DshContext instance', async () => {
    const ctx = createMockDshContext();
    const adapter = createDshAdapter(ctx);

    // Each adapter should delegate to the same ctx
    await adapter.shellExecutor.execute('echo 1');
    await adapter.subprocessRunner.execute('echo', ['2']);
    await adapter.sandboxRunner.execute('echo 3');
    await adapter.filesystemGateway.exists('/path');
    await adapter.jobBackend.submit({ command: 'echo 4' });
    await adapter.toolRegistry.register({
      name: 't',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      handler: vi.fn(),
    });
    await adapter.commandRegistry.register({
      name: 'c',
      description: 'd',
      usage: 'c',
      handler: vi.fn(),
    });

    expect(ctx.shell.execute).toHaveBeenCalledTimes(1);
    expect(ctx.subprocess.execute).toHaveBeenCalledTimes(1);
    expect(ctx.sandbox.execute).toHaveBeenCalledTimes(1);
    expect(ctx.fs.exists).toHaveBeenCalledTimes(1);
    expect(ctx.jobs.submit).toHaveBeenCalledTimes(1);
    expect(ctx.tools.register).toHaveBeenCalledTimes(1);
    expect(ctx.commands.register).toHaveBeenCalledTimes(1);
  });

  it('factory return type does not expose DshContext', () => {
    const ctx = createMockDshContext();
    const adapter = createDshAdapter(ctx);

    // DshAdapter should not expose the context
    expect(adapter).not.toHaveProperty('context');
    expect(adapter).not.toHaveProperty('ctx');

    // Individual adapters should not expose context
    expect(adapter.shellExecutor).not.toHaveProperty('ctx');
    expect(adapter.subprocessRunner).not.toHaveProperty('ctx');
    expect(adapter.sandboxRunner).not.toHaveProperty('ctx');
    expect(adapter.filesystemGateway).not.toHaveProperty('ctx');
    expect(adapter.jobBackend).not.toHaveProperty('ctx');
    expect(adapter.toolRegistry).not.toHaveProperty('ctx');
    expect(adapter.commandRegistry).not.toHaveProperty('ctx');
  });

  it('creates independent adapter instances', () => {
    const ctx1 = createMockDshContext();
    const ctx2 = createMockDshContext();
    const adapter1 = createDshAdapter(ctx1);
    const adapter2 = createDshAdapter(ctx2);

    expect(adapter1.shellExecutor).not.toBe(adapter2.shellExecutor);
    expect(adapter1.subprocessRunner).not.toBe(adapter2.subprocessRunner);
    expect(adapter1.sandboxRunner).not.toBe(adapter2.sandboxRunner);
    expect(adapter1.filesystemGateway).not.toBe(adapter2.filesystemGateway);
    expect(adapter1.jobBackend).not.toBe(adapter2.jobBackend);
    expect(adapter1.toolRegistry).not.toBe(adapter2.toolRegistry);
    expect(adapter1.commandRegistry).not.toBe(adapter2.commandRegistry);
  });
});
