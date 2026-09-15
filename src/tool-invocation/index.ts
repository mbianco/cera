/**
 * tool-invocation module (C1).
 *
 * Creates and executes ToolInvocations (CLI, Python, Model) and
 * manages the CESM Case lifecycle (create → configure → build →
 * submit → monitor → post-process).
 *
 * CESM is a Model Tool (R1, ADR-001). The Case lifecycle is a
 * specialized ToolInvocation lifecycle, not a separate bounded
 * context.
 *
 * Public surface:
 * - Types: ToolInvocationRequest, ToolInvocationResult,
 *   CreateCaseInput, CaseConfig, ToolCatalogService,
 *   ToolInvocationService, CaseService, ToolInvocationConfig,
 *   createToolInvocationId, createCaseId
 * - ToolCatalogServiceImpl
 * - ToolInvocationServiceImpl (and ToolInvocationServiceImplProps)
 * - CaseServiceImpl (and CaseServiceImplProps, OutputFile,
 *   OutputScanner, runLengthExceedsWallTime)
 * - CLIExecutor (and CLIExecutionRequest, CLIExecutorImpl,
 *   CLIExecutorImplProps)
 * - PythonExecutor (and PythonExecutionRequest, PythonExecutorImpl,
 *   PythonExecutorImplProps)
 *
 * Invariants enforced: INV-T1–T9.
 * Failure modes handled: FM-T1–T5, FM-M1–M5.
 *
 * Spec: build-phases.md Phase 4; api-contracts.md §6;
 * module-graph.md §6; invariants.md INV-T1–T9;
 * failure-modes.md FM-T1–T5, FM-M1–M5; resolutions.md R1, R4, R5,
 * R8; ADR-001, ADR-008.
 */

// Types
export type {
  ToolInvocationRequest,
  ToolInvocationResult,
  CreateCaseInput,
  CaseConfig,
  ToolCatalogService,
  ToolInvocationService,
  CaseService,
  ToolInvocationConfig,
} from './types';
export {
  DEFAULT_TOOL_INVOCATION_CONFIG,
  createToolInvocationId,
  createCaseId,
} from './types';

// Tool catalog
export { ToolCatalogServiceImpl } from './tool-catalog';

// Tool invocation service
export { ToolInvocationServiceImpl } from './tool-invocation-service';
export type { ToolInvocationServiceImplProps } from './tool-invocation-service';

// Case service
export { CaseServiceImpl } from './case-service';
export type {
  CaseServiceImplProps,
  OutputFile,
  OutputScanner,
} from './case-service';
export { runLengthExceedsWallTime } from './case-service';

// CLI executor
export { CLIExecutorImpl } from './cli-executor';
export type {
  CLIExecutionRequest,
  CLIExecutorImplProps,
} from './cli-executor';

// Python executor
export { PythonExecutorImpl } from './python-executor';
export type {
  PythonExecutionRequest,
  PythonExecutorImplProps,
} from './python-executor';

// AsyncObservable factory
export { createAsyncObservable } from './async-observable';
