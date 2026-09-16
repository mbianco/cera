/**
 * Unit tests for ActionServiceImpl.
 *
 * Covers R12 (refuse and ask), ADR-010, FM-A1 (hallucinated Tool
 * name), FM-A2 (hallucinated parameters), and valid requests.
 *
 * Spec: api-contracts.md §7 (ActionService); resolutions.md R3, R12;
 * failure-modes.md FM-A1, FM-A2; ADR-010.
 */

import { describe, it, expect } from 'vitest';
import { ActionServiceImpl } from '../../src/agent-interaction/action-service';
import type { Action, Dataset, DatasetId, Tool, ToolId } from '../../src/types';
import type { ToolCatalogService } from '../../src/tool-invocation/types';
import type { DataManagementService } from '../../src/data-management/types';

// ============================================================================
// Helpers
// ============================================================================

function createMockToolCatalog(overrides: {
  tools?: readonly { id: ToolId; name: string; executionModel: 'synchronous' | 'parallel' }[];
} = {}): ToolCatalogService & {
  getToolCalls: ToolId[];
} {
  const tools = overrides.tools ?? [
    { id: 'cdo' as ToolId, name: 'cdo', executionModel: 'synchronous' as const },
    { id: 'ncks' as ToolId, name: 'ncks', executionModel: 'synchronous' as const },
  ];
  const getToolCalls: ToolId[] = [];

  return {
    async registerTool(): Promise<void> {},
    async getTool(id: ToolId): Promise<Tool | null> {
      getToolCalls.push(id);
      const found = tools.find((t) => t.id === id);
      if (found === undefined) return null;
      return {
        kind: 'cli',
        id: found.id,
        name: found.name,
        version: '1.0.0',
        executionModel: found.executionModel,
        environmentRequirements: { uenvSpecs: [] },
        inputFormats: ['netcdf'],
        outputFormats: ['netcdf'],
        binary: found.name,
        chainable: false,
        description: 'mock tool',
      } as unknown as Tool;
    },
    async getToolCatalog() {
      return tools as unknown as Awaited<ReturnType<ToolCatalogService['getToolCatalog']>>;
    },
    getToolCalls,
  };
}

function createMockDataManagement(overrides: {
  datasets?: ReadonlyMap<string, Dataset>;
} = {}): DataManagementService {
  const datasets = overrides.datasets ?? new Map<string, Dataset>();

  return {
    async registerDataset() {
      throw new Error('not implemented in mock');
    },
    async queryDataset(id: DatasetId): Promise<Dataset | null> {
      return datasets.get(id as string) ?? null;
    },
    async listDatasets() {
      return Array.from(datasets.values());
    },
    async validateLocation(): Promise<boolean> {
      return true;
    },
    async markConsumable(): Promise<void> {},
    async quarantineDataset(): Promise<void> {},
  } as unknown as DataManagementService;
}

function createMockAction(overrides: {
  name?: string;
  toolId?: ToolId;
  parameterSchema?: Record<string, unknown>;
  inputRequirements?: {
    formats: readonly string[];
    grids: readonly { kind: string }[];
    variables?: readonly string[];
  };
} = {}): Action {
  return {
    id: 'act-001' as unknown as Action['id'],
    name: overrides.name ?? 'compute_time_mean',
    description: 'Compute time mean of a variable',
    toolId: overrides.toolId ?? ('cdo' as ToolId),
    parameterSchema: overrides.parameterSchema ?? {
      type: 'object',
      properties: {
        operator: { type: 'string' },
        variable: { type: 'string' },
      },
      required: ['operator', 'variable'],
      additionalProperties: false,
    },
    inputRequirements: overrides.inputRequirements ?? {
      formats: ['netcdf'],
      grids: [{ kind: 'lat-lon' }],
    },
    outputDescription: {
      format: 'netcdf',
    },
  } as unknown as Action;
}

