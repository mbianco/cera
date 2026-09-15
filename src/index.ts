/**
 * cera — AI agent for climate scientists on the Alps supercomputer.
 *
 * Built on DeepSeek Harness (dsh), a TypeScript/Node agent framework.
 * Phase 1 (dsh-adapter), Phase 2 (scheduling, environment-management,
 * provenance), and Phase 3 (data-management) are implemented.
 */

// Shared types (value objects, entities, events, errors)
export * from './types';

// dsh-adapter module (Phase 1)
export * from './dsh-adapter';

// Phase 2 modules
export * from './scheduling';
export * from './environment-management';
export * from './provenance';

// Phase 3 modules
export * from './data-management';
