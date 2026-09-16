/**
 * Integration test helpers — real module implementations with
 * mock dsh-adapter.
 *
 * All 7 cera modules (C1–C7) are wired together using their REAL
 * implementations. Only the dsh-adapter layer (ShellExecutor,
 * SubprocessRunner, FilesystemGateway) is mocked. This tests the
 * actual seams between modules, not mock-to-mock interactions.
 *
 * Spec: build-phases.md Tier 2 (integration tests with mock
 * SLURM/uenv); integrator recommendations.
 */

// tslint:disable-next-line: no-unused-import — needed for type inference
// vi is not directly used but required for the module to load
import type { ShellResult, ShellExecutor, SubprocessRunner, FilesystemGateway } from '../../src/dsh-adapter/types';
import { SchedulingServiceImpl } from '../../src/scheduling/scheduling-service';
import { EnvironmentServiceImpl } from '../../src/environment-management/environment-service';
import { ProvenanceServiceImpl } from '../../src/provenance/provenance-service';
import { DataManagementServiceImpl } from '../../src/data-management/data-management-service';
import { ToolInvocationServiceImpl } from '../../src/tool-invocation/tool-invocation-service';
import { CaseServiceImpl } from '../../src/tool-invocation/case-service';
import { ToolCatalogServiceImpl } from '../../src/tool-invocation/tool-catalog';
import { WorkflowServiceImpl } from '../../src/agent-interaction/workflow-service';
import { ExperimentServiceImpl } from '../../src/agent-interaction/experiment-service';
import { SessionServiceImpl } from '../../src/agent-interaction/session-service';
import { ActionServiceImpl } from '../../src/agent-interaction/action-service';
import type { ExitOutcome, Location } from '../../src/types';

// ============================================================================
// Mock FilesystemGateway (in-memory)
// ============================================================================

export function createInMemoryFilesystem(overrides: {
  directories?: ReadonlyMap<string, readonly string[]>;
  files?: ReadonlyMap<string, Buffer>;
} = {}): FilesystemGateway & {
  fileContents: Map<string, Buffer>;
  dirContents: Map<string, Set<string>>;
} {
  const fileContents = new Map<string, Buffer>();
  const dirContents = new Map<string, Set<string>>();

  if (overrides.directories) {
    for (const [path, entries] of overrides.directories) {
      dirContents.set(path, new Set(entries));
    }
  }
  if (overrides.files) {
    for (const [path, data] of overrides.files) {
      fileContents.set(path, data);
    }
  }

  return {
    async exists(path: string): Promise<boolean> {
      if (fileContents.has(path)) return true;
      for (const dir of dirContents.keys()) {
        if (dir === path) return true;
        if (path.startsWith(dir + '/')) {
          const file = path.slice(dir.length + 1);
          const entries = dirContents.get(dir);
          if (entries?.has(file)) return true;
        }
      }
      return false;
    },
    async isReadable(path: string): Promise<boolean> {
      if (fileContents.has(path)) return true;
      if (dirContents.has(path)) return true;
      // Check if path is a file inside a known directory
      const lastSlash = path.lastIndexOf('/');
      if (lastSlash > 0) {
        const dir = path.slice(0, lastSlash);
        const file = path.slice(lastSlash + 1);
        return dirContents.get(dir)?.has(file) ?? false;
      }
      return false;
    },
    async isWritable(_path: string): Promise<boolean> {
      return true;
    },
    async stat(path: string) {
      if (fileContents.has(path)) {
        return { size: fileContents.get(path)?.length ?? 0, isFile: true, isDirectory: false, mtime: new Date() };
      }
      if (dirContents.has(path)) {
        return { size: 0, isFile: false, isDirectory: true, mtime: new Date() };
      }
      return { size: 0, isFile: false, isDirectory: false, mtime: new Date() };
    },
    async readFile(path: string): Promise<Buffer> {
      return fileContents.get(path) ?? Buffer.from('');
    },
    async writeFile(path: string, data: Buffer): Promise<void> {
      fileContents.set(path, data);
      // Track the file in its parent directory so readDir can see it
      const lastSlash = path.lastIndexOf('/');
      if (lastSlash > 0) {
        const dir = path.slice(0, lastSlash);
        const filename = path.slice(lastSlash + 1);
        let entries = dirContents.get(dir);
        if (entries === undefined) {
          entries = new Set<string>();
          dirContents.set(dir, entries);
        }
        entries.add(filename);
      }
    },
    async readDir(path: string): Promise<string[]> {
      return Array.from(dirContents.get(path) ?? []);
    },
    async mkdir(path: string, _recursive?: boolean): Promise<void> {
      if (!dirContents.has(path)) {
        dirContents.set(path, new Set());
      }
    },
    fileContents,
    dirContents,
  } as unknown as FilesystemGateway & {
    fileContents: Map<string, Buffer>;
    dirContents: Map<string, Set<string>>;
  };
}