function createMockDataset(overrides: {
  id?: string;
  name?: string;
  format?: string;
  gridKind?: string;
  variables?: readonly string[];
} = {}): Dataset {
  return {
    id: (overrides.id ?? 'ds-001') as unknown as DatasetId,
    name: overrides.name ?? 'tas_historical',
    location: { path: '/scratch/data.nc', filesystem: 'scratch' },
    format: overrides.format ?? 'netcdf',
    grid: { kind: overrides.gridKind ?? 'lat-lon' },
    variables: (overrides.variables ?? ['TAS']).map((name) => ({
      name,
      units: 'K',
      dimensions: ['time', 'lat', 'lon'],
    })),
    producerToolInvocationId: null,
    consumable: true,
    quarantined: false,
    createdAt: new Date('2026-09-15T10:00:00Z'),
  } as unknown as Dataset;
}

// ============================================================================
// Tests
// ============================================================================

describe('ActionServiceImpl', () => {
  // ========================================================================
  // registerAction / listActions (R3)
  // ========================================================================

  describe('registerAction / listActions (R3)', () => {
    it('registers an Action and lists it', async () => {
      const catalog = createMockToolCatalog();
      const dataManagement = createMockDataManagement();
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(createMockAction({ name: 'compute_time_mean' }));

      const actions = await service.listActions();
      expect(actions).toHaveLength(1);
      expect(actions[0]?.name).toBe('compute_time_mean');
    });

    it('replaces an Action with the same name', async () => {
      const catalog = createMockToolCatalog();
      const dataManagement = createMockDataManagement();
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(createMockAction({ name: 'select_variable', toolId: 'cdo' as ToolId }));
      await service.registerAction(createMockAction({ name: 'select_variable', toolId: 'ncks' as ToolId }));

      const actions = await service.listActions();
      expect(actions).toHaveLength(1);
      expect(actions[0]?.toolId).toBe('ncks' as ToolId);
    });

    it('returns empty array when no Actions registered', async () => {
      const catalog = createMockToolCatalog();
      const dataManagement = createMockDataManagement();
      const service = new ActionServiceImpl({ catalog, dataManagement });

      const actions = await service.listActions();
      expect(actions).toEqual([]);
    });
  });

  // ========================================================================
  // FM-A1: LLM hallucinates Tool name (refuse and ask)
  // ========================================================================

  describe('FM-A1: hallucinated Tool name (refuse and ask)', () => {
    it('returns refuseAndAsk when Action is not registered', async () => {
      const catalog = createMockToolCatalog();
      const dataManagement = createMockDataManagement();
      const service = new ActionServiceImpl({ catalog, dataManagement });

      const result = await service.validateAction({
        actionName: 'nonexistent_action',
        parameters: { operator: 'timmean' },
        inputDatasetIds: [],
      });

      expect(result).toEqual({
        refuseAndAsk: true,
        message: expect.stringContaining('nonexistent_action'),
        availableTools: expect.any(Array),
      });
    });

    it('returns refuseAndAsk when Action is registered but Tool is not in catalog', async () => {
      const catalog = createMockToolCatalog({
        tools: [{ id: 'cdo' as ToolId, name: 'cdo', executionModel: 'synchronous' }],
      });
      const dataManagement = createMockDataManagement();
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(
        createMockAction({ name: 'bad_action', toolId: 'nonexistent_tool' as ToolId }),
      );

      const result = await service.validateAction({
        actionName: 'bad_action',
        parameters: { operator: 'timmean', variable: 'TAS' },
        inputDatasetIds: [],
      });

      expect(result).toEqual({
        refuseAndAsk: true,
        message: expect.stringContaining('nonexistent_tool'),
        availableTools: expect.arrayContaining(['cdo' as ToolId]),
      });
    });

    it('includes available ToolIds in refuseAndAsk result', async () => {
      const catalog = createMockToolCatalog({
        tools: [
          { id: 'cdo' as ToolId, name: 'cdo', executionModel: 'synchronous' },
          { id: 'ncks' as ToolId, name: 'ncks', executionModel: 'synchronous' },
        ],
      });
      const dataManagement = createMockDataManagement();
      const service = new ActionServiceImpl({ catalog, dataManagement });

      const result = await service.validateAction({
        actionName: 'nonexistent',
        parameters: {},
        inputDatasetIds: [],
      });

      if ('refuseAndAsk' in result && result.refuseAndAsk) {
        expect(result.availableTools).toHaveLength(2);
        expect(result.availableTools).toContain('cdo' as ToolId);
        expect(result.availableTools).toContain('ncks' as ToolId);
      } else {
        expect.unreachable('Expected refuseAndAsk result');
      }
    });
  });

  // ========================================================================
  // FM-A2: LLM hallucinates parameters (refuse and ask)
  // ========================================================================

  describe('FM-A2: hallucinated parameters (refuse and ask)', () => {
    it('returns invalid when required parameter is missing', async () => {
      const catalog = createMockToolCatalog();
      const dataManagement = createMockDataManagement();
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(createMockAction());

      const result = await service.validateAction({
        actionName: 'compute_time_mean',
        parameters: { operator: 'timmean' }, // missing 'variable'
        inputDatasetIds: [],
      });

      expect(result).toEqual({
        valid: false,
        reason: expect.stringContaining('variable'),
        suggestion: expect.any(String),
      });
    });

    it('returns invalid when parameter type is wrong', async () => {
      const catalog = createMockToolCatalog();
      const dataManagement = createMockDataManagement();
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(createMockAction());

      const result = await service.validateAction({
        actionName: 'compute_time_mean',
        parameters: { operator: 'timmean', variable: 42 }, // number instead of string
        inputDatasetIds: [],
      });

      expect(result).toEqual({
        valid: false,
        reason: expect.stringContaining('string'),
        suggestion: expect.any(String),
      });
    });

    it('returns invalid when unexpected parameter is present (additionalProperties: false)', async () => {
      const catalog = createMockToolCatalog();
      const dataManagement = createMockDataManagement();
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(createMockAction());

      const result = await service.validateAction({
        actionName: 'compute_time_mean',
        parameters: { operator: 'timmean', variable: 'TAS', extra: 'bad' },
        inputDatasetIds: [],
      });

      expect(result).toEqual({
        valid: false,
        reason: expect.stringContaining('extra'),
        suggestion: expect.any(String),
      });
    });

    it('returns invalid when input Dataset does not exist', async () => {
      const catalog = createMockToolCatalog();
      const dataManagement = createMockDataManagement({ datasets: new Map() });
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(createMockAction());

      const result = await service.validateAction({
        actionName: 'compute_time_mean',
        parameters: { operator: 'timmean', variable: 'TAS' },
        inputDatasetIds: ['nonexistent' as unknown as DatasetId],
      });

      expect(result).toEqual({
        valid: false,
        reason: expect.stringContaining('does not exist'),
        suggestion: expect.any(String),
      });
    });

    it('returns invalid when input Dataset format is not supported', async () => {
      const catalog = createMockToolCatalog();
      const dataManagement = createMockDataManagement({
        datasets: new Map([
          ['ds-001', createMockDataset({ id: 'ds-001', format: 'grib2' })],
        ]),
      });
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(
        createMockAction({
          inputRequirements: {
            formats: ['netcdf'],
            grids: [{ kind: 'lat-lon' }],
          },
        }),
      );

      const result = await service.validateAction({
        actionName: 'compute_time_mean',
        parameters: { operator: 'timmean', variable: 'TAS' },
        inputDatasetIds: ['ds-001' as unknown as DatasetId],
      });

      expect(result).toEqual({
        valid: false,
        reason: expect.stringContaining('grib2'),
        suggestion: expect.any(String),
      });
    });

    it('returns invalid when input Dataset grid kind is not supported', async () => {
      const catalog = createMockToolCatalog();
      const dataManagement = createMockDataManagement({
        datasets: new Map([
          ['ds-001', createMockDataset({ id: 'ds-001', gridKind: 'icon' })],
        ]),
      });
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(
        createMockAction({
          inputRequirements: {
            formats: ['netcdf'],
            grids: [{ kind: 'lat-lon' }],
          },
        }),
      );

      const result = await service.validateAction({
        actionName: 'compute_time_mean',
        parameters: { operator: 'timmean', variable: 'TAS' },
        inputDatasetIds: ['ds-001' as unknown as DatasetId],
      });

      expect(result).toEqual({
        valid: false,
        reason: expect.stringContaining('icon'),
        suggestion: expect.any(String),
      });
    });

    it('returns invalid when input Dataset is missing a required variable', async () => {
      const catalog = createMockToolCatalog();
      const dataManagement = createMockDataManagement({
        datasets: new Map([
          ['ds-001', createMockDataset({ id: 'ds-001', variables: ['PR'] })],
        ]),
      });
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(
        createMockAction({
          inputRequirements: {
            formats: ['netcdf'],
            grids: [{ kind: 'lat-lon' }],
            variables: ['TAS'],
          },
        }),
      );

      const result = await service.validateAction({
        actionName: 'compute_time_mean',
        parameters: { operator: 'timmean', variable: 'TAS' },
        inputDatasetIds: ['ds-001' as unknown as DatasetId],
      });

      expect(result).toEqual({
        valid: false,
        reason: expect.stringContaining('TAS'),
        suggestion: expect.any(String),
      });
    });
  });

  // ========================================================================
  // Valid requests
  // ========================================================================

  describe('valid requests', () => {
    it('returns valid with toolInvocationRequest when all checks pass', async () => {
      const catalog = createMockToolCatalog({
        tools: [{ id: 'cdo' as ToolId, name: 'cdo', executionModel: 'synchronous' }],
      });
      const dataManagement = createMockDataManagement({
        datasets: new Map([
          ['ds-001', createMockDataset({ id: 'ds-001', variables: ['TAS'] })],
        ]),
      });
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(createMockAction());

      const result = await service.validateAction({
        actionName: 'compute_time_mean',
        parameters: { operator: 'timmean', variable: 'TAS' },
        inputDatasetIds: ['ds-001' as unknown as DatasetId],
      });

      expect(result).toEqual({
        valid: true,
        toolInvocationRequest: expect.objectContaining({
          toolId: 'cdo' as ToolId,
          parameters: { operator: 'timmean', variable: 'TAS' },
          inputDatasetIds: ['ds-001' as unknown as DatasetId],
          executionModel: 'synchronous',
        }),
      });
    });

    it('derives output location from action name', async () => {
      const catalog = createMockToolCatalog({
        tools: [{ id: 'cdo' as ToolId, name: 'cdo', executionModel: 'synchronous' }],
      });
      const dataManagement = createMockDataManagement({
        datasets: new Map([
          ['ds-001', createMockDataset({ id: 'ds-001' })],
        ]),
      });
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(createMockAction({ name: 'remap_grid' }));

      const result = await service.validateAction({
        actionName: 'remap_grid',
        parameters: { operator: 'remapcon2', variable: 'TAS' },
        inputDatasetIds: ['ds-001' as unknown as DatasetId],
      });

      if ('valid' in result && result.valid) {
        expect(result.toolInvocationRequest.outputLocation.path).toContain('remap_grid');
      } else {
        expect.unreachable('Expected valid result');
      }
    });

    it('passes execution model from the catalog Tool', async () => {
      const catalog = createMockToolCatalog({
        tools: [{ id: 'cdo' as ToolId, name: 'cdo', executionModel: 'parallel' }],
      });
      const dataManagement = createMockDataManagement({
        datasets: new Map([
          ['ds-001', createMockDataset({ id: 'ds-001' })],
        ]),
      });
      const service = new ActionServiceImpl({ catalog, dataManagement });

      await service.registerAction(createMockAction());

      const result = await service.validateAction({
        actionName: 'compute_time_mean',
        parameters: { operator: 'timmean', variable: 'TAS' },
        inputDatasetIds: ['ds-001' as unknown as DatasetId],
      });

      if ('valid' in result && result.valid) {
        expect(result.toolInvocationRequest.executionModel).toBe('parallel');
      } else {
        expect.unreachable('Expected valid result');
      }
    });
  });
});
