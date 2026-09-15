/**
 * Unit tests for ToolRegistry adapter.
 *
 * Verifies:
 * - Correct delegation to ctx.tools (register, list)
 * - ToolCapability → dsh raw format translation
 * - Capability fields are passed through correctly
 * - Error translation (dsh errors → AdapterInternal)
 * - No dsh types leak in public signatures
 *
 * Spec: build-phases.md Phase 1; api-contracts.md §1;
 * resolutions.md R3; ADR-005.
 */

import { describe, it, expect, vi } from 'vitest';
import { AdapterInternal } from '../../src/types/errors';
import { ToolRegistryImpl } from '../../src/dsh-adapter/tool-registry';
import type { ToolCapability, ToolRegistry } from '../../src/dsh-adapter/types';
import {
  createMockDshContext,
  createMockToolCapability,
} from './helpers';

describe('ToolRegistry', () => {
  describe('register()', () => {
    it('delegates to ctx.tools.register with the capability', async () => {
      const ctx = createMockDshContext();
      ctx.tools.register = vi.fn().mockResolvedValue(undefined);
      const registry = new ToolRegistryImpl(ctx);
      const handler = vi.fn().mockResolvedValue('result');
      const capability: ToolCapability = {
        name: 'select_variable',
        description: 'Select a variable from a Dataset',
        parameters: { type: 'object', properties: { name: { type: 'string' } } },
        handler,
      };

      await registry.register(capability);

      expect(ctx.tools.register).toHaveBeenCalledWith({
        name: 'select_variable',
        description: 'Select a variable from a Dataset',
        parameters: { type: 'object', properties: { name: { type: 'string' } } },
        handler,
      });
    });

    it('registers a capability with minimal fields', async () => {
      const ctx = createMockDshContext();
      ctx.tools.register = vi.fn().mockResolvedValue(undefined);
      const registry = new ToolRegistryImpl(ctx);
      const capability: ToolCapability = {
        name: 'compute_time_mean',
        description: 'Compute time mean',
        parameters: { type: 'object', properties: {} },
        handler: vi.fn().mockResolvedValue(undefined),
      };

      await registry.register(capability);

      expect(ctx.tools.register).toHaveBeenCalledTimes(1);
      expect(ctx.tools.register).toHaveBeenCalledWith(capability);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.tools.register = vi.fn().mockRejectedValue(new Error('dsh tools error'));
      const registry = new ToolRegistryImpl(ctx);

      await expect(
        registry.register(createMockToolCapability()),
      ).rejects.toThrow(AdapterInternal);
    });

    it('includes extension point and operation in error details', async () => {
      const ctx = createMockDshContext();
      ctx.tools.register = vi.fn().mockRejectedValue(new Error('dsh error'));
      const registry = new ToolRegistryImpl(ctx);

      try {
        await registry.register(createMockToolCapability());
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterInternal);
        const adapterError = error as AdapterInternal;
        expect(adapterError.internalDetails).toContain('ctx.tools');
        expect(adapterError.internalDetails).toContain('register');
      }
    });
  });

  describe('list()', () => {
    it('delegates to ctx.tools.list', async () => {
      const ctx = createMockDshContext();
      const rawCapabilities = [
        createMockToolCapability({ name: 'tool-a', description: 'Tool A' }),
        createMockToolCapability({ name: 'tool-b', description: 'Tool B' }),
      ];
      ctx.tools.list = vi.fn().mockResolvedValue(rawCapabilities);
      const registry = new ToolRegistryImpl(ctx);

      const result = await registry.list();

      expect(ctx.tools.list).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
    });

    it('returns capabilities with translated fields', async () => {
      const ctx = createMockDshContext();
      const handler = vi.fn().mockResolvedValue('result');
      const rawCapabilities = [
        createMockToolCapability({
          name: 'select_variable',
          description: 'Select a variable',
          parameters: { type: 'object', properties: { name: { type: 'string' } } },
          handler,
        }),
      ];
      ctx.tools.list = vi.fn().mockResolvedValue(rawCapabilities);
      const registry = new ToolRegistryImpl(ctx);

      const result = await registry.list();

      expect(result[0]?.name).toBe('select_variable');
      expect(result[0]?.description).toBe('Select a variable');
      expect(result[0]?.parameters).toEqual({
        type: 'object',
        properties: { name: { type: 'string' } },
      });
      expect(result[0]?.handler).toBe(handler);
    });

    it('returns empty array when no capabilities registered', async () => {
      const ctx = createMockDshContext();
      ctx.tools.list = vi.fn().mockResolvedValue([]);
      const registry = new ToolRegistryImpl(ctx);

      const result = await registry.list();

      expect(result).toEqual([]);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.tools.list = vi.fn().mockRejectedValue(new Error('dsh error'));
      const registry = new ToolRegistryImpl(ctx);

      await expect(registry.list()).rejects.toThrow(AdapterInternal);
    });
  });

  describe('interface stability', () => {
    it('implements the ToolRegistry interface', () => {
      const ctx = createMockDshContext();
      const registry: ToolRegistry = new ToolRegistryImpl(ctx);

      expect(typeof registry.register).toBe('function');
      expect(typeof registry.list).toBe('function');
    });

    it('does not expose the ctx property', () => {
      const ctx = createMockDshContext();
      const registry = new ToolRegistryImpl(ctx);

      expect(registry).not.toHaveProperty('ctx');
    });

    it('ToolCapability has cera types (name, description, parameters, handler)', () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const capability: ToolCapability = {
        name: 'remap_grid',
        description: 'Remap grid',
        parameters: { type: 'object', properties: {} },
        handler,
      };

      const keys = Object.keys(capability).sort();
      expect(keys).toEqual(['description', 'handler', 'name', 'parameters']);
    });

    it('list() returns ToolCapability[], not raw dsh type', async () => {
      const ctx = createMockDshContext();
      ctx.tools.list = vi.fn().mockResolvedValue([createMockToolCapability()]);
      const registry = new ToolRegistryImpl(ctx);

      const result = await registry.list();

      // Each item should have cera property names
      expect(result[0]).toHaveProperty('name');
      expect(result[0]).toHaveProperty('description');
      expect(result[0]).toHaveProperty('parameters');
      expect(result[0]).toHaveProperty('handler');
    });
  });
});
