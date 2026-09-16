/**
 * Unit tests for ExperimentService.
 *
 * Verifies the Experiment lifecycle: create → add Workflows →
 * add Cases → query (R2, ADR-002). Experiment is a first-class
 * entity above Workflow — a grouping entity, NOT a DDD aggregate
 * root (ADR-002).
 *
 * Key behaviors tested:
 * - Experiment is created with a name and research question.
 * - A Workflow belongs to exactly one Experiment (R2).
 * - A Case belongs to exactly one Experiment (R2).
 * - addCaseToExperiment is the eventual consistency validation
 *   point for FINDING-02: if the Experiment does not exist,
 *   ExperimentNotFound is thrown.
 * - addCaseToExperiment throws CaseAlreadyAssigned if the Case
 *   is already assigned to another Experiment.
 * - An Experiment is long-lived: it survives Session end.
 *
 * Spec: build-phases.md Phase 5; api-contracts.md §7
 * (ExperimentService); invariants.md; resolutions.md R2;
 * ADR-002; FINDING-02.
 */

import { describe, it, expect } from 'vitest';
import { ExperimentServiceImpl } from '../../src/agent-interaction/experiment-service';
import type { ExperimentServiceImplProps } from '../../src/agent-interaction/experiment-service';
import type { ExperimentEvent } from '../../src/types';
import {
  WorkflowAlreadyAssigned,
  ExperimentNotFound,
  CaseAlreadyAssigned,
} from '../../src/types/errors';
import {
  createWorkflowId,
  createExperimentId,
  createCaseId,
} from '../../src/agent-interaction/types';

// ============================================================================
// Test setup helper
// ============================================================================

interface ExperimentServiceSetup {
  readonly service: ExperimentServiceImpl;
  readonly events: ExperimentEvent[];
}

function createExperimentService(): ExperimentServiceSetup {
  const events: ExperimentEvent[] = [];
  const props: ExperimentServiceImplProps = {
    onEvent: (event: ExperimentEvent) => {
      events.push(event);
    },
  };
  const service = new ExperimentServiceImpl(props);
  return { service, events };
}

// ============================================================================
// createExperiment (R2, ADR-002)
// ============================================================================

describe('ExperimentServiceImpl — createExperiment', () => {
  it('creates an Experiment with a name and research question', async () => {
    const { service } = createExperimentService();

    const experiment = await service.createExperiment({
      name: 'CO2 doubling sensitivity study',
      researchQuestion: 'How does doubling CO2 affect global mean temperature?',
    });

    expect(experiment.name).toBe('CO2 doubling sensitivity study');
    expect(experiment.researchQuestion).toBe(
      'How does doubling CO2 affect global mean temperature?',
    );
    expect(experiment.workflowIds).toEqual([]);
    expect(experiment.caseIds).toEqual([]);
    expect(experiment.createdAt).toBeInstanceOf(Date);
  });

  it('generates a unique ExperimentId', async () => {
    const { service } = createExperimentService();

    const exp1 = await service.createExperiment({
      name: 'Experiment 1',
      researchQuestion: 'Q1',
    });
    const exp2 = await service.createExperiment({
      name: 'Experiment 2',
      researchQuestion: 'Q2',
    });

    expect(exp1.id).not.toBe(exp2.id);
  });

  it('emits ExperimentCreated event', async () => {
    const { service, events } = createExperimentService();

    const experiment = await service.createExperiment({
      name: 'CO2 doubling',
      researchQuestion: 'How does CO2 affect temperature?',
    });

    const createdEvent = events.find((e) => e.kind === 'experiment_created');
    expect(createdEvent).toBeDefined();
    if (createdEvent?.kind === 'experiment_created') {
      expect(createdEvent.experimentId).toBe(experiment.id);
      expect(createdEvent.name).toBe('CO2 doubling');
      expect(createdEvent.researchQuestion).toBe(
        'How does CO2 affect temperature?',
      );
    }
  });
});

// ============================================================================
// addWorkflowToExperiment (R2, WorkflowAlreadyAssigned)
// ============================================================================

