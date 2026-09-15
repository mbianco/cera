/**
 * Unit tests for SchedulingServiceImpl.
 *
 * Verifies all scheduling invariants (INV-S1–S4) and all scheduling
 * failure modes (FM-S1–S4). Uses a mock SubprocessRunner that
 * returns configurable SLURM CLI output.
 *
 * Spec: build-phases.md Phase 2; api-contracts.md §2;
 * invariants.md INV-S1–S4; failure-modes.md FM-S1–S4;
 * resolutions.md R8, R13; features/job-management.feature.
 */

import { describe, it, expect } from 'vitest';
import {
  SchedulingServiceImpl,
} from '../../src/scheduling/scheduling-service';
import type { SchedulingService } from '../../src/scheduling/types';
import {
  createMockSubprocessRunner,
  createMockShellExecutor,
  createMockShellResult,
  createMockResourceRequest,
  createJobId,
  SBATCH_SUCCESS_OUTPUT,
  SBATCH_REJECTION_STDERR,
  SQUEUE_RUNNING_OUTPUT,
  SQUEUE_MULTI_USER_OUTPUT,
  SQUEUE_UNAVAILABLE_STDERR,
  SACCT_COMPLETED_OUTPUT,
  SACCT_TIMEOUT_OUTPUT,
  SACCT_OUT_OF_MEMORY_OUTPUT,
  SACCT_NODE_FAIL_OUTPUT,
  SACCT_FAILED_OUTPUT,
  SACCT_CANCELLED_OUTPUT,
  SACCT_MULTI_OUTPUT,
  SCANCEL_NOT_FOUND_STDERR,
} from './helpers';
import type {
  SubprocessRunner,
  ShellExecutor,
  ShellResult,
} from '../../src/dsh-adapter/types';
import {
  RejectedByScheduler,
  SchedulerUnavailable,
  JobNotFound as JobNotFoundError,
} from '../../src/types/errors';
import type {
  UserId,
  JobEvent,
} from '../../src/types';
import {
  isTerminalJobState,
} from '../../src/types/value-objects';

// ============================================================================
// Helpers for building mock runners
// ============================================================================

const SLURM_USER = 'cera_user' as UserId;

function sbatchSuccess(): ShellResult {
  return createMockShellResult({ stdout: SBATCH_SUCCESS_OUTPUT });
}

function sbatchRejection(): ShellResult {
  return createMockShellResult({
    stdout: '',
    stderr: SBATCH_REJECTION_STDERR,
    exitOutcome: { kind: 'exit_code', code: 1 },
  });
}

function squeueRunning(): ShellResult {
  return createMockShellResult({ stdout: SQUEUE_RUNNING_OUTPUT });
}

function squeueMultiUser(): ShellResult {
  return createMockShellResult({ stdout: SQUEUE_MULTI_USER_OUTPUT });
}

function squeueUnavailable(): ShellResult {
  return createMockShellResult({
    stdout: '',
    stderr: SQUEUE_UNAVAILABLE_STDERR,
    exitOutcome: { kind: 'exit_code', code: 1 },
  });
}

function sacctCompleted(): ShellResult {
  return createMockShellResult({ stdout: SACCT_COMPLETED_OUTPUT });
}

function sacctTimeout(): ShellResult {
  return createMockShellResult({ stdout: SACCT_TIMEOUT_OUTPUT });
}

function sacctOutOfMemory(): ShellResult {
  return createMockShellResult({ stdout: SACCT_OUT_OF_MEMORY_OUTPUT });
}

function sacctNodeFail(): ShellResult {
  return createMockShellResult({ stdout: SACCT_NODE_FAIL_OUTPUT });
}

function sacctFailed(): ShellResult {
  return createMockShellResult({ stdout: SACCT_FAILED_OUTPUT });
}

function sacctCancelled(): ShellResult {
  return createMockShellResult({ stdout: SACCT_CANCELLED_OUTPUT });
}

function sacctMulti(): ShellResult {
  return createMockShellResult({ stdout: SACCT_MULTI_OUTPUT });
}