// ============================================================================
// Mock ShellExecutor (for CDO, NCO, uenv commands)
// ============================================================================

export function createMockShellExecutor(overrides: {
  responses?: ReadonlyMap<string, ShellResult>;
  defaultResult?: ShellResult;
} = {}): ShellExecutor & {
  calls: string[];
  setResponse: (match: string, result: ShellResult) => void;
} {
  const responses = new Map(overrides.responses);
  const defaultResult = overrides.defaultResult ?? {
    stdout: '',
    stderr: '',
    exitOutcome: { kind: 'exit_code', code: 0 } as ExitOutcome,
  };
  const calls: string[] = [];

  return {
    async execute(command: string, _options?: { cwd?: string; env?: Record<string, string>; timeout?: number; stdin?: string }): Promise<ShellResult> {
      calls.push(command);
      for (const [match, result] of responses) {
        if (command.includes(match)) return result;
      }
      return defaultResult;
    },
    calls,
    setResponse: (match: string, result: ShellResult) => {
      responses.set(match, result);
    },
  } as unknown as ShellExecutor & {
    calls: string[];
    setResponse: (match: string, result: ShellResult) => void;
  };
}

// ============================================================================
// Mock SubprocessRunner (for Python tools, SLURM CLI)
// ============================================================================

export function createMockSubprocessRunner(overrides: {
  responses?: ReadonlyMap<string, ShellResult>;
  defaultResult?: ShellResult;
} = {}): SubprocessRunner & {
  calls: { command: string; args: readonly string[] }[];
  setResponse: (match: string, result: ShellResult) => void;
} {
  const responses = new Map(overrides.responses);
  const defaultResult = overrides.defaultResult ?? {
    stdout: '',
    stderr: '',
    exitOutcome: { kind: 'exit_code', code: 0 } as ExitOutcome,
  };
  const calls: { command: string; args: readonly string[] }[] = [];

  return {
    async execute(command: string, args: readonly string[], _options?: { cwd?: string; env?: Record<string, string>; timeout?: number; stdin?: string }): Promise<ShellResult> {
      calls.push({ command, args });
      const key = `${command} ${args.join(' ')}`;
      for (const [match, result] of responses) {
        if (key.includes(match)) return result;
      }
      return defaultResult;
    },
    spawn() {
      throw new Error('spawn not implemented in mock');
    },
    calls,
    setResponse: (match: string, result: ShellResult) => {
      responses.set(match, result);
    },
  } as unknown as SubprocessRunner & {
    calls: { command: string; args: readonly string[] }[];
    setResponse: (match: string, result: ShellResult) => void;
  };
}

// ============================================================================
// Full system wiring (real modules + mock dsh-adapter)
// ============================================================================

export interface FullSystem {
  readonly filesystem: ReturnType<typeof createInMemoryFilesystem>;
  readonly shellExecutor: ReturnType<typeof createMockShellExecutor>;
  readonly subprocessRunner: ReturnType<typeof createMockSubprocessRunner>;
  readonly scheduling: SchedulingServiceImpl;
  readonly environment: EnvironmentServiceImpl;
  readonly provenance: ProvenanceServiceImpl;
  readonly dataManagement: DataManagementServiceImpl;
  readonly toolInvocation: ToolInvocationServiceImpl;
  readonly caseService: CaseServiceImpl;
  readonly catalog: ToolCatalogServiceImpl;
  readonly workflowService: WorkflowServiceImpl;
  readonly experimentService: ExperimentServiceImpl;
  readonly sessionService: SessionServiceImpl;
  readonly actionService: ActionServiceImpl;
}

/**
 * Wires all 7 cera modules together using their REAL implementations.
 * Only the dsh-adapter layer (ShellExecutor, SubprocessRunner,
 * FilesystemGateway) is mocked.
 *
 * The filesystem is pre-populated with common directories:
 * - /scratch/snx3000/cera_user/data (input Datasets)
 * - /scratch/snx3000/cera_user/output (output Datasets)
 * - /scratch/snx3000/cera_user/workflows (Workflow store)
 * - /user-environment/env/cdo/2.0.5/usr/bin (CDO binary)
 * - /user-environment/env/python/3.11.6/usr/bin (Python binary)
 *
 * The shell executor is pre-configured with:
 * - "uenv status" → success (uenv available)
 * - "uenv list" → lists mounted uenvs
 *
 * The subprocess runner is pre-configured with:
 * - "sbatch" → "Submitted batch job 4827365"
 * - "squeue" → running job
 * - "sacct" → completed job
 */