describe('ExperimentServiceImpl — addWorkflowToExperiment', () => {
  it('adds a Workflow to an Experiment', async () => {
    const { service } = createExperimentService();
    const experiment = await service.createExperiment({
      name: 'Exp 1',
      researchQuestion: 'Q1',
    });
    const workflowId = createWorkflowId('wf-001');

    await service.addWorkflowToExperiment(experiment.id, workflowId);

    const updated = await service.getExperiment(experiment.id);
    expect(updated?.workflowIds).toContain(workflowId);
  });

  it('emits ExperimentWorkflowAdded event', async () => {
    const { service, events } = createExperimentService();
    const experiment = await service.createExperiment({
      name: 'Exp 1',
      researchQuestion: 'Q1',
    });
    const workflowId = createWorkflowId('wf-001');

    await service.addWorkflowToExperiment(experiment.id, workflowId);

    const addedEvent = events.find((e) => e.kind === 'experiment_workflow_added');
    expect(addedEvent).toBeDefined();
    if (addedEvent?.kind === 'experiment_workflow_added') {
      expect(addedEvent.experimentId).toBe(experiment.id);
      expect(addedEvent.workflowId).toBe(workflowId);
    }
  });

  it('throws WorkflowAlreadyAssigned if the Workflow is already assigned to another Experiment', async () => {
    const { service } = createExperimentService();

    const exp1 = await service.createExperiment({
      name: 'Exp 1',
      researchQuestion: 'Q1',
    });
    const exp2 = await service.createExperiment({
      name: 'Exp 2',
      researchQuestion: 'Q2',
    });
    const workflowId = createWorkflowId('wf-001');

    // Assign to Exp 1
    await service.addWorkflowToExperiment(exp1.id, workflowId);

    // Attempting to assign to Exp 2 should throw
    await expect(
      service.addWorkflowToExperiment(exp2.id, workflowId),
    ).rejects.toThrow(WorkflowAlreadyAssigned);
  });

  it('allows adding multiple Workflows to the same Experiment', async () => {
    const { service } = createExperimentService();
    const experiment = await service.createExperiment({
      name: 'Exp 1',
      researchQuestion: 'Q1',
    });

    await service.addWorkflowToExperiment(experiment.id, createWorkflowId('wf-001'));
    await service.addWorkflowToExperiment(experiment.id, createWorkflowId('wf-002'));
    await service.addWorkflowToExperiment(experiment.id, createWorkflowId('wf-003'));

    const updated = await service.getExperiment(experiment.id);
    expect(updated?.workflowIds.length).toBe(3);
  });

  it('throws ExperimentNotFound if the Experiment does not exist', async () => {
    const { service } = createExperimentService();
    const workflowId = createWorkflowId('wf-001');
    const nonexistentId = createExperimentId('exp-does-not-exist');

    await expect(
      service.addWorkflowToExperiment(nonexistentId, workflowId),
    ).rejects.toThrow(ExperimentNotFound);
  });

  it('does not add the Workflow if it is already assigned (idempotency check)', async () => {
    const { service } = createExperimentService();
    const experiment = await service.createExperiment({
      name: 'Exp 1',
      researchQuestion: 'Q1',
    });
    const workflowId = createWorkflowId('wf-001');

    await service.addWorkflowToExperiment(experiment.id, workflowId);

    // Adding the same Workflow to the same Experiment should
    // either be a no-op or throw. The spec says "A Workflow
    // belongs to exactly one Experiment" — adding to the same
    // Experiment is fine (no-op).
    await service.addWorkflowToExperiment(experiment.id, workflowId);

    const updated = await service.getExperiment(experiment.id);
    // Should still have exactly 1 Workflow (not 2)
    expect(updated?.workflowIds.length).toBe(1);
  });
});

// ============================================================================
// addCaseToExperiment (FINDING-02, CaseAlreadyAssigned)
// ============================================================================

describe('ExperimentServiceImpl — addCaseToExperiment (FINDING-02)', () => {
  it('adds a Case to an Experiment', async () => {
    const { service } = createExperimentService();
    const experiment = await service.createExperiment({
      name: 'Exp 1',
      researchQuestion: 'Q1',
    });
    const caseId = createCaseId('case-001');

    await service.addCaseToExperiment(experiment.id, caseId);

    const updated = await service.getExperiment(experiment.id);
    expect(updated?.caseIds).toContain(caseId);
  });

  it('emits ExperimentCaseAdded event', async () => {
    const { service, events } = createExperimentService();
    const experiment = await service.createExperiment({
      name: 'Exp 1',
      researchQuestion: 'Q1',
    });
    const caseId = createCaseId('case-001');

    await service.addCaseToExperiment(experiment.id, caseId);

    const addedEvent = events.find((e) => e.kind === 'experiment_case_added');
    expect(addedEvent).toBeDefined();
    if (addedEvent?.kind === 'experiment_case_added') {
      expect(addedEvent.experimentId).toBe(experiment.id);
      expect(addedEvent.caseId).toBe(caseId);
    }
  });

  it('throws ExperimentNotFound if the Experiment does not exist (FINDING-02)', async () => {
    const { service } = createExperimentService();
    const caseId = createCaseId('case-001');
    const nonexistentId = createExperimentId('exp-does-not-exist');

    // FINDING-02: The Case was created in tool-invocation
    // WITHOUT synchronous validation of experimentId. Validation
    // happens asynchronously when addCaseToExperiment() is
    // called. If the Experiment does not exist,
    // ExperimentNotFound is thrown at this point.
    await expect(
      service.addCaseToExperiment(nonexistentId, caseId),
    ).rejects.toThrow(ExperimentNotFound);
  });

  it('throws CaseAlreadyAssigned if the Case is already assigned to another Experiment', async () => {
    const { service } = createExperimentService();

    const exp1 = await service.createExperiment({
      name: 'Exp 1',
      researchQuestion: 'Q1',
    });
    const exp2 = await service.createExperiment({
      name: 'Exp 2',
      researchQuestion: 'Q2',
    });
    const caseId = createCaseId('case-001');

    // Assign to Exp 1
    await service.addCaseToExperiment(exp1.id, caseId);

    // Attempting to assign to Exp 2 should throw
    await expect(
      service.addCaseToExperiment(exp2.id, caseId),
    ).rejects.toThrow(CaseAlreadyAssigned);
  });

  it('allows adding multiple Cases to the same Experiment', async () => {
    const { service } = createExperimentService();
    const experiment = await service.createExperiment({
      name: 'Exp 1',
      researchQuestion: 'Q1',
    });

    await service.addCaseToExperiment(experiment.id, createCaseId('case-001'));
    await service.addCaseToExperiment(experiment.id, createCaseId('case-002'));
    await service.addCaseToExperiment(experiment.id, createCaseId('case-003'));

    const updated = await service.getExperiment(experiment.id);
    expect(updated?.caseIds.length).toBe(3);
  });

  it('does not add the Case if it is already assigned to the same Experiment (idempotency)', async () => {
    const { service } = createExperimentService();
    const experiment = await service.createExperiment({
      name: 'Exp 1',
      researchQuestion: 'Q1',
    });
    const caseId = createCaseId('case-001');

    await service.addCaseToExperiment(experiment.id, caseId);
    await service.addCaseToExperiment(experiment.id, caseId);

    const updated = await service.getExperiment(experiment.id);
    expect(updated?.caseIds.length).toBe(1);
  });
});

