/**
 * cera — AI agent for climate scientists on the Alps supercomputer.
 *
 * Built on DeepSeek Harness (dsh), a TypeScript/Node agent framework.
 * All 5 implementation phases are complete, plus the FirecREST
 * backend (ADR-011) for running cera on a laptop and accessing
 * Alps HPC resources via REST API.
 */

// Shared types (value objects, entities, events, errors)
export * from './types';

// Backends — dsh-adapter (local, Phase 1) and firecrest-adapter (remote, ADR-011)
export * from './dsh-adapter';
export * from './firecrest-adapter';

// Phase 2 modules
export * from './scheduling';
export * from './environment-management';
export * from './provenance';

// Phase 3 modules
export * from './data-management';

// Phase 4 modules
export * from './tool-invocation';

// Phase 5 modules
export * from './agent-interaction';
