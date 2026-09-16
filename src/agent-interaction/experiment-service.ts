/**
 * ExperimentService implementation (C7).
 *
 * Manages Experiments — the top-level organizational unit for a
 * scientist's work (R2, ADR-002). An Experiment groups Workflows
 * and CESM Cases by a research question.
 *
 * Key design decisions (ADR-002):
 * - Experiment is a first-class entity above Workflow.
 * - A Workflow belongs to exactly one Experiment.
 * - A Case belongs to exactly one Experiment.
 * - Experiment is a grouping entity, NOT a DDD aggregate root.
 *   Workflows and Cases are referenced by identity.
 * - Experiment is long-lived: it survives Session end, like
 *   Workflow and ProvenanceRecord.
 * - `addCaseToExperiment` is the eventual consistency validation
 *   point for FINDING-02. If the Experiment does not exist,
 *   `ExperimentNotFound` is thrown. The Case itself was already
 *   created in `tool-invocation` without synchronous validation.
 *
 * Spec: api-contracts.md §7 (ExperimentService);
 * module-graph.md §7; resolutions.md R2; ADR-002;
 * FINDING-02.
 */

import type {
  CaseId,
  Experiment,
  ExperimentEvent,
  ExperimentId,
  WorkflowId,
} from '../types';
import {
  WorkflowAlreadyAssigned,
  ExperimentNotFound,
  CaseAlreadyAssigned,
} from '../types/errors';
import type { CreateExperimentInput, ExperimentFilter } from './types';
import { createExperimentId } from './types';

// ============================================================================
// ExperimentServiceImplProps
// ============================================================================

/**
 * Constructor parameters for ExperimentServiceImpl.
 *
 * `onEvent` — callback invoked when ExperimentEvents are
 * produced.
 */
export interface ExperimentServiceImplProps {
  readonly onEvent?: (event: ExperimentEvent) => void;
}

// ============================================================================
// Internal experiment tracking
// ============================================================================

/**
 * Internal mutable record tracking an Experiment and its
 * associated Workflow and Case IDs.
 *
 * `workflowAssignments` — maps WorkflowId (as string) to the
 * ExperimentId that owns it. Used to enforce "A Workflow belongs
 * to exactly one Experiment" (R2).
 *
 * `caseAssignments` — maps CaseId (as string) to the ExperimentId
 * that owns it. Used to enforce "A Case belongs to exactly one
 * Experiment" (R2).
 */
interface InternalExperimentRecord {
  experiment: Experiment;
  workflowIds: Set<string>;
  caseIds: Set<string>;
}

// ============================================================================
// ExperimentServiceImpl
// ============================================================================

/**
 * ExperimentService implementation.
 *
 * R2: Experiment is a first-class entity above Workflow. A
 * Workflow belongs to exactly one Experiment. A Case belongs to
 * exactly one Experiment.
 *
 * ADR-002: Experiment is a grouping entity, NOT a DDD aggregate
 * root. Workflows and Cases are referenced by identity.
 *
 * FINDING-02: `addCaseToExperiment` is the eventual consistency
 * validation point. The Case was created in tool-invocation
 * (Phase 4) without synchronous validation of experimentId.
 * Validation happens here: if the Experiment does not exist,
 * `ExperimentNotFound` is thrown.
 *
 * Spec: api-contracts.md §7; resolutions.md R2; ADR-002;
 * FINDING-02.
 */
export class ExperimentServiceImpl {
  #onEvent?: (event: ExperimentEvent) => void;
  #experiments: Map<string, InternalExperimentRecord> = new Map();
  #workflowAssignments: Map<string, string> = new Map();
  #caseAssignments: Map<string, string> = new Map();

  constructor(props: ExperimentServiceImplProps = {}) {
    this.#onEvent = props.onEvent;
  }

  // ========================================================================
  // createExperiment (R2, ADR-002)
  // ========================================================================

