/**
 * PythonExecutor — helper for executing Python Tools (healpy, zarr,
 * ICON grid tools) via SubprocessRunner.
 *
 * Builds a Python command from a PythonTool's moduleName and
 * functionName, parameters, input file paths, and output file path,
 * then executes it via the dsh-adapter SubprocessRunner.
 *
 * Two execution modes:
 * - Inline script (`python3 -c "..."`): when `parameters.script`
 *   is provided, the script string is passed via `-c`.
 * - Module mode (`python3 -m <module> <args>`): when no `script`
 *   is provided, the tool's moduleName is invoked via `-m`, with
 *   `parameters.args` as command-line arguments.
 *
 * The executor does NOT interpret exit codes or signals — it
 * returns the raw ShellResult, and the ToolInvocationService is
 * responsible for INV-T2 (single exit outcome) and INV-T5 (signal
 * vs exit-code distinction).
 *
 * Spec: api-contracts.md §6; module-graph.md §6;
 * features/zarr-io.feature, features/grid-conversion.feature.
 */

import type {
  SubprocessRunner,
  SubprocessOptions,
  ShellResult,
} from '../dsh-adapter/types';
import type { PythonTool } from '../types';

// ============================================================================
// PythonExecutionRequest
// ============================================================================

/**
 * Input for Python execution.
 *
 * `tool` — the PythonTool to execute (provides moduleName and
 *   functionName).
 * `parameters` — the Tool parameters. Two modes:
 *   - `script` (string): a full Python script passed via `-c`.
 *     Example: `'from healpy import angular_power_spectrum;
 *     angular_power_spectrum("input.nc", "output.nc")'`
 *   - `args` (string[]): command-line arguments passed to the
 *     module via `-m`. Example: `['--input', 'input.nc',
 *     '--output', 'output.nc']`
 * `inputPaths` — ordered list of input file paths (for reference;
 *   the actual paths used are in `parameters.script` or
 *   `parameters.args`).
 * `outputPath` — the output file path (for reference).
 * `options` — optional SubprocessOptions (cwd, env, timeout,
 *   stdin) passed through to SubprocessRunner.
 *
 * Spec: api-contracts.md §6; features/zarr-io.feature.
 */
export interface PythonExecutionRequest {
  readonly tool: PythonTool;
  readonly parameters: Record<string, unknown>;
  readonly inputPaths: readonly string[];
  readonly outputPath: string;
  readonly options?: SubprocessOptions;
}

// ============================================================================
// PythonExecutorImpl
// ============================================================================

/**
 * Constructor parameters for PythonExecutorImpl.
 */
export interface PythonExecutorImplProps {
  readonly subprocessRunner: SubprocessRunner;
}

/**
 * Executes Python Tools (healpy, zarr, ICON grid tools) via
 * SubprocessRunner.
 *
 * Two execution modes:
 * - Inline script: `python3 -c "<script>"` when
 *   `parameters.script` is provided.
 * - Module mode: `python3 -m <moduleName> <args...>` when no
 *   `script` is provided. Uses `parameters.args` (string[]) as
 *   command-line arguments.
 *
 * The executor does NOT interpret exit codes or signals. It returns
 * the raw ShellResult, preserving the ExitOutcome (INV-T5).
 *
 * Spec: api-contracts.md §6; module-graph.md §6;
 * features/zarr-io.feature, features/grid-conversion.feature.
 */
export class PythonExecutorImpl {
  #subprocessRunner: SubprocessRunner;

  constructor(props: PythonExecutorImplProps) {
    this.#subprocessRunner = props.subprocessRunner;
  }

  /**
   * Builds and executes a Python command.
   *
   * Inline script mode (`parameters.script`):
   *   `python3 -c "<script>"`
   *
   * Module mode (no `parameters.script`, uses `parameters.args`):
   *   `python3 -m <moduleName> <args...>`
   *
   * If neither `script` nor `args` is provided, the command is:
   *   `python3 -m <moduleName>`
   *
   * The ShellResult is returned as-is, preserving the ExitOutcome
   * (INV-T5 — signal vs exit-code distinction).
   *
   * Spec: api-contracts.md §6; features/zarr-io.feature.
   */
  async execute(request: PythonExecutionRequest): Promise<ShellResult> {
    const { args, options } = this.#buildArgs(request);
    return this.#subprocessRunner.execute('python3', args, options);
  }

  /**
   * Builds the args array for SubprocessRunner.execute().
   *
   * Inline script mode: `['-c', '<script>']`
   * Module mode: `['-m', '<moduleName>', ...<args>]`
   */
  #buildArgs(request: PythonExecutionRequest): {
    readonly args: string[];
    readonly options: SubprocessOptions | undefined;
  } {
    const script = request.parameters['script'];

    if (typeof script === 'string' && script.trim() !== '') {
      return {
        args: ['-c', script],
        options: request.options,
      };
    }

    // Module mode: python3 -m <moduleName> <args...>
    const args: string[] = ['-m', request.tool.moduleName];

    const paramsArgs = request.parameters['args'];
    if (Array.isArray(paramsArgs)) {
      for (const arg of paramsArgs) {
        if (typeof arg === 'string') {
          args.push(arg);
        }
      }
    }

    return {
      args,
      options: request.options,
    };
  }
}