function scancelSuccess(): ShellResult {
  return createMockShellResult({ stdout: '', stderr: '' });
}

function scancelNotFound(): ShellResult {
  return createMockShellResult({
    stdout: '',
    stderr: SCANCEL_NOT_FOUND_STDERR,
    exitOutcome: { kind: 'exit_code', code: 1 },
  });
}

/**
 * Creates a scheduling service with the given mock runner and
 * optional event callback.
 */
function createService(
  runner: SubprocessRunner,
  shellExecutor?: ShellExecutor,
  onEvent?: (event: JobEvent) => void,
): SchedulingService {
  return new SchedulingServiceImpl({
    subprocessRunner: runner,
    shellExecutor: shellExecutor ?? createMockShellExecutor(),
    userId: SLURM_USER,
    onEvent,
  });
}

describe('SchedulingServiceImpl', () => {
  // ========================================================================
  // submitJob (INV-S2, INV-S3; FM-S1, FM-S2)
  // ========================================================================

  describe('submitJob', () => {
    it('submits a Job and returns it with the SLURM-assigned JobID (INV-S3)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sbatch', result: sbatchSuccess() }],
      });
      const service = createService(runner);

      const job = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });

      expect(job.jobId).toBe(createJobId(4827365));
      expect(job.state).toBe('PENDING');
      expect(job.userId).toBe(SLURM_USER);
      expect(job.resourceRequest.nodes).toBe(128);
    });

    it('does not generate the JobID — parses it from sbatch output (INV-S3)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sbatch', result: sbatchSuccess() }],
      });
      const service = createService(runner);

      const job = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });

      // JobID comes from sbatch output, not generated by cera
      expect(job.jobId).toBe(4827365);
      expect(runner.execute).toHaveBeenCalledWith(
        'sbatch',
        expect.arrayContaining([expect.any(String)]),
        expect.anything(),
      );
    });

    it('ResourceRequest is immutable after submission (INV-S2)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sbatch', result: sbatchSuccess() }],
      });
      const service = createService(runner);

      const resourceRequest = createMockResourceRequest();
      const job = await service.submitJob({
        resourceRequest,
        command: 'my-script.sh',
      });

      // The Job's ResourceRequest is the same object (immutable)
      expect(job.resourceRequest).toBe(resourceRequest);
      expect(job.resourceRequest.wallTime).toBe('168:00:00');
    });

    it('passes the sbatch command to the subprocess runner', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sbatch', result: sbatchSuccess() }],
      });
      const service = createService(runner);

      await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });

      expect(runner.execute).toHaveBeenCalledWith(
        'sbatch',
        expect.arrayContaining(['my-script.sh']),
        expect.anything(),
      );
    });

    it('includes sbatch flags from ResourceRequest', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sbatch', result: sbatchSuccess() }],
      });
      const service = createService(runner);

      await service.submitJob({
        resourceRequest: createMockResourceRequest({
          nodes: 64,
          wallTime: '72:00:00',
          partition: 'gpu',
          qos: 'high',
        }),
        command: 'gpu-script.sh',
      });

      const call = runner.calls[0];
      expect(call?.args).toContain('--nodes=64');
      expect(call?.args).toContain('--time=72:00:00');
      expect(call?.args).toContain('--partition=gpu');
      expect(call?.args).toContain('--qos=high');
    });

    it('throws RejectedByScheduler when sbatch returns non-zero (FM-S1)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sbatch', result: sbatchRejection() }],
      });
      const service = createService(runner);

      await expect(
        service.submitJob({
          resourceRequest: createMockResourceRequest(),
          command: 'bad-script.sh',
        }),
      ).rejects.toThrow(RejectedByScheduler);
    });

    it('Rejection error includes the SLURM error message', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sbatch', result: sbatchRejection() }],
      });
      const service = createService(runner);

      try {
        await service.submitJob({
          resourceRequest: createMockResourceRequest(),
          command: 'bad-script.sh',
        });
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RejectedByScheduler);
        const schedError = error as RejectedByScheduler;
        expect(schedError.userMessage).toContain('Invalid qos specification');
      }
    });

    it('throws SchedulerUnavailable when sbatch fails with connection error (FM-S2)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{
          match: 'sbatch',
          result: createMockShellResult({
            stderr: SQUEUE_UNAVAILABLE_STDERR,
            exitOutcome: { kind: 'exit_code', code: 1 },
          }),
        }],
      });
      const service = createService(runner);

      await expect(
        service.submitJob({
          resourceRequest: createMockResourceRequest(),
          command: 'my-script.sh',
        }),
      ).rejects.toThrow(SchedulerUnavailable);
    });

    it('emits JobSubmitted event on success', async () => {
      const events: JobEvent[] = [];
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sbatch', result: sbatchSuccess() }],
      });
      const service = createService(runner, undefined, (e) => events.push(e));

      await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('job_submitted');
    });
  });

  // ========================================================================
  // queryJob (INV-S1, INV-S4; FM-S2, FM-S3)
  // ========================================================================

  describe('queryJob', () => {
    it('queries an active Job via squeue and returns its state (INV-S1)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'sbatch', result: sbatchSuccess() },
          { match: 'squeue', result: squeueRunning() },
        ],
      });
      const service = createService(runner);

      const submitted = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });
      const job = await service.queryJob(submitted.jobId);

      expect(job.state).toBe('RUNNING');
      expect(job.jobId).toBe(submitted.jobId);
    });

    it('state comes from squeue output — not inferred from file existence (INV-S1)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'sbatch', result: sbatchSuccess() },
          { match: 'squeue', result: squeueRunning() },
        ],
      });
      const service = createService(runner);

      const submitted = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });
      const job = await service.queryJob(submitted.jobId);

      // The state is exactly what squeue reported
      expect(job.state).toBe('RUNNING');
      // No file existence check is performed — squeue is the authority
      expect(runner.execute).toHaveBeenCalledWith(
        'squeue',
        expect.arrayContaining(['-j']),
        expect.anything(),
      );
    });

    it('queries a completed Job via sacct when squeue is empty', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'sbatch', result: sbatchSuccess() },
          { match: 'squeue', result: createMockShellResult({ stdout: '' }) },
          { match: 'sacct', result: sacctCompleted() },
        ],
      });
      const service = createService(runner);

      const submitted = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });
      const job = await service.queryJob(submitted.jobId);

      expect(job.state).toBe('COMPLETED');
      expect(sacctWasCalled(runner)).toBe(true);
    });

    it('terminal state is final — stale squeue RUNNING does not demote (INV-S4)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'sbatch', result: sbatchSuccess() },
          // First query: sacct shows COMPLETED (terminal)
          { match: 'squeue', result: createMockShellResult({ stdout: '' }) },
          { match: 'sacct', result: sacctCompleted() },
          // Second query: squeue shows RUNNING (stale — FM-S3)
          { match: 'squeue', result: squeueRunning() },
        ],
      });
      const service = createService(runner);

      const submitted = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });

      const job1 = await service.queryJob(submitted.jobId);
      expect(job1.state).toBe('COMPLETED');
      expect(job1.terminalState).toBe('COMPLETED');

      // Second query: squeue shows RUNNING (stale data)
      // INV-S4: terminal state is final, ignore stale squeue
      const job2 = await service.queryJob(submitted.jobId);
      expect(job2.state).toBe('COMPLETED');
      expect(job2.terminalState).toBe('COMPLETED');
    });

    it('stale squeue data is ignored, not treated as a demotion (FM-S3)', async () => {
      const events: JobEvent[] = [];
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'sbatch', result: sbatchSuccess() },
          { match: 'squeue', result: createMockShellResult({ stdout: '' }) },
          { match: 'sacct', result: sacctCompleted() },
          { match: 'squeue', result: squeueRunning() }, // stale
        ],
      });
      const service = createService(runner, undefined, (e) => events.push(e));

      const submitted = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });

      await service.queryJob(submitted.jobId); // COMPLETED
      await service.queryJob(submitted.jobId); // stale RUNNING — ignored

      // No state_changed event from COMPLETED back to RUNNING
      const stateChanges = events.filter((e) => e.kind === 'job_state_changed');
      const demotion = stateChanges.find(
        (e) => e.kind === 'job_state_changed' && e.previousState === 'COMPLETED',
      );
      expect(demotion).toBeUndefined();
    });

    it('throws SchedulerUnavailable when squeue fails with connection error (FM-S2)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'sbatch', result: sbatchSuccess() },
          { match: 'squeue', result: squeueUnavailable() },
        ],
      });
      const service = createService(runner);

      const submitted = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });

      await expect(service.queryJob(submitted.jobId)).rejects.toThrow(
        SchedulerUnavailable,
      );
    });

    it('emits JobUnknown event when SLURM is unreachable (FM-S2)', async () => {
      const events: JobEvent[] = [];
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'sbatch', result: sbatchSuccess() },
          { match: 'squeue', result: squeueUnavailable() },
        ],
      });
      const service = createService(runner, undefined, (e) => events.push(e));

      const submitted = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });

      try {
        await service.queryJob(submitted.jobId);
      } catch {
        // expected
      }

      const unknownEvent = events.find((e) => e.kind === 'job_unknown');
      expect(unknownEvent).toBeDefined();
    });

    it('emits JobStateChanged event when state changes', async () => {
      const events: JobEvent[] = [];
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'sbatch', result: sbatchSuccess() },
          { match: 'squeue', result: squeueRunning() },
        ],
      });
      const service = createService(runner, undefined, (e) => events.push(e));

      const submitted = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });

      await service.queryJob(submitted.jobId);

      const changeEvent = events.find(
        (e) => e.kind === 'job_state_changed' && e.newState === 'RUNNING',
      );
      expect(changeEvent).toBeDefined();
    });

    it('queries a Job from a previous Session (not in cache)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'squeue', result: squeueRunning() },
        ],
      });
      const service = createService(runner);

      // Job 4827365 was submitted in a previous Session
      const job = await service.queryJob(createJobId(4827365));

      expect(job.jobId).toBe(createJobId(4827365));
      expect(job.state).toBe('RUNNING');
    });

    it('queries a terminal Job from a previous Session via sacct', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'squeue', result: createMockShellResult({ stdout: '' }) },
          { match: 'sacct', result: sacctCompleted() },
        ],
      });
      const service = createService(runner);

      const job = await service.queryJob(createJobId(4827365));

      expect(job.state).toBe('COMPLETED');
      expect(job.terminalState).toBe('COMPLETED');
    });

    it('throws JobNotFound when Job is not in squeue or sacct', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'squeue', result: createMockShellResult({ stdout: '' }) },
          { match: 'sacct', result: createMockShellResult({ stdout: '' }) },
        ],
      });
      const service = createService(runner);

      await expect(service.queryJob(createJobId(9999999))).rejects.toThrow(
        JobNotFoundError,
      );
    });
  });

  // ========================================================================
  // queryJobsByUser (R7: proactive reporting)
  // ========================================================================

  describe('queryJobsByUser', () => {
    it('queries all Jobs for a User via squeue -u <username> (R7)', async () => {
      const runner = createMockSubprocessRunner();
      const shellExecutor = createMockShellExecutor({
        responses: [{ match: 'squeue', result: squeueMultiUser() }],
      });
      const service = createService(runner, shellExecutor);

      const jobs = await service.queryJobsByUser('cera_user');

      expect(jobs).toHaveLength(3);
      expect(jobs[0]?.jobId).toBe(createJobId(4827365));
      expect(jobs[0]?.state).toBe('RUNNING');
      expect(jobs[1]?.jobId).toBe(createJobId(4827366));
      expect(jobs[1]?.state).toBe('PENDING');
      expect(jobs[2]?.jobId).toBe(createJobId(4827367));
      expect(jobs[2]?.state).toBe('COMPLETED');
    });

    it('passes the username to squeue -u', async () => {
      const runner = createMockSubprocessRunner();
      const shellExecutor = createMockShellExecutor({
        responses: [{ match: 'squeue', result: squeueMultiUser() }],
      });
      const service = createService(runner, shellExecutor);

      await service.queryJobsByUser('cera_user');

      expect(shellExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('-u'),
        expect.anything(),
      );
      expect(shellExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('cera_user'),
        expect.anything(),
      );
    });

    it('returns empty array when User has no Jobs', async () => {
      const runner = createMockSubprocessRunner();
      const shellExecutor = createMockShellExecutor({
        defaultResult: createMockShellResult({ stdout: '' }),
      });
      const service = createService(runner, shellExecutor);

      const jobs = await service.queryJobsByUser('nobody');
      expect(jobs).toEqual([]);
    });

    it('throws SchedulerUnavailable when squeue fails (FM-S2)', async () => {
      const runner = createMockSubprocessRunner();
      const shellExecutor = createMockShellExecutor({
        defaultResult: squeueUnavailable(),
      });
      const service = createService(runner, shellExecutor);

      await expect(service.queryJobsByUser('cera_user')).rejects.toThrow(
        SchedulerUnavailable,
      );
    });
  });

  // ========================================================================
  // cancelJob
  // ========================================================================

  describe('cancelJob', () => {
    it('cancels a running Job via scancel', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'sbatch', result: sbatchSuccess() },
          { match: 'scancel', result: scancelSuccess() },
        ],
      });
      const service = createService(runner);

      const submitted = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });
      await service.cancelJob(submitted.jobId);

      expect(runner.execute).toHaveBeenCalledWith(
        'scancel',
        [String(submitted.jobId)],
        expect.anything(),
      );
    });

    it('emits JobCancelled event on success', async () => {
      const events: JobEvent[] = [];
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'sbatch', result: sbatchSuccess() },
          { match: 'scancel', result: scancelSuccess() },
        ],
      });
      const service = createService(runner, undefined, (e) => events.push(e));

      const submitted = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });
      await service.cancelJob(submitted.jobId);

      const cancelEvent = events.find((e) => e.kind === 'job_cancelled');
      expect(cancelEvent).toBeDefined();
    });

    it('updates the Job state to CANCELLED after cancellation', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { match: 'sbatch', result: sbatchSuccess() },
          { match: 'scancel', result: scancelSuccess() },
          { match: 'squeue', result: createMockShellResult({ stdout: '' }) },
          { match: 'sacct', result: sacctCancelled() },
        ],
      });
      const service = createService(runner);

      const submitted = await service.submitJob({
        resourceRequest: createMockResourceRequest(),
        command: 'my-script.sh',
      });
      await service.cancelJob(submitted.jobId);
      const job = await service.queryJob(submitted.jobId);

      expect(job.state).toBe('CANCELLED');
      expect(isTerminalJobState(job.state)).toBe(true);
    });

    it('throws JobNotFound when cancelling a non-existent Job', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'scancel', result: scancelNotFound() }],
      });
      const service = createService(runner);

      await expect(service.cancelJob(createJobId(9999999))).rejects.toThrow(
        JobNotFoundError,
      );
    });

    it('throws SchedulerUnavailable when scancel fails with connection error', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'scancel', result: squeueUnavailable() }],
      });
      const service = createService(runner);

      await expect(service.cancelJob(createJobId(4827365))).rejects.toThrow(
        SchedulerUnavailable,
      );
    });
  });

  // ========================================================================
  // reconcileViaSacct (R13, FM-S2)
  // ========================================================================

  describe('reconcileViaSacct', () => {
    it('reconciles multiple Jobs via sacct (R13)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sacct', result: sacctMulti() }],
      });
      const service = createService(runner);

      const jobIds = [
        createJobId(4827365),
        createJobId(4827366),
        createJobId(4827367),
      ];
      const jobs = await service.reconcileViaSacct(jobIds);

      expect(jobs).toHaveLength(3);
      expect(jobs[0]?.state).toBe('COMPLETED');
      expect(jobs[1]?.state).toBe('TIMEOUT');
      expect(jobs[2]?.state).toBe('CANCELLED');
    });

    it('reconciles Jobs that completed during an outage (FM-S2)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sacct', result: sacctCompleted() }],
      });
      const service = createService(runner);

      const jobs = await service.reconcileViaSacct([createJobId(4827365)]);

      expect(jobs[0]?.state).toBe('COMPLETED');
      expect(jobs[0]?.terminalState).toBe('COMPLETED');
    });

    it('detects TIMEOUT state during reconciliation (FM-S4)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sacct', result: sacctTimeout() }],
      });
      const service = createService(runner);

      const jobs = await service.reconcileViaSacct([createJobId(4827366)]);

      expect(jobs[0]?.state).toBe('TIMEOUT');
      expect(isTerminalJobState(jobs[0]?.state ?? 'RUNNING')).toBe(true);
    });

    it('detects OUT_OF_MEMORY state during reconciliation', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sacct', result: sacctOutOfMemory() }],
      });
      const service = createService(runner);

      const jobs = await service.reconcileViaSacct([createJobId(4827368)]);

      expect(jobs[0]?.state).toBe('OUT_OF_MEMORY');
    });

    it('detects NODE_FAIL state during reconciliation (FM-M4)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sacct', result: sacctNodeFail() }],
      });
      const service = createService(runner);

      const jobs = await service.reconcileViaSacct([createJobId(4827369)]);

      expect(jobs[0]?.state).toBe('NODE_FAIL');
    });

    it('detects FAILED state during reconciliation', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sacct', result: sacctFailed() }],
      });
      const service = createService(runner);

      const jobs = await service.reconcileViaSacct([createJobId(4827370)]);

      expect(jobs[0]?.state).toBe('FAILED');
    });

    it('throws SchedulerUnavailable when sacct fails (FM-S2)', async () => {
      const runner = createMockSubprocessRunner({
        responses: [{ match: 'sacct', result: squeueUnavailable() }],
      });
      const service = createService(runner);

      await expect(
        service.reconcileViaSacct([createJobId(4827365)]),
      ).rejects.toThrow(SchedulerUnavailable);
    });

    it('returns empty array for empty input', async () => {
      const runner = createMockSubprocessRunner();
      const service = createService(runner);

      const jobs = await service.reconcileViaSacct([]);
      expect(jobs).toEqual([]);
    });
  });

  // ========================================================================
  // Interface stability
  // ========================================================================

  describe('interface stability', () => {
    it('implements the SchedulingService interface', () => {
      const runner = createMockSubprocessRunner();
      const service: SchedulingService = new SchedulingServiceImpl({
        subprocessRunner: runner,
        shellExecutor: createMockShellExecutor(),
        userId: SLURM_USER,
      });

      expect(typeof service.submitJob).toBe('function');
      expect(typeof service.queryJob).toBe('function');
      expect(typeof service.queryJobsByUser).toBe('function');
      expect(typeof service.cancelJob).toBe('function');
      expect(typeof service.reconcileViaSacct).toBe('function');
    });

    it('does not expose the raw SubprocessRunner', () => {
      const runner = createMockSubprocessRunner();
      const service = new SchedulingServiceImpl({
        subprocessRunner: runner,
        shellExecutor: createMockShellExecutor(),
        userId: SLURM_USER,
      });

      const obj = service as unknown as Record<string, unknown>;
      expect(obj.subprocessRunner).toBeUndefined();
      expect(obj.runner).toBeUndefined();
    });
  });
});

// ============================================================================
// Local helpers
// ============================================================================

function sacctWasCalled(runner: SubprocessRunner & {
  readonly calls: { command: string; args: readonly string[] }[];
}): boolean {
  return runner.calls.some((c) => c.command === 'sacct');
}
