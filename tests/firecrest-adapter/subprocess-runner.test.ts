/**
 * Tests for the FirecREST SubprocessRunner (F-INV-6).
 *
 * Verifies:
 * - execute() builds command from command + args and submits via FirecREST
 * - spawn() returns a SubprocessHandle wrapping the FirecREST Job
 * - pid is the FirecREST Job ID
 * - stdout/stderr async iterables emit Job output on terminal state
 * - kill() cancels the Job via DELETE /compute/{system}/jobs/{jobId}
 * - wait() polls until terminal and returns ShellResult
 * - F-INV-6: all operations are parallel
 *
 * Spec: specs/firecrest/invariants.md F-INV-5, F-INV-6;
 * specs/firecrest/features/firecrest-backend.feature;
 * ADR-011.
 */

import { describe, it, expect } from 'vitest';
import { FirecrestSubprocessRunner, UENV_SPECS_KEY } from '../../src/firecrest-adapter/subprocess-runner';
import type { FirecrestJob, FirecrestJobSubmitResponse } from '../../src/firecrest-adapter/types';
import type { SubprocessRunner, SubprocessHandle, ShellResult } from '../../src/dsh-adapter/types';
import {
  createMockFirecrestClient,
  createMockJobSubmitResponse,
  createMockFirecrestJob,
} from './helpers';

// ============================================================================
// Helpers (same pattern as shell-executor tests)
// ============================================================================

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
        method: 'delete',
        pathPattern: `/compute/${systemName}/jobs/${submitResponse.jobId}`,
        statusCode: 200,
        body: {},
      },
    ],
  });

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
// FirecrestSubprocessRunner
// ============================================================================

const systemName = 'daint';

