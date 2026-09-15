/**
 * Unit tests for CommandRegistry adapter.
 *
 * Verifies:
 * - Correct delegation to ctx.commands (register, list)
 * - HumanCommand → dsh raw format translation
 * - Command fields are passed through correctly
 * - Error translation (dsh errors → AdapterInternal)
 * - No dsh types leak in public signatures
 *
 * Spec: build-phases.md Phase 1; api-contracts.md §1;
 * ADR-005.
 */

import { describe, it, expect, vi } from 'vitest';
import { AdapterInternal } from '../../src/types/errors';
import { CommandRegistryImpl } from '../../src/dsh-adapter/command-registry';
import type { CommandRegistry, HumanCommand } from '../../src/dsh-adapter/types';
import {
  createMockDshContext,
  createMockHumanCommand,
} from './helpers';

describe('CommandRegistry', () => {
  describe('register()', () => {
    it('delegates to ctx.commands.register with the command', async () => {
      const ctx = createMockDshContext();
      ctx.commands.register = vi.fn().mockResolvedValue(undefined);
      const registry = new CommandRegistryImpl(ctx);
      const handler = vi.fn().mockResolvedValue(undefined);
      const command: HumanCommand = {
        name: 'list-datasets',
        description: 'List all registered Datasets',
        usage: 'list-datasets [--format netcdf] [--grid lat-lon]',
        handler,
      };

      await registry.register(command);

      expect(ctx.commands.register).toHaveBeenCalledWith({
        name: 'list-datasets',
        description: 'List all registered Datasets',
        usage: 'list-datasets [--format netcdf] [--grid lat-lon]',
        handler,
      });
    });

    it('registers a command with minimal fields', async () => {
      const ctx = createMockDshContext();
      ctx.commands.register = vi.fn().mockResolvedValue(undefined);
      const registry = new CommandRegistryImpl(ctx);
      const command: HumanCommand = {
        name: 'help',
        description: 'Show help',
        usage: 'help [command]',
        handler: vi.fn().mockResolvedValue(undefined),
      };

      await registry.register(command);

      expect(ctx.commands.register).toHaveBeenCalledTimes(1);
      expect(ctx.commands.register).toHaveBeenCalledWith(command);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.commands.register = vi.fn().mockRejectedValue(new Error('dsh error'));
      const registry = new CommandRegistryImpl(ctx);

      await expect(
        registry.register(createMockHumanCommand()),
      ).rejects.toThrow(AdapterInternal);
    });

    it('includes extension point and operation in error details', async () => {
      const ctx = createMockDshContext();
      ctx.commands.register = vi.fn().mockRejectedValue(new Error('dsh error'));
      const registry = new CommandRegistryImpl(ctx);

      try {
        await registry.register(createMockHumanCommand());
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterInternal);
        const adapterError = error as AdapterInternal;
        expect(adapterError.internalDetails).toContain('ctx.commands');
        expect(adapterError.internalDetails).toContain('register');
      }
    });
  });

  describe('list()', () => {
    it('delegates to ctx.commands.list', async () => {
      const ctx = createMockDshContext();
      const rawCommands = [
        createMockHumanCommand({ name: 'cmd-a', description: 'Cmd A' }),
        createMockHumanCommand({ name: 'cmd-b', description: 'Cmd B' }),
      ];
      ctx.commands.list = vi.fn().mockResolvedValue(rawCommands);
      const registry = new CommandRegistryImpl(ctx);

      const result = await registry.list();

      expect(ctx.commands.list).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
    });

    it('returns commands with translated fields', async () => {
      const ctx = createMockDshContext();
      const handler = vi.fn().mockResolvedValue(undefined);
      const rawCommands = [
        createMockHumanCommand({
          name: 'list-datasets',
          description: 'List all Datasets',
          usage: 'list-datasets [--format]',
          handler,
        }),
      ];
      ctx.commands.list = vi.fn().mockResolvedValue(rawCommands);
      const registry = new CommandRegistryImpl(ctx);

      const result = await registry.list();

      expect(result[0]?.name).toBe('list-datasets');
      expect(result[0]?.description).toBe('List all Datasets');
      expect(result[0]?.usage).toBe('list-datasets [--format]');
      expect(result[0]?.handler).toBe(handler);
    });

    it('returns empty array when no commands registered', async () => {
      const ctx = createMockDshContext();
      ctx.commands.list = vi.fn().mockResolvedValue([]);
      const registry = new CommandRegistryImpl(ctx);

      const result = await registry.list();

      expect(result).toEqual([]);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.commands.list = vi.fn().mockRejectedValue(new Error('dsh error'));
      const registry = new CommandRegistryImpl(ctx);

      await expect(registry.list()).rejects.toThrow(AdapterInternal);
    });
  });

  describe('interface stability', () => {
    it('implements the CommandRegistry interface', () => {
      const ctx = createMockDshContext();
      const registry: CommandRegistry = new CommandRegistryImpl(ctx);

      expect(typeof registry.register).toBe('function');
      expect(typeof registry.list).toBe('function');
    });

    it('does not expose the ctx property', () => {
      const ctx = createMockDshContext();
      const registry = new CommandRegistryImpl(ctx);

      expect(registry).not.toHaveProperty('ctx');
    });

    it('HumanCommand has cera types (name, description, usage, handler)', () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const command: HumanCommand = {
        name: 'status',
        description: 'Show current status',
        usage: 'status [--jobs] [--datasets]',
        handler,
      };

      const keys = Object.keys(command).sort();
      expect(keys).toEqual(['description', 'handler', 'name', 'usage']);
    });

    it('list() returns HumanCommand[], not raw dsh type', async () => {
      const ctx = createMockDshContext();
      ctx.commands.list = vi.fn().mockResolvedValue([createMockHumanCommand()]);
      const registry = new CommandRegistryImpl(ctx);

      const result = await registry.list();

      // Each item should have cera property names
      expect(result[0]).toHaveProperty('name');
      expect(result[0]).toHaveProperty('description');
      expect(result[0]).toHaveProperty('usage');
      expect(result[0]).toHaveProperty('handler');
    });
  });
});
