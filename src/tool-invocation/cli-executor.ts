/**
 * CLIExecutor — helper for executing CLI Tools (CDO, NCO) via
 * ShellExecutor.
 *
 * Builds a command string from a CLITool's binary, parameters
 * (operatorChain), input file paths, and output file path, then
 * executes it via the dsh-adapter ShellExecutor.
 *
 * The executor does NOT interpret exit codes or signals — it
 * returns the raw ShellResult, and the ToolInvocationService is
 * responsible for INV-T2 (single exit outcome) and INV-T5 (signal
 * vs exit-code distinction).
 *
 * Spec: api-contracts.md §6; module-graph.md §6;
 * features/cdo-operations.feature, features/nco-operations.feature.
 */

import type {
  ShellExecutor,
  ShellExecuteOptions,
  ShellResult,
} from '../dsh-adapter/types';
import type { CLITool } from '../types';

// ============================================================================
// CLIExecutionRequest
// ============================================================================

/**
 * Input for CLI execution.
 *
 * `tool` — the CLITool to execute (provides the binary name).
 * `parameters` — the Tool parameters. For CLI Tools, the
 *   `operatorChain` key (string) is used as the operator portion of
 *   the command (e.g., "-timmean", "-v TAS"). If not present, no
 *   operators are prepended.
 * `inputPaths` — ordered list of input file paths. For multi-input
 *   operations (e.g., CDO -add), the order matches the command's
 *   input order.
 * `outputPath` — the output file path. Always the last argument.
 * `options` — optional ShellExecuteOptions (cwd, env, timeout,
 *   stdin) passed through to ShellExecutor.
 *
 * Spec: api-contracts.md §6; features/cdo-operations.feature.
 */
export interface CLIExecutionRequest {
  readonly tool: CLITool;
  readonly parameters: Record<string, unknown>;
  readonly inputPaths: readonly string[];
  readonly outputPath: string;
  readonly options?: ShellExecuteOptions;
}

// ============================================================================
// CLIExecutorImpl
// ============================================================================

/**
 * Constructor parameters for CLIExecutorImpl.
 */
export interface CLIExecutorImplProps {
  readonly shellExecutor: ShellExecutor;
}

/**
 * Executes CLI Tools (CDO, NCO) via ShellExecutor.
 *
 * The executor builds a command string in the format:
 *   `<binary> [<operatorChain>] <input1> [<input2> ...] <output>`
 *
 * CDO evaluates operators right-to-left (the operator chain is
 * a single CDO invocation). NCO tools (ncks, ncra, etc.) use a
 * single operator or flag set.
 *
 * The executor does NOT interpret exit codes or signals. It returns
 * the raw ShellResult, preserving the ExitOutcome (INV-T5).
 *
 * Spec: api-contracts.md §6; module-graph.md §6;
 * features/cdo-operations.feature, features/nco-operations.feature.
 */
export class CLIExecutorImpl {
  #shellExecutor: ShellExecutor;

  constructor(props: CLIExecutorImplProps) {
    this.#shellExecutor = props.shellExecutor;
  }

  /**
   * Builds and executes a CLI command.
   *
   * The command format is:
   *   `<binary> [<operatorChain>] <input1> [<input2> ...] <output>`
   *
   * If `parameters.operatorChain` is not present, no operators are
   * prepended (the command is just the binary + inputs + output).
   *
   * The ShellResult is returned as-is, preserving the ExitOutcome
   * (INV-T5 — signal vs exit-code distinction).
   *
   * Spec: api-contracts.md §6; features/cdo-operations.feature.
   */
  async execute(request: CLIExecutionRequest): Promise<ShellResult> {
    const command = this.#buildCommand(request);
    return this.#shellExecutor.execute(command, request.options);
  }

  /**
   * Builds the CLI command string from the request.
   *
   * Format: `<binary> [<operatorChain>] <inputs...> <output>`
   */
  #buildCommand(request: CLIExecutionRequest): string {
    const parts: string[] = [request.tool.binary];

    // Add operator chain if present
    const operatorChain = request.parameters['operatorChain'];
    if (typeof operatorChain === 'string' && operatorChain.trim() !== '') {
      parts.push(operatorChain);
    }

    // Add input paths in order
    for (const inputPath of request.inputPaths) {
      parts.push(inputPath);
    }

    // Add output path (always last)
    parts.push(request.outputPath);

    return parts.join(' ');
  }
}