describe('FirecrestSubprocessRunner', () => {
  describe('execute() — Job submission (F-INV-6)', () => {
    it('builds command from command + args.join(" ")', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0, stdout: '', stderr: '' })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      await runner.execute('cdo', ['-timmean', 'in.nc', 'out.nc']);

      const postCall = client.calls.find((c) => c.method === 'post');
      const body = postCall?.body as { jobScript: string };
      expect(body.jobScript).toContain('cdo -timmean in.nc out.nc');
    });

    it('submits via POST /compute/{system}/jobs', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0, stdout: '', stderr: '' })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      await runner.execute('echo', ['hello']);

      const postCall = client.calls.find((c) => c.method === 'post');
      expect(postCall?.path).toBe('/compute/daint/jobs');
    });

    it('returns ShellResult with correct stdout, stderr, exitOutcome', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({
          jobId: 1,
          state: 'COMPLETED',
          exitCode: 0,
          stdout: 'hello world',
          stderr: '',
        })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      const result = await runner.execute('echo', ['hello world']);

      expect(result.stdout).toBe('hello world');
      expect(result.stderr).toBe('');
      expect(result.exitOutcome).toEqual({ kind: 'exit_code', code: 0 });
    });

    it('includes uenv start when env contains UENV_SPECS (F-INV-5)', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0, stdout: '', stderr: '' })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      await runner.execute('cdo', ['-timmean', 'in.nc', 'out.nc'], {
        env: { [UENV_SPECS_KEY]: 'cdo:2.0.5' },
      });

      const postCall = client.calls.find((c) => c.method === 'post');
      const body = postCall?.body as { jobScript: string };
      expect(body.jobScript).toContain('uenv start cdo:2.0.5 --');
    });
  });

  describe('spawn() — SubprocessHandle (F-INV-6)', () => {
    it('returns a SubprocessHandle with pid = FirecREST Job ID', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 99999, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 99999, state: 'COMPLETED', exitCode: 0 })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      const handle = runner.spawn('cdo', ['-timmean', 'in.nc', 'out.nc']);
      // The POST is async — wait for the Job to complete (which
      // implies the POST completed and the pid is available)
      await handle.wait();
      expect(handle.pid).toBe(99999);
    });

    it('submits the Job immediately on spawn', () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 42, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 42, state: 'COMPLETED', exitCode: 0 })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      runner.spawn('echo', ['hi']);

      const postCall = client.calls.find((c) => c.method === 'post');
      expect(postCall).toBeDefined();
    });

    it('stdout is an AsyncIterable', () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0, stdout: 'x' })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      const handle = runner.spawn('echo', ['x']);

      expect(typeof (handle.stdout as AsyncIterable<string>)[Symbol.asyncIterator]).toBe('function');
    });

    it('stderr is an AsyncIterable', () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0 })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      const handle = runner.spawn('echo', ['x']);

      expect(typeof (handle.stderr as AsyncIterable<string>)[Symbol.asyncIterator]).toBe('function');
    });

    it('stdout emits Job output on terminal state', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({
          jobId: 1,
          state: 'COMPLETED',
          exitCode: 0,
          stdout: 'line1\nline2',
        })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      const handle = runner.spawn('echo', ['multi']);

      const chunks: string[] = [];
      for await (const chunk of handle.stdout) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe('line1\nline2');
    });

    it('stderr emits Job stderr on terminal state', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({
          jobId: 1,
          state: 'FAILED',
          exitCode: 1,
          stderr: 'error occurred',
        })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      const handle = runner.spawn('failing', ['cmd']);

      const chunks: string[] = [];
      for await (const chunk of handle.stderr) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe('error occurred');
    });

    it('wait() polls until terminal and returns ShellResult', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [
          createMockFirecrestJob({ jobId: 1, state: 'RUNNING' }),
          createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0, stdout: 'done' }),
        ],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      const handle = runner.spawn('echo', ['done']);
      const result = await handle.wait();

      expect(result.stdout).toBe('done');
      expect(result.exitOutcome).toEqual({ kind: 'exit_code', code: 0 });
    });

    it('kill() cancels the Job via DELETE /compute/{system}/jobs/{jobId}', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 777, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 777, state: 'COMPLETED', exitCode: 0 })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      const handle = runner.spawn('long', ['job']);

      await handle.kill();

      const deleteCall = client.calls.find((c) => c.method === 'delete');
      expect(deleteCall?.path).toBe('/compute/daint/jobs/777');
    });

    it('kill() works without a signal argument', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0 })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      const handle = runner.spawn('echo', ['x']);

      await expect(handle.kill()).resolves.toBeUndefined();
    });
  });

  describe('interface stability', () => {
    it('implements the SubprocessRunner interface', () => {
      const client = createMockFirecrestClient();
      const runner: SubprocessRunner = new FirecrestSubprocessRunner(client, systemName);

      expect(typeof runner.spawn).toBe('function');
      expect(typeof runner.execute).toBe('function');
    });

    it('SubprocessHandle has exactly pid, stdout, stderr, kill, wait', () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0 })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      const handle: SubprocessHandle = runner.spawn('echo', ['x']);

      expect(typeof handle.pid).toBe('number');
      expect(typeof handle.kill).toBe('function');
      expect(typeof handle.wait).toBe('function');
      expect(typeof (handle.stdout as AsyncIterable<string>)[Symbol.asyncIterator]).toBe('function');
      expect(typeof (handle.stderr as AsyncIterable<string>)[Symbol.asyncIterator]).toBe('function');
    });

    it('wait() returns ShellResult, not raw FirecREST type', async () => {
      const client = createPollingMockClient(systemName,
        createMockJobSubmitResponse({ jobId: 1, state: 'PENDING' }),
        [createMockFirecrestJob({ jobId: 1, state: 'COMPLETED', exitCode: 0 })],
      );

      const runner = new FirecrestSubprocessRunner(client, systemName, { pollIntervalMs: 1 });
      const handle = runner.spawn('echo', ['x']);
      const result: ShellResult = await handle.wait();

      expect(result).toHaveProperty('exitOutcome');
      expect(result).not.toHaveProperty('exitCode');
      expect(result).not.toHaveProperty('signalName');
    });
  });
});
