/**
 * Scheduling module (C4 — SLURM).
 *
 * Submits Jobs via sbatch, queries state via squeue (active) and
 * sacct (historical), cancels via scancel. SLURM-only (R8, ADR-004).
 *
 * Public surface:
 * - SchedulingService interface and SchedulingServiceImpl
 * - JobMonitor interface and JobMonitorImpl
 * - SubmitJobInput, JobStatusReport, SchedulingConfig
 * - SLURM parser functions (parseSbatchOutput, parseSqueueOutput, parseSacctOutput)
 *
 * Invariants enforced: INV-S1 (Scheduler authoritative), INV-S2
 * (ResourceRequest immutable), INV-S3 (unique JobID), INV-S4
 * (terminal state is final).
 *
 * Failure modes handled: FM-S1 (RejectionByScheduler), FM-S2
 * (SchedulerUnavailable → UNKNOWN), FM-S3 (stale queue data),
 * FM-S4 (timeout).
 *
 * Spec: build-phases.md Phase 2; api-contracts.md §2;
 * module-graph.md §2; invariants.md INV-S1–S4; failure-modes.md
 * FM-S1–S4; resolutions.md R8, R13; ADR-004.
 */

// Types
export type {
  SchedulingService,
  JobMonitor,
  SubmitJobInput,
  JobStatusReport,
  SchedulingConfig,
} from './types';
export { DEFAULT_SCHEDULING_CONFIG } from './types';

// SLURM parser
export {
  parseSbatchOutput,
  parseSqueueOutput,
  parseSacctOutput,
  parseSLURMStateString,
} from './slurm-parser';
export type { SqueueEntry, SacctEntry } from './slurm-parser';

// Implementation
export { SchedulingServiceImpl } from './scheduling-service';
export type { SchedulingServiceImplProps } from './scheduling-service';
export { JobMonitorImpl } from './job-monitor';
export type { JobMonitorConfig } from './job-monitor';