// ============================================================================
// queryExperiments (R2)
// ============================================================================

describe('ExperimentServiceImpl — queryExperiments', () => {
  it('returns all Experiments when no filter is provided', async () => {
    const { service } = createExperimentService();

    await service.createExperiment({ name: 'Exp 1', researchQuestion: 'Q1' });
    await service.createExperiment({ name: 'Exp 2', researchQuestion: 'Q2' });
    await service.createExperiment({ name: 'Exp 3', researchQuestion: 'Q3' });

    const experiments = await service.queryExperiments();
    expect(experiments.length).toBe(3);
  });

  it('filters by name (exact match)', async () => {
    const { service } = createExperimentService();

    await service.createExperiment({ name: 'CO2 study', researchQuestion: 'Q1' });
    await service.createExperiment({ name: 'Temperature study', researchQuestion: 'Q2' });
    await service.createExperiment({ name: 'CO2 study v2', researchQuestion: 'Q3' });

    const experiments = await service.queryExperiments({ name: 'CO2 study' });
    expect(experiments.length).toBe(1);
    expect(experiments[0]?.name).toBe('CO2 study');
  });

  it('returns empty array when no Experiments match the filter', async () => {
    const { service } = createExperimentService();

    await service.createExperiment({ name: 'Exp 1', researchQuestion: 'Q1' });

    const experiments = await service.queryExperiments({ name: 'Nonexistent' });
    expect(experiments.length).toBe(0);
  });

  it('returns empty array when no Experiments exist', async () => {
    const { service } = createExperimentService();

    const experiments = await service.queryExperiments();
    expect(experiments.length).toBe(0);
  });
});

// ============================================================================
// getExperiment (R2)
// ============================================================================

describe('ExperimentServiceImpl — getExperiment', () => {
  it('returns the Experiment by ID', async () => {
    const { service } = createExperimentService();

    const experiment = await service.createExperiment({
      name: 'Exp 1',
      researchQuestion: 'Q1',
    });

    const retrieved = await service.getExperiment(experiment.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(experiment.id);
    expect(retrieved?.name).toBe('Exp 1');
  });

  it('returns null for an unknown Experiment ID', async () => {
    const { service } = createExperimentService();

    const retrieved = await service.getExperiment(
      createExperimentId('exp-does-not-exist'),
    );
    expect(retrieved).toBeNull();
  });

  it('returns the Experiment with its Workflows and Cases after additions', async () => {
    const { service } = createExperimentService();

    const experiment = await service.createExperiment({
      name: 'Exp 1',
      researchQuestion: 'Q1',
    });
    await service.addWorkflowToExperiment(experiment.id, createWorkflowId('wf-001'));
    await service.addCaseToExperiment(experiment.id, createCaseId('case-001'));

    const retrieved = await service.getExperiment(experiment.id);
    expect(retrieved?.workflowIds.length).toBe(1);
    expect(retrieved?.caseIds.length).toBe(1);
  });
});

// ============================================================================
// Experiment is long-lived (survives Session end)
// ============================================================================

describe('ExperimentServiceImpl — long-lived entity', () => {
  it('Experiment is retrievable after creation (long-lived)', async () => {
    const { service } = createExperimentService();

    const experiment = await service.createExperiment({
      name: 'CO2 study',
      researchQuestion: 'How does CO2 affect temperature?',
    });

    // An Experiment is long-lived: it survives Session end, like
    // Workflow and ProvenanceRecord (ADR-002). In this in-memory
    // implementation, the Experiment is always retrievable.
    const retrieved = await service.getExperiment(experiment.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.name).toBe('CO2 study');
  });
});
