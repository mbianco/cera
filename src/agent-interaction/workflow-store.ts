/**
 * Filesystem-backed Workflow store (ADR-006).
 *
 * Each Workflow is persisted as a JSON file at
 * `<storePath>/<workflow-id>.json`. This mirrors the Provenance
 * store pattern (ADR-009): non-transactional, immutable records
 * written as individual files.
 *
 * On `save()`, the Workflow JSON is written. On `load()`, the JSON
 * is read and parsed. On `list()`, all Workflow JSON files in the
 * store directory are listed.
 *
 * If `storePath` is empty, persistence is disabled (in-memory only,
 * for testing). In this mode, `save()`, `load()`, and `list()` are
 * no-ops / return null / empty.
 *
 * Spec: ADR-006 (Workflow persistence); ADR-009 (non-transactional
 * store, same pattern as Provenance).
 */

import type { FilesystemGateway } from '../dsh-adapter/types';
import type { Workflow, WorkflowId } from '../types';

/**
 * Serializable representation of a Workflow for JSON persistence.
 * Dates are stored as ISO 8601 strings.
 */
interface WorkflowJson {
  readonly id: string;
  readonly name: string;
  readonly experimentId: string;
  readonly state: string;
  readonly steps: readonly WorkflowStepJson[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface WorkflowStepJson {
  readonly id: string;
  readonly order: number;
  readonly name: string;
  readonly toolId: string;
  readonly parameters: Record<string, unknown>;
  readonly inputDatasetIds: readonly string[];
  readonly outputDatasetId?: string;
  readonly executionModel: string;
  readonly resourceRequest?: {
    readonly nodes: number;
    readonly coresPerNode: number;
    readonly memory: string;
    readonly wallTime: string;
    readonly partition: string;
    readonly qos: string;
  };
  readonly state: string;
  readonly toolInvocationId?: string;
  readonly jobId?: number;
}

/**
 * Filesystem-backed Workflow store.
 *
 * Spec: ADR-006; ADR-009 (non-transactional, same pattern as
 * Provenance store).
 */
export class WorkflowStore {
  #filesystem: FilesystemGateway;
  #storePath: string;
  #enabled: boolean;

  constructor(props: {
    readonly filesystem: FilesystemGateway;
    readonly storePath: string;
  }) {
    this.#filesystem = props.filesystem;
    this.#storePath = props.storePath;
    this.#enabled = props.storePath.length > 0;
  }

  /**
   * Saves a Workflow to the filesystem as JSON.
   *
   * If persistence is disabled (empty storePath), this is a no-op.
   *
   * @throws {Error} if the write fails.
   */
  async save(workflow: Workflow, steps: readonly import('../types').WorkflowStep[]): Promise<void> {
    if (!this.#enabled) return;

    // Ensure the store directory exists
    const exists = await this.#filesystem.exists(this.#storePath);
    if (!exists) {
      await this.#filesystem.mkdir(this.#storePath, true);
    }

    const json: WorkflowJson = {
      id: workflow.id as string,
      name: workflow.name,
      experimentId: workflow.experimentId as string,
      state: workflow.state,
      steps: steps.map((s) => this.#stepToJson(s)),
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    };

    const path = `${this.#storePath}/${workflow.id as string}.json`;
    const data = Buffer.from(JSON.stringify(json, null, 2), 'utf-8');
    await this.#filesystem.writeFile(path, data);
  }

  /**
   * Loads a Workflow from the filesystem.
   *
   * Returns the Workflow and its steps, or null if the file does
   * not exist or persistence is disabled.
   *
   * @throws {Error} if the file exists but cannot be parsed.
   */
  async load(
    workflowId: WorkflowId,
  ): Promise<{ workflow: Workflow; steps: readonly import('../types').WorkflowStep[] } | null> {
    if (!this.#enabled) return null;

    const path = `${this.#storePath}/${workflowId as string}.json`;
    const exists = await this.#filesystem.exists(path);
    if (!exists) return null;

    const data = await this.#filesystem.readFile(path);
    const json = JSON.parse(data.toString('utf-8')) as WorkflowJson;

    const workflow: Workflow = Object.freeze({
      id: json.id as WorkflowId,
      name: json.name,
      experimentId: json.experimentId as unknown as Workflow['experimentId'],
      state: json.state as Workflow['state'],
      steps: json.steps.map((s) => this.#jsonToStep(s)),
      createdAt: new Date(json.createdAt),
      updatedAt: new Date(json.updatedAt),
    });

    const steps = json.steps.map((s) => this.#jsonToStep(s));

    return { workflow, steps };
  }

  /**
   * Lists all Workflow IDs in the store.
   *
   * Returns an empty array if persistence is disabled or the store
   * directory does not exist.
   */
  async list(): Promise<readonly WorkflowId[]> {
    if (!this.#enabled) return [];

    const exists = await this.#filesystem.exists(this.#storePath);
    if (!exists) return [];

    const entries = await this.#filesystem.readDir(this.#storePath);
    const ids: WorkflowId[] = [];
    for (const entry of entries) {
      if (entry.endsWith('.json')) {
        const id = entry.slice(0, -5);
        ids.push(id as WorkflowId);
      }
    }
    return Object.freeze(ids);
  }

  // ========================================================================
  // Private: JSON conversion
  // ========================================================================

  #stepToJson(step: import('../types').WorkflowStep): WorkflowStepJson {
    return {
      id: step.id as string,
      order: step.order,
      name: step.name,
      toolId: step.toolId as string,
      parameters: step.parameters,
      inputDatasetIds: step.inputDatasetIds.map((id) => id as string),
      outputDatasetId: step.outputDatasetId !== undefined
        ? (step.outputDatasetId as string)
        : undefined,
      executionModel: step.executionModel,
      resourceRequest: step.resourceRequest,
      state: step.state,
      toolInvocationId: step.toolInvocationId !== undefined
        ? (step.toolInvocationId as string)
        : undefined,
      jobId: step.jobId !== undefined
        ? (step.jobId as unknown as number)
        : undefined,
    };
  }

  #jsonToStep(json: WorkflowStepJson): import('../types').WorkflowStep {
    return Object.freeze({
      id: json.id as unknown as import('../types').WorkflowStepId,
      order: json.order,
      name: json.name,
      toolId: json.toolId as unknown as import('../types').ToolId,
      parameters: json.parameters,
      inputDatasetIds: json.inputDatasetIds.map(
        (id) => id as unknown as import('../types').DatasetId,
      ),
      outputDatasetId: json.outputDatasetId !== undefined
        ? (json.outputDatasetId as unknown as import('../types').DatasetId)
        : undefined,
      executionModel: json.executionModel as 'synchronous' | 'parallel',
      resourceRequest: json.resourceRequest,
      state: json.state as import('../types').WorkflowStep['state'],
      toolInvocationId: json.toolInvocationId !== undefined
        ? (json.toolInvocationId as unknown as import('../types').ToolInvocationId)
        : undefined,
      jobId: json.jobId !== undefined
        ? (json.jobId as unknown as import('../types').JobId)
        : undefined,
    });
  }
}