export function createFullSystem(overrides: {
  filesystem?: ReturnType<typeof createInMemoryFilesystem>;
  shellExecutor?: ReturnType<typeof createMockShellExecutor>;
  subprocessRunner?: ReturnType<typeof createMockSubprocessRunner>;
} = {}): FullSystem {
  // Filesystem with common directories
  const filesystem = overrides.filesystem ?? createInMemoryFilesystem({
    directories: new Map([
      ['/scratch/snx3000/cera_user/data', ['tas_historical_2000-2010.nc']],
      ['/scratch/snx3000/cera_user/output', []],
      ['/scratch/snx3000/cera_user/workflows', []],
      ['/scratch/snx3000/cera_user/provenance', []],
      ['/user-environment/env/cdo/2.0.5', ['usr']],
      ['/user-environment/env/cdo/2.0.5/usr', ['bin']],
      ['/user-environment/env/cdo/2.0.5/usr/bin', ['cdo']],
      ['/user-environment/env/python/3.11.6', ['usr']],
      ['/user-environment/env/python/3.11.6/usr', ['bin']],
      ['/user-environment/env/python/3.11.6/usr/bin', ['python3']],
    ]),
  });

  // Shell executor with uenv defaults
  const shellExecutor = overrides.shellExecutor ?? createMockShellExecutor({
    responses: new Map([
      ['uenv status', {
        stdout: 'cdo/2.0.5: available\n',
        stderr: '',
        exitOutcome: { kind: 'exit_code', code: 0 },
      }],
      ['uenv list', {
        stdout: 'cdo/2.0.5 /user-environment/env/cdo/2.0.5\n',
        stderr: '',
        exitOutcome: { kind: 'exit_code', code: 0 },
      }],
    ]),
  });

  // Subprocess runner with SLURM defaults
  const subprocessRunner = overrides.subprocessRunner ?? createMockSubprocessRunner({
    responses: new Map([
      ['sbatch', {
        stdout: 'Submitted batch job 4827365\n',
        stderr: '',
        exitOutcome: { kind: 'exit_code', code: 0 },
      }],
      ['squeue', {
        stdout: '4827365,RUNNING\n',
        stderr: '',
        exitOutcome: { kind: 'exit_code', code: 0 },
      }],
      ['sacct', {
        stdout: '4827365|COMPLETED|168:00:00|0:0\n',
        stderr: '',
        exitOutcome: { kind: 'exit_code', code: 0 },
      }],
    ]),
  });

  // Phase 2: Leaf modules
  const scheduling = new SchedulingServiceImpl({
    subprocessRunner,
    shellExecutor,
    userId: 'cera_user' as unknown as import('../../src/types').UserId,
  });

  const environment = new EnvironmentServiceImpl({
    subprocessRunner,
    shellExecutor,
    filesystem,
  });

  // Ensure provenance store directory exists
  filesystem.dirContents.set('/scratch/snx3000/cera_user/provenance', new Set());

  const provenance = new ProvenanceServiceImpl({
    filesystem,
    config: {
      storePath: '/scratch/snx3000/cera_user/provenance',
      maxRetries: 3,
    },
  });

  // Phase 3: Data management
  const dataManagement = new DataManagementServiceImpl({
    filesystem,
    provenance,
  });

  // Phase 4: Tool invocation
  const catalog = new ToolCatalogServiceImpl();
  const toolInvocation = new ToolInvocationServiceImpl({
    catalog,
    environment,
    dataManagement,
    provenance,
    scheduling,
    shellExecutor,
    subprocessRunner,
  });
  const caseService = new CaseServiceImpl({
    catalog,
    environment,
    dataManagement,
    provenance,
    scheduling,
    shellExecutor,
    subprocessRunner,
    cesmToolId: 'cesm' as unknown as import('../../src/types').ToolId,
    config: {
      caseOutputBasePath: '/scratch/snx3000/cera_user/cases',
      pollIntervalMs: 50,
      commandTimeoutMs: 5000,
    },
    outputScanner: async (_location: Location) => {
      // Return a mock output file
      return [{
        filename: 'tas_h0_0001-01.nc',
        format: 'netcdf',
        grid: { kind: 'lat-lon', nlat: 180, nlon: 360 },
        variables: [{ name: 'TAS', units: 'K', dimensions: ['time', 'lat', 'lon'] }],
      }];
    },
  });

  // Phase 5: Agent interaction
  const experimentService = new ExperimentServiceImpl();
  const sessionService = new SessionServiceImpl({
    scheduling,
  });
  const workflowService = new WorkflowServiceImpl({
    dataManagement,
    provenance,
    toolInvocation,
    caseService,
    catalog,
    scheduling,
    experimentService,
    filesystem,
    config: {
      pollIntervalMs: 50,
      outputBasePath: '/scratch/snx3000/cera_user/output',
      storePath: '/scratch/snx3000/cera_user/workflows',
    },
  });
  const actionService = new ActionServiceImpl({
    catalog,
    dataManagement,
  });

  return {
    filesystem,
    shellExecutor,
    subprocessRunner,
    scheduling,
    environment,
    provenance,
    dataManagement,
    toolInvocation,
    caseService,
    catalog,
    workflowService,
    experimentService,
    sessionService,
    actionService,
  };
}