  /**
   * Creates a new Experiment (R2, ADR-002). An Experiment groups
   * Workflows and CESM Cases by a research question.
   *
   * Spec: api-contracts.md §7 (createExperiment).
   */
  async createExperiment(input: CreateExperimentInput): Promise<Experiment> {
    const id = createExperimentId(
      `exp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    const now = new Date();

    const experiment: Experiment = Object.freeze({
      id,
      name: input.name,
      researchQuestion: input.researchQuestion,
      workflowIds: [],
      caseIds: [],
      createdAt: now,
    });

    this.#experiments.set(id as string, {
      experiment,
      workflowIds: new Set<string>(),
      caseIds: new Set<string>(),
    });

    this.#emitEvent({
      kind: 'experiment_created',
      experimentId: id,
      name: input.name,
      researchQuestion: input.researchQuestion,
      timestamp: new Date(),
    });

    return experiment;
  }

  // ========================================================================
  // addWorkflowToExperiment (R2, WorkflowAlreadyAssigned)
  // ========================================================================

  /**
   * Adds a Workflow to an Experiment. A Workflow belongs to
   * exactly one Experiment (R2).
   *
   * @throws {ExperimentNotFound} if the Experiment does not exist.
   * @throws {WorkflowAlreadyAssigned} if the Workflow is already
   *   assigned to another Experiment.
   *
   * Spec: api-contracts.md §7 (addWorkflowToExperiment);
   * resolutions.md R2; ADR-002.
   */
  async addWorkflowToExperiment(
    experimentId: ExperimentId,
    workflowId: import('../types').WorkflowId,
  ): Promise<void> {
    const record = this.#experiments.get(experimentId as string);
    if (record === undefined) {
      throw new ExperimentNotFound({
        experimentId: experimentId as string,
        workflowId: workflowId as string,
      });
    }

    const workflowIdStr = workflowId as string;
    const existingExpId = this.#workflowAssignments.get(workflowIdStr);

    if (existingExpId !== undefined) {
      if (existingExpId === (experimentId as string)) {
        // Already assigned to the same Experiment — no-op
        return;
      }
      // Already assigned to a different Experiment
      throw new WorkflowAlreadyAssigned({
        workflowId: workflowIdStr,
        existingExperimentId: existingExpId,
      });
    }

    // Assign the Workflow to this Experiment
    this.#workflowAssignments.set(workflowIdStr, experimentId as string);
    record.workflowIds.add(workflowIdStr);

    // Update the Experiment with the new workflowIds
    this.#updateExperiment(record);

    this.#emitEvent({
      kind: 'experiment_workflow_added',
      experimentId,
      workflowId,
      timestamp: new Date(),
    });
  }

  // ========================================================================
  // addCaseToExperiment (FINDING-02, CaseAlreadyAssigned)
  // ========================================================================

  /**
   * Adds a Case to an Experiment. A Case belongs to exactly one
   * Experiment (R2).
   *
   * This is the eventual consistency validation point for
   * FINDING-02. The Case was created in tool-invocation (Phase 4)
   * WITHOUT synchronous validation of experimentId — the
   * dependency graph prohibits tool-invocation from importing
   * agent-interaction. Validation happens here: if the Experiment
   * does not exist, `ExperimentNotFound` is thrown. The Case
   * itself remains valid in C1.
   *
   * @throws {ExperimentNotFound} if the Experiment does not exist
   *   (FINDING-02, eventual consistency).
   * @throws {CaseAlreadyAssigned} if the Case is already assigned
   *   to another Experiment.
   *
   * Spec: api-contracts.md §7 (addCaseToExperiment);
   * resolutions.md R2; ADR-002; FINDING-02.
   */
  async addCaseToExperiment(
    experimentId: ExperimentId,
    caseId: import('../types').CaseId,
  ): Promise<void> {
    const record = this.#experiments.get(experimentId as string);
    if (record === undefined) {
      // FINDING-02: The Case was created in tool-invocation
      // without synchronous validation. The Experiment does not
      // exist — throw ExperimentNotFound.
      throw new ExperimentNotFound({
        experimentId: experimentId as string,
        caseId,
      });
    }

    const caseIdStr = caseId as string;
    const existingExpId = this.#caseAssignments.get(caseIdStr);

    if (existingExpId !== undefined) {
      if (existingExpId === (experimentId as string)) {
        // Already assigned to the same Experiment — no-op
        return;
      }
      // Already assigned to a different Experiment
      throw new CaseAlreadyAssigned({
        caseId,
        requestedExperimentId: experimentId as string,
        existingExperimentId: existingExpId,
      });
    }

    // Assign the Case to this Experiment
    this.#caseAssignments.set(caseIdStr, experimentId as string);
    record.caseIds.add(caseIdStr);

    // Update the Experiment with the new caseIds
    this.#updateExperiment(record);

    this.#emitEvent({
      kind: 'experiment_case_added',
      experimentId,
      caseId,
      timestamp: new Date(),
    });
  }

  // ========================================================================
  // queryExperiments (R2)
  // ========================================================================

  /**
   * Queries Experiments. Returns all Experiments that match the
   * specified filter fields (AND semantics). Unspecified fields
   * are not filtered.
   *
   * Spec: api-contracts.md §7 (queryExperiments).
   */
  async queryExperiments(filter?: ExperimentFilter): Promise<readonly Experiment[]> {
    const experiments = Array.from(this.#experiments.values()).map(
      (r) => r.experiment,
    );

    if (filter === undefined) {
      return Object.freeze(experiments);
    }

    const filtered = experiments.filter((exp) => {
      if (filter.name !== undefined && exp.name !== filter.name) {
        return false;
      }
      return true;
    });

    return Object.freeze(filtered);
  }

  // ========================================================================
  // getExperiment (R2)
  // ========================================================================

  /**
   * Retrieves an Experiment by identity. Returns null if the
   * Experiment does not exist.
   *
   * An Experiment is long-lived: it survives Session end, like
   * Workflow and ProvenanceRecord (ADR-002).
   *
   * Spec: api-contracts.md §7 (getExperiment).
   */
  async getExperiment(id: ExperimentId): Promise<Experiment | null> {
    const record = this.#experiments.get(id as string);
    if (record === undefined) {
      return null;
    }
    return record.experiment;
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /**
   * Updates the stored Experiment with the latest workflowIds and
   * caseIds.
   *
   * The Experiment type is immutable (all fields readonly), so
   * a new frozen object is created with the updated arrays.
   */
  #updateExperiment(record: InternalExperimentRecord): void {
    // The internal Sets store IDs as plain strings (used as Map
    // keys). They are cast back to their branded types via
    // `unknown` because branded IDs are a `string & { brand }`
    // intersection that does not overlap with `string` directly.
    const updated: Experiment = Object.freeze({
      ...record.experiment,
      workflowIds: Array.from(record.workflowIds) as unknown as readonly WorkflowId[],
      caseIds: Array.from(record.caseIds) as unknown as readonly CaseId[],
    });
    record.experiment = updated;
  }

  /**
   * Emits an ExperimentEvent to the onEvent callback.
   */
  #emitEvent(event: ExperimentEvent): void {
    this.#onEvent?.(event);
  }
}
