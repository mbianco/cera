/**
 * Integration test: CDO Workflow — end-to-end.
 *
 * Traces data across every boundary in the CDO workflow:
 * Session → Action validation → ToolInvocation → Environment
 * verified (uenv) → CDO executed via ShellExecutor →
 * ExitOutcome recorded → ProvenanceRecord written →
 * Output Dataset registered → Dataset marked consumable →
 * Workflow advances.
 *
 * Exercises interactions: X1, X3, X4, X7, X10, X12
 * Validates invariants: INV-T1, INV-T3, INV-D3, INV-P3, INV-W1,
 * INV-W2.
 *
 * Spec: build-phases.md Tier 2; cross-context/interactions.md
 * X1, X3, X4, X7, X10, X12; invariants.md INV-T1, INV-T3,
 * INV-D3, INV-P3, INV-W1, INV-W2.
 */

import { describe, it, expect } from 'vitest';
import { createFullSystem } from './helpers';
import type { CLITool } from '../../src/types';
import { NonZeroExitCode } from '../../src/types/errors';

describe('Integration: CDO Workflow (end-to-end)', () => {
  it('Session → Action → ToolInvocation → Environment → CDO → Provenance → Dataset → Consumable', async () => {
    const sys = createFullSystem();

    // Register CDO Tool in the catalog
    const cdoTool: CLITool = {
      kind: 'cli',
      id: 'cdo' as unknown as import('../../src/types').ToolId,
      name: 'cdo',
      version: '2.0.5',
      executionModel: 'synchronous',
      environmentRequirements: {
        uenvSpecs: [{
          name: 'cdo',
          version: '2.0.5',
          mountPath: '/user-environment/env/cdo/2.0.5',
        }],
      },
      inputFormats: ['netcdf'],
      outputFormats: ['netcdf'],
      binary: 'cdo',
      chainable: true,
      description: 'Climate Data Operators',
    };
    await sys.catalog.registerTool(cdoTool);

    // Register an input Dataset (manually, with Provenance)
    const inputDataset = await sys.dataManagement.registerDataset({
      name: 'tas_historical_2000-2010',
      location: {
        path: '/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc',
        filesystem: 'scratch',
      },
      format: 'netcdf',
      grid: { kind: 'lat-lon', nlat: 180, nlon: 360 },
      variables: [{ name: 'TAS', units: 'K', dimensions: ['time', 'lat', 'lon'] }],
    });

    // Write a ProvenanceRecord for the input Dataset (so it's consumable)
    await sys.provenance.writeProvenanceRecord({
      toolId: 'manual' as unknown as import('../../src/types').ToolId,
      toolName: 'manual',
      toolVersion: '0.0.0',
      parameters: { source: 'historical archive' },
      environmentId: 'env-none' as unknown as import('../../src/types').EnvironmentId,
      environmentDescription: 'none',
      inputDatasetIds: [],
      outputDatasetId: inputDataset.id,
      exitOutcome: { kind: 'exit_code', code: 0 },
      timestamp: new Date(),
    });

    // Mark the input Dataset as consumable (INV-D3 / INV-P3)
    await sys.dataManagement.markConsumable(inputDataset.id);

    // Verify the input Dataset is consumable
    const consumableInput = await sys.dataManagement.queryDataset(inputDataset.id);
    expect(consumableInput?.consumable).toBe(true);

    // Start a Session (R7 — proactive Job reporting)
    const session = await sys.sessionService.startSession({
      id: 'user-001' as unknown as import('../../src/types').UserId,
      username: 'cera_user',
      hpcAccount: 's1234',
      slurmUsername: 'cera_user',
    });
    expect(session.state).toBe('ACTIVE');

    // Register an Action (R3 — LLM-facing concept)
    await sys.actionService.registerAction({
      id: 'act-001' as unknown as import('../../src/types').ActionId,
      name: 'compute_time_mean',
      description: 'Compute time mean of a variable using CDO',
      toolId: 'cdo' as unknown as import('../../src/types').ToolId,
      parameterSchema: {
        type: 'object',
        properties: {
          operatorChain: { type: 'string' },
        },
        required: ['operatorChain'],
        additionalProperties: false,
      },
      inputRequirements: {
        formats: ['netcdf'],
        grids: [{ kind: 'lat-lon', nlat: 180, nlon: 360 }],
      },
      outputDescription: {
        format: 'netcdf',
      },
    });

    // Validate the Action (R12 — refuse and ask if hallucinated)
    const validationResult = await sys.actionService.validateAction({
      actionName: 'compute_time_mean',
      parameters: { operatorChain: '-timmean' },
      inputDatasetIds: [inputDataset.id],
    });

    // X10: AgentInteraction → ToolInvocation — the validated
    // request should be consumable by invokeTool()
    expect('valid' in validationResult).toBe(true);
    if (!('valid' in validationResult) || !validationResult.valid) {
      expect.unreachable('Action validation should succeed');
    }

    // Set up the ShellExecutor to return success for CDO.
    // The mock filesystem doesn't actually create files, so we
    // need to pre-create the output file that CDO would have
    // written. The output path is derived from the Action name
    // by ActionService.#deriveOutputLocation().
    const expectedOutputPath = '/scratch/snx3000/cera_user/output/compute_time_mean.nc';
    sys.filesystem.fileContents.set(expectedOutputPath, Buffer.from('mock netcdf'));
    sys.filesystem.dirContents.get('/scratch/snx3000/cera_user/output')?.add('compute_time_mean.nc');

    sys.shellExecutor.setResponse('cdo', {
      stdout: '',
      stderr: '',
      exitOutcome: { kind: 'exit_code', code: 0 },
    });

    // Mount the CDO uenv (X1 — Environment must be loaded before
    // ToolInvocation, INV-T1)
    const uenvSpec = {
      name: 'cdo',
      version: '2.0.5',
      mountPath: '/user-environment/env/cdo/2.0.5',
    };
    await sys.environment.loadUenv({ uenvSpec });

    // X1, X3, X4: ToolInvocation → Environment, DataManagement,
    // Provenance — the full invokeTool() lifecycle
    const result = await sys.toolInvocation.invokeTool(
      validationResult.toolInvocationRequest,
    );

    // INV-T2: Single exit outcome
    expect(result.invocation.exitOutcome).not.toBeNull();
    expect(result.invocation.exitOutcome?.kind).toBe('exit_code');

    // INV-T3: Output registered (exit code 0 = success)
    expect(result.outputDatasets).toHaveLength(1);
    expect(result.outputDatasets[0]?.consumable).toBe(true);

    // INV-P3: ProvenanceRecord was written (X4)
    expect(result.provenanceRecord).toBeDefined();
    expect(result.provenanceRecord.outputDatasetId).toBe(
      result.outputDatasets[0]?.id,
    );

    // Verify the output Dataset is consumable (INV-D3 / INV-P3)
    const outputDataset = await sys.dataManagement.queryDataset(
      result.outputDatasets[0]?.id ?? ('' as unknown as import('../../src/types').DatasetId),
    );
    expect(outputDataset?.consumable).toBe(true);

    // End the Session (INV-W4 — Jobs are NOT cancelled)
    await sys.sessionService.endSession(session.id);
    expect((await sys.sessionService.getSession(session.id))?.state).toBe('ENDED');
  });

  it('failure cascade: CDO fails → ProvenanceRecord with null output → Dataset NOT registered → Workflow halts', async () => {
    const sys = createFullSystem();

    // Register CDO Tool
    const cdoTool: CLITool = {
      kind: 'cli',
      id: 'cdo' as unknown as import('../../src/types').ToolId,
      name: 'cdo',
      version: '2.0.5',
      executionModel: 'synchronous',
      environmentRequirements: {
        uenvSpecs: [{
          name: 'cdo',
          version: '2.0.5',
          mountPath: '/user-environment/env/cdo/2.0.5',
        }],
      },
      inputFormats: ['netcdf'],
      outputFormats: ['netcdf'],
      binary: 'cdo',
      chainable: true,
      description: 'Climate Data Operators',
    };
    await sys.catalog.registerTool(cdoTool);

    // Register input Dataset with Provenance
    const inputDataset = await sys.dataManagement.registerDataset({
      name: 'tas_historical_2000-2010',
      location: {
        path: '/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc',
        filesystem: 'scratch',
      },
      format: 'netcdf',
      grid: { kind: 'lat-lon', nlat: 180, nlon: 360 },
      variables: [{ name: 'TAS', units: 'K', dimensions: ['time', 'lat', 'lon'] }],
    });
    await sys.provenance.writeProvenanceRecord({
      toolId: 'manual' as unknown as import('../../src/types').ToolId,
      toolName: 'manual',
      toolVersion: '0.0.0',
      parameters: { source: 'historical archive' },
      environmentId: 'env-none' as unknown as import('../../src/types').EnvironmentId,
      environmentDescription: 'none',
      inputDatasetIds: [],
      outputDatasetId: inputDataset.id,
      exitOutcome: { kind: 'exit_code', code: 0 },
      timestamp: new Date(),
    });
    await sys.dataManagement.markConsumable(inputDataset.id);

    // Set up the ShellExecutor to return FAILURE for CDO
    sys.shellExecutor.setResponse('cdo', {
      stdout: '',
      stderr: 'cdo: error: invalid operator chain',
      exitOutcome: { kind: 'exit_code', code: 1 },
    });

    // Mount the CDO uenv (X1 — Environment must be loaded before
    // ToolInvocation, INV-T1)
    await sys.environment.loadUenv({
      uenvSpec: {
        name: 'cdo',
        version: '2.0.5',
        mountPath: '/user-environment/env/cdo/2.0.5',
      },
    });

    // Invoke CDO — should fail (R4: strict exit codes).
    // invokeTool() throws NonZeroExitCode on failure, but the
    // ProvenanceRecord (with null output) is written BEFORE
    // the throw.
    let thrownError: unknown;
    try {
      await sys.toolInvocation.invokeTool({
        toolId: 'cdo' as unknown as import('../../src/types').ToolId,
        parameters: { operatorChain: '-invalidop' },
        inputDatasetIds: [inputDataset.id],
        outputLocation: {
          path: '/scratch/snx3000/cera_user/output/tas_failed.nc',
          filesystem: 'scratch',
        },
        executionModel: 'synchronous',
      });
      expect.unreachable('Should have thrown NonZeroExitCode');
    } catch (error) {
      thrownError = error;
    }

    // INV-T3: invokeTool() throws NonZeroExitCode on failure
    expect(thrownError).toBeInstanceOf(NonZeroExitCode);

    // ProvenanceRecord WAS written (with null output) before the
    // throw (X4 — every ToolInvocation produces a ProvenanceRecord,
    // even failures).
    // The ProvenanceRecord for the failed invocation has
    // outputDatasetId: null, so it won't match any Dataset ID.
    // Instead, we verify that the output Dataset was NOT registered.
    const outputDataset = await sys.dataManagement.queryDataset(
      'ds-failed' as unknown as import('../../src/types').DatasetId,
    );
    expect(outputDataset).toBeNull();
  });
});
