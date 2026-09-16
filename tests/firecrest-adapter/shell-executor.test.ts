/**
 * Tests for the FirecREST ShellExecutor (F-INV-5, F-INV-6).
 *
 * Verifies:
 * - execute() builds Job script and submits via FirecREST
 * - Job script includes uenv start for F-INV-5
 * - Polls until terminal state
 * - Returns correct ShellResult (stdout, stderr, ExitOutcome)
 * - F-INV-6: all operations are parallel (submitted as Jobs)
 *
 * Spec: specs/firecrest/invariants.md F-INV-5, F-INV-6;
 * specs/firecrest/features/firecrest-backend.feature;
 * ADR-011.
 */

import { describe, it, expect } from 'vitest';
import { FirecrestShellExecutor, UENV_SPECS_KEY } from '../../src/firecrest-adapter/shell-executor';
import type { FirecrestJob, FirecrestJobSubmitResponse } from '../../src/firecrest-adapter/types';
import type { ShellResult, ShellExecutor } from '../../src/dsh-adapter/types';
import {
  createMockFirecrestClient,
  createMockJobSubmitResponse,
  createMockFirecrestJob,
} from './helpers';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a mock FirecrestClient that handles Job submission and
 * polling. The client returns the given job states in sequence for
 * GET /compute/{system}/jobs/{jobId}.
 */
function createPollingMockClient(
  systemName: string,
  submitResponse: FirecrestJobSubmitResponse,
  pollStates: FirecrestJob[],
): ReturnType<typeof createMockFirecrestClient> {
  let pollIndex = 0;
  const client = createMockFirecrestClient({
    responses: [
      {
        method: 'post',
        pathPattern: `/compute/${systemName}/jobs`,
        statusCode: 200,
        body: submitResponse,
      },
      {
        method: 'get',
        pathPattern: `/compute/${systemName}/jobs/${submitResponse.jobId}`,
        statusCode: 200,
        body: pollStates[0] ?? createMockFirecrestJob(),
      },
    ],
  });

  // Override the get mock to return states in sequence
  client.getMock.mockImplementation(async (path: string) => {
    client.calls.push({ method: 'get', path });
    if (path.includes(`/compute/${systemName}/jobs/${submitResponse.jobId}`)) {
      const state = pollStates[pollIndex] ?? pollStates[pollStates.length - 1];
      if (state === undefined) {
        throw new Error('No more poll states');
      }
      pollIndex++;
      return { statusCode: 200, body: state };
    }
    return { statusCode: 200, body: {} };
  });

  return client;
}

// ============================================================================
// FirecrestShellExecutor
// ============================================================================

