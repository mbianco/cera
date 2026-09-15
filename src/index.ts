/**
 * cera — AI agent for climate scientists on the Alps supercomputer.
 *
 * Built on DeepSeek Harness (dsh), a TypeScript/Node agent framework.
 * Phase 1 (dsh-adapter) is the only module implemented so far.
 *
 * Spec: build-phases.md; module-graph.md; ADR-005.
 */

// Shared types (value objects, entities, events, errors)
export * from './types';

// dsh-adapter module (Phase 1)
export * from './dsh-adapter';
