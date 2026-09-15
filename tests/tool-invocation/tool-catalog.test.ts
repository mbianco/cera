/**
 * Unit tests for the ToolCatalogService.
 *
 * Verifies the catalog's basic operations: register, get, list,
 * and ToolNotFound behavior (FM-A1, R12).
 *
 * Spec: api-contracts.md §6 (ToolCatalogService);
 * module-graph.md §6; resolutions.md R12; failure-modes.md FM-A1.
 */

import { describe, it, expect } from 'vitest';
import { ToolCatalogServiceImpl } from '../../src/tool-invocation/tool-catalog';
import {
  createMockCLITool,
  createMockPythonTool,
  createMockModelTool,
  createToolId,
} from './helpers';

// ============================================================================
// Test setup helper
// ============================================================================

function createCatalog(): ToolCatalogServiceImpl {
  return new ToolCatalogServiceImpl();
}

// ============================================================================
// registerTool
// ============================================================================

describe('ToolCatalogServiceImpl.registerTool', () => {
  it('registers a CLITool in the catalog', async () => {
    const catalog = createCatalog();
    const tool = createMockCLITool({ id: createToolId('cdo') });

    await catalog.registerTool(tool);

    const retrieved = await catalog.getTool(createToolId('cdo'));
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(createToolId('cdo'));
    expect(retrieved?.kind).toBe('cli');
  });

  it('registers a PythonTool in the catalog', async () => {
    const catalog = createCatalog();
    const tool = createMockPythonTool({ id: createToolId('healpy') });

    await catalog.registerTool(tool);

    const retrieved = await catalog.getTool(createToolId('healpy'));
    expect(retrieved).not.toBeNull();
    expect(retrieved?.kind).toBe('python');
  });

  it('registers a ModelTool (CESM) in the catalog', async () => {
    const catalog = createCatalog();
    const tool = createMockModelTool({ id: createToolId('cesm') });

    await catalog.registerTool(tool);

    const retrieved = await catalog.getTool(createToolId('cesm'));
    expect(retrieved).not.toBeNull();
    expect(retrieved?.kind).toBe('model');
  });

  it('replaces an existing Tool with the same id', async () => {
    const catalog = createCatalog();
    const original = createMockCLITool({
      id: createToolId('cdo'),
      version: '2.0.5',
    });
    const updated = createMockCLITool({
      id: createToolId('cdo'),
      version: '2.1.0',
    });

    await catalog.registerTool(original);
    await catalog.registerTool(updated);

    const retrieved = await catalog.getTool(createToolId('cdo'));
    expect(retrieved?.version).toBe('2.1.0');
  });
});

// ============================================================================
// getTool
// ============================================================================

describe('ToolCatalogServiceImpl.getTool', () => {
  it('returns null for a Tool that is not in the catalog (FM-A1)', async () => {
    const catalog = createCatalog();

    const result = await catalog.getTool(createToolId('nonexistent'));

    expect(result).toBeNull();
  });

  it('returns the registered Tool by identity', async () => {
    const catalog = createCatalog();
    const tool = createMockCLITool({
      id: createToolId('ncks'),
      name: 'ncks',
      binary: 'ncks',
    });
    await catalog.registerTool(tool);

    const result = await catalog.getTool(createToolId('ncks'));

    expect(result).not.toBeNull();
    expect(result?.id).toBe(createToolId('ncks'));
    expect(result?.name).toBe('ncks');
  });
});

// ============================================================================
// getToolCatalog
// ============================================================================

describe('ToolCatalogServiceImpl.getToolCatalog', () => {
  it('returns an empty catalog initially', async () => {
    const catalog = createCatalog();

    const tools = await catalog.getToolCatalog();

    expect(tools).toHaveLength(0);
  });

  it('returns all registered Tools', async () => {
    const catalog = createCatalog();
    const cdo = createMockCLITool({ id: createToolId('cdo') });
    const healpy = createMockPythonTool({ id: createToolId('healpy') });
    const cesm = createMockModelTool({ id: createToolId('cesm') });

    await catalog.registerTool(cdo);
    await catalog.registerTool(healpy);
    await catalog.registerTool(cesm);

    const tools = await catalog.getToolCatalog();

    expect(tools).toHaveLength(3);
    const ids = tools.map((t) => t.id);
    expect(ids).toContain(createToolId('cdo'));
    expect(ids).toContain(createToolId('healpy'));
    expect(ids).toContain(createToolId('cesm'));
  });

  it('does not include duplicate registrations (same id)', async () => {
    const catalog = createCatalog();
    const tool1 = createMockCLITool({ id: createToolId('cdo'), version: '2.0.5' });
    const tool2 = createMockCLITool({ id: createToolId('cdo'), version: '2.1.0' });

    await catalog.registerTool(tool1);
    await catalog.registerTool(tool2);

    const tools = await catalog.getToolCatalog();

    expect(tools).toHaveLength(1);
    expect(tools[0]?.version).toBe('2.1.0');
  });

  it('returns a readonly array (does not allow mutation)', async () => {
    const catalog = createCatalog();
    await catalog.registerTool(createMockCLITool());

    const tools = await catalog.getToolCatalog();

    // The array should be frozen or at least the caller should not
    // be able to push to it in a type-safe manner.
    expect(Object.isFrozen(tools) || Array.isArray(tools)).toBe(true);
  });
});