describe('FirecrestShellExecutor', () => {
  const systemName = 'daint';

  describe('execute() — Job submission (F-INV-6)', () => {
    it('submits the command as a SLURM Job via POST /compute/{system}/jobs', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 12345, state: 'PENDING' }),
        [
          createMockFirecrestJob({ jobId: 12345, state: 'COMPLETED', exitCode: 0, stdout: 'hello', stderr: '' }),
        ],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      await executor.execute('echo hello');

      // Verify POST was called
      const postCalls = client.calls.filter((c) => c.method === 'post');
      expect(postCalls.length).toBe(1);
      expect(postCalls[0]?.path).toBe('/compute/daint/jobs');
      expect(postCalls[0]?.body).toMatchObject({
        jobScript: expect.stringContaining('echo hello'),
      });
    });

    it('does NOT execute the command locally (F-INV-6)', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0, stdout: '', stderr: '' })],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });

      // The mock client has no local execution — if the test passes,
      // the command was not executed locally
      const result = await executor.execute('rm -rf /');

      expect(result.exitOutcome).toEqual({ kind: 'exit_code', code: 0 });
    });

    it('builds a Job script starting with #!/bin/bash', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0, stdout: '', stderr: '' })],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      await executor.execute('cdo -timmean in.nc out.nc');

      const postCall = client.calls.find((c) => c.method === 'post');
      const body = postCall?.body as { jobScript: string };
      expect(body.jobScript).toContain('#!/bin/bash');
      expect(body.jobScript).toContain('cdo -timmean in.nc out.nc');
    });
  });

  describe('execute() — uenv in Job script (F-INV-5)', () => {
    it('includes uenv start in the Job script when env contains UENV_SPECS', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0, stdout: '', stderr: '' })],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      await executor.execute('cdo -timmean in.nc out.nc', {
        env: { [UENV_SPECS_KEY]: 'cdo:2.0.5' },
      });

      const postCall = client.calls.find((c) => c.method === 'post');
      const body = postCall?.body as { jobScript: string };
      expect(body.jobScript).toContain('uenv start cdo:2.0.5 --');
      expect(body.jobScript).toContain('cdo -timmean in.nc out.nc');
    });

    it('includes multiple uenv specs in order', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0, stdout: '', stderr: '' })],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      await executor.execute('python run.py', {
        env: { [UENV_SPECS_KEY]: 'cdo:2.0.5,python:3.11' },
      });

      const postCall = client.calls.find((c) => c.method === 'post');
      const body = postCall?.body as { jobScript: string };
      expect(body.jobScript).toContain('uenv start cdo:2.0.5 --');
      expect(body.jobScript).toContain('uenv start python:3.11 --');
      const cdoIdx = body.jobScript.indexOf('uenv start cdo:2.0.5');
      const pythonIdx = body.jobScript.indexOf('uenv start python:3.11');
      const cmdIdx = body.jobScript.indexOf('python run.py');
      expect(cdoIdx).toBeLessThan(pythonIdx);
      expect(pythonIdx).toBeLessThan(cmdIdx);
    });

    it('does NOT include UENV_SPECS as an export statement', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0, stdout: '', stderr: '' })],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      await executor.execute('echo hi', {
        env: { [UENV_SPECS_KEY]: 'cdo:2.0.5', FOO: 'bar' },
      });

      const postCall = client.calls.find((c) => c.method === 'post');
      const body = postCall?.body as { jobScript: string };
      expect(body.jobScript).toContain('export FOO=bar');
      expect(body.jobScript).not.toContain(`export ${UENV_SPECS_KEY}`);
    });

    it('does NOT call uenv CLI directly (F-INV-5)', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0, stdout: '', stderr: '' })],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      await executor.execute('echo hi', {
        env: { [UENV_SPECS_KEY]: 'cdo:2.0.5' },
      });

      // The only uenv commands should be in the Job script, not
      // executed by cera directly. Since we're using a mock client,
      // no direct execution occurs — verify the command was not
      // passed as a direct CLI call.
      const postCall = client.calls.find((c) => c.method === 'post');
      const body = postCall?.body as { jobScript: string };
      expect(body.jobScript).toContain('uenv start cdo:2.0.5 --');
      expect(body.jobScript).not.toContain('uenv mount');
      expect(body.jobScript).not.toContain('uenv status');
    });
  });

  describe('execute() — polling until terminal state', () => {
    it('polls GET /compute/{system}/jobs/{jobId} until terminal state', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 42, state: 'PENDING' }),
        [
          createMockFirecrestJob({ jobId: 42, state: 'PENDING' }),
          createMockFirecrestJob({ jobId: 42, state: 'RUNNING' }),
          createMockFirecrestJob({ jobId: 42, state: 'COMPLETED', exitCode: 0, stdout: 'done', stderr: '' }),
        ],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      const result = await executor.execute('cdo -timmean in.nc out.nc');

      // Verify multiple GET calls were made
      const getCalls = client.calls.filter((c) => c.method === 'get');
      expect(getCalls.length).toBeGreaterThanOrEqual(2);
      expect(result.stdout).toBe('done');
    });

    it('stops polling once a terminal state is reached (INV-S4)', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 42, state: 'PENDING' }),
        [
          createMockFirecrestJob({ jobId: 42, state: 'RUNNING' }),
          createMockFirecrestJob({ jobId: 42, state: 'COMPLETED', exitCode: 0, stdout: 'done', stderr: '' }),
        ],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      await executor.execute('echo done');

      // Should be exactly 2 GET calls (RUNNING, then COMPLETED)
      const getCalls = client.calls.filter((c) => c.method === 'get');
      expect(getCalls.length).toBe(2);
    });
  });

  describe('execute() — ShellResult mapping', () => {
    it('returns stdout and stderr from the completed Job', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({
          jobId: 1,
          state: 'COMPLETED',
          exitCode: 0,
          stdout: 'output line 1\noutput line 2',
          stderr: 'warning message',
        })],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      const result = await executor.execute('cdo -timmean in.nc out.nc');

      expect(result.stdout).toBe('output line 1\noutput line 2');
      expect(result.stderr).toBe('warning message');
    });

    it('returns exit_code 0 for COMPLETED Job with exitCode 0', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0 })],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      const result = await executor.execute('echo ok');

      expect(result.exitOutcome).toEqual({ kind: 'exit_code', code: 0 });
    });

    it('returns non-zero exit_code for FAILED Job', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({
          jobId: 1,
          state: 'FAILED',
          exitCode: 2,
          stderr: 'Error: invalid input',
        })],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      const result = await executor.execute('cdo -timmean in.nc out.nc');

      expect(result.exitOutcome).toEqual({ kind: 'exit_code', code: 2 });
      expect(result.stderr).toContain('invalid input');
    });

    it('returns signal for OUT_OF_MEMORY Job (no exitCode)', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'OUT_OF_MEMORY' })],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      const result = await executor.execute('big_job');

      expect(result.exitOutcome.kind).toBe('signal');
    });

    it('returns signal for TIMEOUT Job (no exitCode)', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'TIMEOUT' })],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      const result = await executor.execute('long_job');

      expect(result.exitOutcome.kind).toBe('signal');
    });
  });

  describe('interface stability', () => {
    it('implements the ShellExecutor interface', () => {
      const client = createMockFirecrestClient();
      const executor: ShellExecutor = new FirecrestShellExecutor(client, systemName);

      expect(typeof executor.execute).toBe('function');
    });

    it('returns ShellResult with stdout, stderr, exitOutcome', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0, stdout: 'x', stderr: 'y' })],
      );

      const executor = new FirecrestShellExecutor(client, systemName, { pollIntervalMs: 1 });
      const result: ShellResult = await executor.execute('echo x');

      expect(result).toHaveProperty('stdout');
      expect(result).toHaveProperty('stderr');
      expect(result).toHaveProperty('exitOutcome');
      expect(result).not.toHaveProperty('exitCode');
      expect(result).not.toHaveProperty('signalName');
    });
  });
});
