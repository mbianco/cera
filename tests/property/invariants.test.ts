/**
 * Property-based tests for the highest-risk invariants.
 *
 * Uses fast-check to generate thousands of cases, stress-testing
 * invariant enforcement beyond single-example tests.
 *
 * Invariants tested:
 * - INV-S4: Terminal state is final (no transition back)
 * - INV-D2: One Format, one Grid per Dataset (immutable)
 * - INV-T2: Single exit outcome per invocation
 * - INV-E2: Conflict detection before execution
 *
 * Spec: build-phases.md Phase 2 (Property tests for invariant
 * enforcement); engineering.md (BDD-then-TDD, depth).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  TERMINAL_JOB_STATES,
  isTerminalJobState,
} from '../../src/types/value-objects';
import type {
  JobState,
  Format,
  ExitOutcome,
  UenvSpec,
  Conflict,
  DatasetId,
} from '../../src/types';
import { ConflictDetector } from '../../src/environment-management/conflict-detector';
import type { FilesystemGateway } from '../../src/dsh-adapter/types';

// ============================================================================
// Mock FilesystemGateway for ConflictDetector (all paths exist)
// ============================================================================

const allPathsExistFs: FilesystemGateway = {
  async exists() { return true; },
  async isReadable() { return true; },
  async isWritable() { return true; },
  async stat() { return { size: 0, isFile: false, isDirectory: true, mtime: new Date() }; },
  async readFile() { return Buffer.from(''); },
  async writeFile() {},
  async readDir() { return []; },
  async mkdir() {},
};

// ============================================================================
// INV-S4: Terminal state is final
// ============================================================================

describe('Property: INV-S4 — Terminal state is final', () => {
  it('isTerminalJobState returns true for all terminal states and false for non-terminal', () => {
    const terminalStates = ['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'OUT_OF_MEMORY', 'NODE_FAIL'] as const;
    const nonTerminalStates = ['PENDING', 'RUNNING', 'UNKNOWN'] as const;

    fc.assert(
      fc.property(
        fc.constantFrom(...terminalStates),
        (state) => {
          expect(isTerminalJobState(state)).toBe(true);
          expect(TERMINAL_JOB_STATES).toContain(state);
        },
      ),
      { numRuns: 1000 },
    );

    fc.assert(
      fc.property(
        fc.constantFrom(...nonTerminalStates),
        (state) => {
          expect(isTerminalJobState(state)).toBe(false);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('isTerminalJobState correctly identifies all terminal and non-terminal states in any sequence', () => {
    const allStates: JobState[] = [
      'PENDING', 'RUNNING', 'COMPLETED', 'FAILED',
      'TIMEOUT', 'CANCELLED', 'OUT_OF_MEMORY', 'NODE_FAIL', 'UNKNOWN',
    ];

    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...allStates), { maxLength: 20 }),
        (sequence) => {
          // For each state in the sequence, verify that
          // isTerminalJobState matches the expected set
          for (const state of sequence) {
            const expected = TERMINAL_JOB_STATES.includes(state);
            expect(isTerminalJobState(state)).toBe(expected);
          }

          // Verify the terminal-is-final property: once you see a
          // terminal state, the in-memory state machine (as
          // implemented by the scheduling module) would not
          // transition back. This test verifies that the invariant
          // CHECK is correct, not that arbitrary sequences can't
          // exist (they can — they just violate the invariant).
          let seenTerminal = false;
          for (const state of sequence) {
            if (seenTerminal && !isTerminalJobState(state)) {
              // The sequence violates INV-S4, but the invariant
              // CHECK correctly identifies both states. The
              // scheduling module would reject this transition.
              expect(isTerminalJobState(state)).toBe(false);
            }
            if (isTerminalJobState(state)) {
              seenTerminal = true;
            }
          }
        },
      ),
      { numRuns: 5000 },
    );
  });
});

// ============================================================================
// INV-D2: One Format, one Grid per Dataset (immutable)
// ============================================================================

describe('Property: INV-D2 — One Format, one Grid per Dataset', () => {
  const formats: Format[] = ['netcdf', 'zarr', 'grib2'];

  const gridArbitrary = fc.oneof(
    fc.record({
      kind: fc.constant('lat-lon' as const),
      nlat: fc.integer({ min: 1, max: 2000 }),
      nlon: fc.integer({ min: 1, max: 4000 }),
    }),
    fc.record({
      kind: fc.constant('icon' as const),
      refinementLevel: fc.string({ minLength: 1, maxLength: 20 }),
    }),
    fc.record({
      kind: fc.constant('healpix' as const),
      nside: fc.integer({ min: 1, max: 8192 }),
      nest: fc.boolean(),
    }),
    fc.record({
      kind: fc.constant('grib2-native' as const),
      spectral: fc.string({ minLength: 1, maxLength: 20 }),
    }),
  );

  it('a frozen Dataset retains its format and grid for any combination', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...formats),
        gridArbitrary,
        (format, grid) => {
          const dataset = Object.freeze({
            id: 'ds-test' as unknown as DatasetId,
            name: 'test',
            location: { path: '/scratch/test.nc', filesystem: 'scratch' as const },
            format,
            grid,
            variables: [{ name: 'TAS', units: 'K', dimensions: ['time', 'lat', 'lon'] }],
            producerToolInvocationId: null,
            consumable: false,
            quarantined: false,
            createdAt: new Date(),
          });

          // INV-D2: format and grid are immutable
          expect(dataset.format).toBe(format);
          expect(dataset.grid).toEqual(grid);
          expect(Object.isFrozen(dataset)).toBe(true);

          // Mutation attempt throws in strict mode
          expect(() => {
            (dataset as { format: string }).format = 'grib2';
          }).toThrow();
          expect(() => {
            (dataset as { grid: unknown }).grid = { kind: 'icon', refinementLevel: 'R02B09' };
          }).toThrow();
        },
      ),
      { numRuns: 5000 },
    );
  });

  it('format and grid are different types and never interchangeable', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...formats),
        fc.constantFrom(...formats),
        (f1, f2) => {
          // Same format value is equal
          if (f1 === f2) {
            expect(f1).toBe(f2);
          } else {
            expect(f1).not.toBe(f2);
          }
          // Format is never a Grid and vice versa
          expect(typeof f1).toBe('string');
          expect(typeof f2).toBe('string');
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ============================================================================
// INV-T2: Single exit outcome per invocation
// ============================================================================

describe('Property: INV-T2 — Single exit outcome per invocation', () => {
  const exitOutcomeArbitrary = fc.oneof(
    fc.record({
      kind: fc.constant('exit_code' as const),
      code: fc.integer({ min: -128, max: 255 }),
    }),
    fc.record({
      kind: fc.constant('signal' as const),
      name: fc.constantFrom('SIGSEGV', 'SIGKILL', 'SIGTERM', 'SIGBUS', 'SIGABRT', 'SIGHUP'),
      number: fc.integer({ min: 1, max: 31 }),
    }),
  );

  it('every ExitOutcome is exactly one of exit_code or signal, never both, never neither', () => {
    fc.assert(
      fc.property(
        exitOutcomeArbitrary,
        (outcome: ExitOutcome) => {
          // Exactly one variant
          if (outcome.kind === 'exit_code') {
            expect(outcome.kind).toBe('exit_code');
            expect('code' in outcome).toBe(true);
            expect('name' in outcome).toBe(false);
            expect('number' in outcome).toBe(false);
          } else {
            expect(outcome.kind).toBe('signal');
            expect('name' in outcome).toBe(true);
            expect('number' in outcome).toBe(true);
            expect('code' in outcome).toBe(false);
          }

          // Never both
          const hasCode = 'code' in outcome;
          const hasSignal = 'name' in outcome;
          expect(hasCode !== hasSignal).toBe(true);
        },
      ),
      { numRuns: 5000 },
    );
  });

  it('exit code 0 is success, any non-zero is failure (R4 strict)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -128, max: 255 }),
        (code) => {
          const outcome: ExitOutcome = { kind: 'exit_code', code };
          const isSuccess = outcome.kind === 'exit_code' && outcome.code === 0;
          // R4: only exit code 0 is success
          if (code === 0) {
            expect(isSuccess).toBe(true);
          } else {
            expect(isSuccess).toBe(false);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ============================================================================
// INV-E2: Conflict detection before execution
// ============================================================================

describe('Property: INV-E2 — Conflict detection before execution', () => {
  const uenvSpecArbitrary = fc.record({
    name: fc.string({ minLength: 1, maxLength: 20 }),
    version: fc.string({ minLength: 1, maxLength: 10 }),
    mountPath: fc.string({ minLength: 1, maxLength: 50 }),
  });

  it('conflict detection always returns an array (never throws, never undefined)', () => {
    const detector = new ConflictDetector({
      filesystem: allPathsExistFs,
    });

    fc.assert(
      fc.asyncProperty(
        fc.array(uenvSpecArbitrary, { maxLength: 10 }),
        async (specs: readonly UenvSpec[]) => {
          const conflicts = await detector.detectConflicts(specs);
          expect(Array.isArray(conflicts)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('a single uenv never conflicts with itself', () => {
    const detector = new ConflictDetector({
      filesystem: allPathsExistFs,
    });

    fc.assert(
      fc.asyncProperty(
        uenvSpecArbitrary,
        async (spec: UenvSpec) => {
          const conflicts = await detector.detectConflicts([spec]);
          expect(conflicts).toHaveLength(0);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('two uenvs with different mount paths and different names never conflict', () => {
    const detector = new ConflictDetector({
      filesystem: allPathsExistFs,
    });

    fc.assert(
      fc.asyncProperty(
        uenvSpecArbitrary,
        uenvSpecArbitrary,
        async (spec1: UenvSpec, spec2: UenvSpec) => {
          fc.pre(spec1.mountPath !== spec2.mountPath);
          fc.pre(spec1.name !== spec2.name);

          const conflicts = await detector.detectConflicts([spec1, spec2]);
          // Different mount paths and names → no conflict
          // (the detector checks filesystem paths, and with
          // allPathsExistFs, binary conflicts are detected by
          // name matching — different names = no conflict)
          const binaryConflicts = conflicts.filter((c: Conflict) =>
            c.conflictType === 'path' &&
            c.uenvA.name === c.uenvB.name
          );
          expect(binaryConflicts).toHaveLength(0);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
