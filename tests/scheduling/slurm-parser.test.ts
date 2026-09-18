/**
 * Unit tests for the SLURM output parser.
 *
 * Verifies parsing of sbatch, squeue, and sacct output into JobId
 * and JobState values. The parser is the foundation for INV-S1
 * (Scheduler is authoritative for Job State — states are parsed
 * directly from SLURM output, never inferred).
 *
 * Spec: build-phases.md Phase 2; api-contracts.md §2;
 * invariants.md INV-S1, INV-S3; features/job-management.feature.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSbatchOutput,
  parseSqueueOutput,
  parseSacctOutput,
  parseSLURMStateString,
} from '../../src/scheduling/slurm-parser';
import {
  SBATCH_SUCCESS_OUTPUT,
  SQUEUE_RUNNING_OUTPUT,
  SQUEUE_MULTI_USER_OUTPUT,
  SACCT_COMPLETED_OUTPUT,
  SACCT_TIMEOUT_OUTPUT,
  SACCT_OUT_OF_MEMORY_OUTPUT,
  SACCT_NODE_FAIL_OUTPUT,
  SACCT_FAILED_OUTPUT,
  SACCT_CANCELLED_OUTPUT,
  SACCT_MULTI_OUTPUT,
} from './helpers';

describe('@dev-only SLURM parser', () => {
  // ========================================================================
  // sbatch output parsing
  // ========================================================================

  describe('parseSbatchOutput', () => {
    it('parses JobID from "Submitted batch job 4827365"', () => {
      const jobId = parseSbatchOutput(SBATCH_SUCCESS_OUTPUT);
      expect(jobId).toBe(4827365);
    });

    it('parses JobID without trailing newline', () => {
      const jobId = parseSbatchOutput('Submitted batch job 42');
      expect(jobId).toBe(42);
    });

    it('parses a large JobID', () => {
      const jobId = parseSbatchOutput('Submitted batch job 99999999\n');
      expect(jobId).toBe(99999999);
    });

    it('returns a positive integer (INV-S3: JobID assigned by Scheduler)', () => {
      const jobId = parseSbatchOutput(SBATCH_SUCCESS_OUTPUT);
      expect(Number.isInteger(jobId)).toBe(true);
      expect(jobId).toBeGreaterThan(0);
    });

    it('throws on empty output', () => {
      expect(() => parseSbatchOutput('')).toThrow();
    });

    it('throws on output without "Submitted batch job" prefix', () => {
      expect(() => parseSbatchOutput('Some other output\n')).toThrow();
    });

    it('throws on output with non-numeric JobID', () => {
      expect(() => parseSbatchOutput('Submitted batch job abc\n')).toThrow();
    });

    it('throws on output without JobID', () => {
      expect(() => parseSbatchOutput('Submitted batch job\n')).toThrow();
    });
  });

  // ========================================================================
  // squeue output parsing
  // ========================================================================

  describe('parseSqueueOutput', () => {
    it('parses a single RUNNING Job', () => {
      const entries = parseSqueueOutput(SQUEUE_RUNNING_OUTPUT);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.jobId).toBe(4827365);
      expect(entries[0]?.state).toBe('RUNNING');
    });

    it('parses multiple Jobs for a user (R7: proactive reporting)', () => {
      const entries = parseSqueueOutput(SQUEUE_MULTI_USER_OUTPUT);
      expect(entries).toHaveLength(3);
      expect(entries[0]?.jobId).toBe(4827365);
      expect(entries[0]?.state).toBe('RUNNING');
      expect(entries[1]?.jobId).toBe(4827366);
      expect(entries[1]?.state).toBe('PENDING');
      expect(entries[2]?.jobId).toBe(4827367);
      expect(entries[2]?.state).toBe('COMPLETED');
    });

    it('returns empty array for empty output', () => {
      expect(parseSqueueOutput('')).toEqual([]);
    });

    it('skips blank lines', () => {
      const entries = parseSqueueOutput('\n4827365,RUNNING\n\n');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.jobId).toBe(4827365);
    });

    it('throws on malformed line (missing state)', () => {
      expect(() => parseSqueueOutput('4827365\n')).toThrow();
    });

    it('throws on malformed line (non-numeric JobID)', () => {
      expect(() => parseSqueueOutput('abc,RUNNING\n')).toThrow();
    });

    it('throws on unknown state string', () => {
      expect(() => parseSqueueOutput('4827365,BOGUS\n')).toThrow();
    });
  });

  // ========================================================================
  // sacct output parsing
  // ========================================================================

  describe('parseSacctOutput', () => {
    it('parses a completed Job (parsable2 format)', () => {
      const entries = parseSacctOutput(SACCT_COMPLETED_OUTPUT);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.jobId).toBe(4827365);
      expect(entries[0]?.state).toBe('COMPLETED');
      expect(entries[0]?.elapsed).toBe('168:00:00');
      expect(entries[0]?.exitCode).toBe('0:0');
    });

    it('skips batch and extern step lines (only main Job)', () => {
      const entries = parseSacctOutput(SACCT_COMPLETED_OUTPUT);
      // Only the main Job (4827365) — not 4827365.batch or 4827365.extern
      expect(entries).toHaveLength(1);
      expect(entries[0]?.jobId).toBe(4827365);
    });

    it('parses TIMEOUT state (FM-S4)', () => {
      const entries = parseSacctOutput(SACCT_TIMEOUT_OUTPUT);
      expect(entries[0]?.state).toBe('TIMEOUT');
      expect(entries[0]?.elapsed).toBe('24:00:00');
    });

    it('parses OUT_OF_MEMORY state (FM-M2 variant)', () => {
      const entries = parseSacctOutput(SACCT_OUT_OF_MEMORY_OUTPUT);
      expect(entries[0]?.state).toBe('OUT_OF_MEMORY');
    });

    it('parses NODE_FAIL state (FM-M4)', () => {
      const entries = parseSacctOutput(SACCT_NODE_FAIL_OUTPUT);
      expect(entries[0]?.state).toBe('NODE_FAIL');
    });

    it('parses FAILED state', () => {
      const entries = parseSacctOutput(SACCT_FAILED_OUTPUT);
      expect(entries[0]?.state).toBe('FAILED');
      expect(entries[0]?.exitCode).toBe('2:0');
    });

    it('parses CANCELLED state', () => {
      const entries = parseSacctOutput(SACCT_CANCELLED_OUTPUT);
      expect(entries[0]?.state).toBe('CANCELLED');
    });

    it('parses multiple Jobs for reconciliation (R13)', () => {
      const entries = parseSacctOutput(SACCT_MULTI_OUTPUT);
      expect(entries).toHaveLength(3);
      expect(entries[0]?.state).toBe('COMPLETED');
      expect(entries[1]?.state).toBe('TIMEOUT');
      expect(entries[2]?.state).toBe('CANCELLED');
    });

    it('returns empty array for empty output', () => {
      expect(parseSacctOutput('')).toEqual([]);
    });

    it('throws on malformed sacct line (too few fields)', () => {
      expect(() => parseSacctOutput('4827365|COMPLETED\n')).toThrow();
    });

    it('throws on unknown state in sacct output', () => {
      expect(() => parseSacctOutput('4827365|BOGUS|00:00:01|0:0\n')).toThrow();
    });
  });

  // ========================================================================
  // SLURM state string parsing
  // ========================================================================

  describe('parseSLURMStateString', () => {
    it('parses PENDING', () => {
      expect(parseSLURMStateString('PENDING')).toBe('PENDING');
    });

    it('parses RUNNING', () => {
      expect(parseSLURMStateString('RUNNING')).toBe('RUNNING');
    });

    it('parses COMPLETED', () => {
      expect(parseSLURMStateString('COMPLETED')).toBe('COMPLETED');
    });

    it('parses FAILED', () => {
      expect(parseSLURMStateString('FAILED')).toBe('FAILED');
    });

    it('parses TIMEOUT', () => {
      expect(parseSLURMStateString('TIMEOUT')).toBe('TIMEOUT');
    });

    it('parses CANCELLED', () => {
      expect(parseSLURMStateString('CANCELLED')).toBe('CANCELLED');
    });

    it('parses OUT_OF_MEMORY', () => {
      expect(parseSLURMStateString('OUT_OF_MEMORY')).toBe('OUT_OF_MEMORY');
    });

    it('parses NODE_FAIL', () => {
      expect(parseSLURMStateString('NODE_FAIL')).toBe('NODE_FAIL');
    });

    it('parses UNKNOWN', () => {
      expect(parseSLURMStateString('UNKNOWN')).toBe('UNKNOWN');
    });

    it('parses abbreviated PENDING (PD)', () => {
      expect(parseSLURMStateString('PD')).toBe('PENDING');
    });

    it('parses abbreviated RUNNING (R)', () => {
      expect(parseSLURMStateString('R')).toBe('RUNNING');
    });

    it('parses abbreviated COMPLETED (CD)', () => {
      expect(parseSLURMStateString('CD')).toBe('COMPLETED');
    });

    it('parses abbreviated FAILED (F)', () => {
      expect(parseSLURMStateString('F')).toBe('FAILED');
    });

    it('parses abbreviated TIMEOUT (TO)', () => {
      expect(parseSLURMStateString('TO')).toBe('TIMEOUT');
    });

    it('parses abbreviated CANCELLED (CA)', () => {
      expect(parseSLURMStateString('CA')).toBe('CANCELLED');
    });

    it('parses abbreviated OUT_OF_MEMORY (OOM)', () => {
      expect(parseSLURMStateString('OOM')).toBe('OUT_OF_MEMORY');
    });

    it('parses abbreviated NODE_FAIL (NF)', () => {
      expect(parseSLURMStateString('NF')).toBe('NODE_FAIL');
    });

    it('throws on unknown state', () => {
      expect(() => parseSLURMStateString('BOGUS')).toThrow();
    });

    it('throws on empty string', () => {
      expect(() => parseSLURMStateString('')).toThrow();
    });
  });
});
