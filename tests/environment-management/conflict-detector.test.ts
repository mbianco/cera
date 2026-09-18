/**
 * Unit tests for ConflictDetector.
 *
 * Verifies filesystem path conflict detection between uenvs (INV-E2).
 * Tests cover:
 * - No conflicts (complementary uenvs)
 * - Binary path conflicts (same binary, different mount paths)
 * - Library path conflicts (same library, different mount paths)
 * - Compiler conflicts (special case of binary conflict)
 * - Single uenv (no conflicts possible)
 * - Missing directories (no conflicts from unreadable directories)
 *
 * Spec: build-phases.md Phase 2; invariants.md INV-E2;
 * resolutions.md R9; ADR-003.
 */

import { describe, it, expect } from 'vitest';
import { ConflictDetector } from '../../src/environment-management/conflict-detector';
import {
  createMockFilesystem,
  createMockUenvSpec,
} from './helpers';
import type { Conflict } from '../../src/types';

// ============================================================================
// Helpers
// ============================================================================

function createDetector(
  dirs?: ReadonlyMap<string, readonly string[]>,
): ConflictDetector {
  return new ConflictDetector({
    filesystem: createMockFilesystem({ directories: dirs }),
  });
}

// ============================================================================
// No conflicts (complementary uenvs)
// ============================================================================

describe('@dev-only ConflictDetector — no conflicts', () => {
  it('returns empty array for complementary uenvs', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/cdo/2.0.5/usr/bin', ['cdo', 'ncdump']],
      ['/uenv/cdo/2.0.5/usr/lib', ['libnetcdf.so.4']],
      ['/uenv/python/3.11.6/usr/bin', ['python3', 'pip']],
      ['/uenv/python/3.11.6/usr/lib', ['libpython3.11.so']],
    ]);

    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({
        name: 'cdo',
        version: '2.0.5',
        mountPath: '/uenv/cdo/2.0.5',
      }),
      createMockUenvSpec({
        name: 'python',
        version: '3.11.6',
        mountPath: '/uenv/python/3.11.6',
      }),
    ]);

    expect(conflicts).toEqual([]);
  });

  it('returns empty array for a single uenv', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/cdo/2.0.5/usr/bin', ['cdo']],
    ]);

    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({ mountPath: '/uenv/cdo/2.0.5' }),
    ]);

    expect(conflicts).toEqual([]);
  });

  it('returns empty array for zero uenvs', async () => {
    const detector = createDetector();
    const conflicts = await detector.detectConflicts([]);

    expect(conflicts).toEqual([]);
  });
});

// ============================================================================
// Binary path conflicts (INV-E2)
// ============================================================================

describe('@dev-only ConflictDetector — binary path conflicts', () => {
  it('detects same binary at different mount paths', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/cdo-gcc/2.0.5/usr/bin', ['cdo', 'ncdump']],
      ['/uenv/cdo-intel/2.0.5/usr/bin', ['cdo', 'ncdump']],
    ]);

    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({
        name: 'cdo-gcc',
        version: '2.0.5',
        mountPath: '/uenv/cdo-gcc/2.0.5',
      }),
      createMockUenvSpec({
        name: 'cdo-intel',
        version: '2.0.5',
        mountPath: '/uenv/cdo-intel/2.0.5',
      }),
    ]);

    expect(conflicts.length).toBeGreaterThan(0);
    const cdoConflict = conflicts.find((c) => c.conflictPath === 'bin/cdo');
    expect(cdoConflict).toBeDefined();
    expect(cdoConflict?.conflictType).toBe('path');
  });

  it('conflict description includes both mount paths', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/a/1.0/usr/bin', ['cdo']],
      ['/uenv/b/1.0/usr/bin', ['cdo']],
    ]);

    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({ name: 'a', version: '1.0', mountPath: '/uenv/a/1.0' }),
      createMockUenvSpec({ name: 'b', version: '1.0', mountPath: '/uenv/b/1.0' }),
    ]);

    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.description).toContain('/uenv/a/1.0');
    expect(conflicts[0]?.description).toContain('/uenv/b/1.0');
  });
});

// ============================================================================
// Library path conflicts (INV-E2)
// ============================================================================

describe('@dev-only ConflictDetector — library path conflicts', () => {
  it('detects same library at different mount paths', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/netcdf-env/4.9.2/usr/lib', ['libnetcdf.so.4']],
      ['/uenv/netcdf-env/4.8.1/usr/lib', ['libnetcdf.so.4']],
    ]);

    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({
        name: 'netcdf-env',
        version: '4.9.2',
        mountPath: '/uenv/netcdf-env/4.9.2',
      }),
      createMockUenvSpec({
        name: 'netcdf-env',
        version: '4.8.1',
        mountPath: '/uenv/netcdf-env/4.8.1',
      }),
    ]);

    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.conflictPath).toBe('lib/libnetcdf.so.4');
    expect(conflicts[0]?.conflictType).toBe('library');
  });

  it('detects MPI library conflict (libmpi.so)', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/openmpi-env/4.1.4/usr/lib', ['libmpi.so.40']],
      ['/uenv/intel-mpi-env/2021.4/usr/lib', ['libmpi.so.20']],
    ]);

    // Different library names (libmpi.so.40 vs libmpi.so.20) — NOT a conflict
    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({
        name: 'openmpi-env',
        version: '4.1.4',
        mountPath: '/uenv/openmpi-env/4.1.4',
      }),
      createMockUenvSpec({
        name: 'intel-mpi-env',
        version: '2021.4',
        mountPath: '/uenv/intel-mpi-env/2021.4',
      }),
    ]);

    // Different library names = no conflict
    expect(conflicts).toEqual([]);
  });

  it('detects MPI library conflict (same library name)', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/openmpi-env/4.1.4/usr/lib', ['libmpi.so']],
      ['/uenv/intel-mpi-env/2021.4/usr/lib', ['libmpi.so']],
    ]);

    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({
        name: 'openmpi-env',
        version: '4.1.4',
        mountPath: '/uenv/openmpi-env/4.1.4',
      }),
      createMockUenvSpec({
        name: 'intel-mpi-env',
        version: '2021.4',
        mountPath: '/uenv/intel-mpi-env/2021.4',
      }),
    ]);

    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.conflictType).toBe('library');
  });
});

// ============================================================================
// Compiler conflicts (special case)
// ============================================================================

describe('@dev-only ConflictDetector — compiler conflicts', () => {
  it('detects compiler conflict (gcc in both uenvs)', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/cdo-gcc/2.0.5/usr/bin', ['cdo', 'gcc']],
      ['/uenv/cesm-intel/2.3.0/usr/bin', ['case.setup', 'gcc']],
    ]);

    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({
        name: 'cdo-gcc',
        version: '2.0.5',
        mountPath: '/uenv/cdo-gcc/2.0.5',
      }),
      createMockUenvSpec({
        name: 'cesm-intel',
        version: '2.3.0',
        mountPath: '/uenv/cesm-intel/2.3.0',
      }),
    ]);

    const gccConflict = conflicts.find(
      (c: Conflict) => c.conflictPath === 'bin/gcc',
    );
    expect(gccConflict).toBeDefined();
    expect(gccConflict?.conflictType).toBe('compiler');
  });

  it('detects compiler conflict (icc vs gcc)', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/gcc-env/11.2.0/usr/bin', ['gcc', 'g++']],
      ['/uenv/intel-env/2021.4/usr/bin', ['icc', 'g++']],
    ]);

    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({
        name: 'gcc-env',
        version: '11.2.0',
        mountPath: '/uenv/gcc-env/11.2.0',
      }),
      createMockUenvSpec({
        name: 'intel-env',
        version: '2021.4',
        mountPath: '/uenv/intel-env/2021.4',
      }),
    ]);

    // g++ appears in both — it's a compiler conflict
    const gppConflict = conflicts.find(
      (c: Conflict) => c.conflictPath === 'bin/g++',
    );
    expect(gppConflict).toBeDefined();
    expect(gppConflict?.conflictType).toBe('compiler');
  });
});

// ============================================================================
// Missing directories
// ============================================================================

describe('@dev-only ConflictDetector — missing directories', () => {
  it('does not conflict when one uenv has no bin directory', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/a/1.0/usr/bin', ['cdo']],
      // /uenv/b/1.0/usr/bin is missing
    ]);

    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({ name: 'a', version: '1.0', mountPath: '/uenv/a/1.0' }),
      createMockUenvSpec({ name: 'b', version: '1.0', mountPath: '/uenv/b/1.0' }),
    ]);

    // b has no bin directory — no binary conflicts possible
    expect(conflicts).toEqual([]);
  });

  it('does not conflict when both uenvs have no lib directory', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/a/1.0/usr/bin', ['cdo']],
      ['/uenv/b/1.0/usr/bin', ['python3']],
    ]);

    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({ name: 'a', version: '1.0', mountPath: '/uenv/a/1.0' }),
      createMockUenvSpec({ name: 'b', version: '1.0', mountPath: '/uenv/b/1.0' }),
    ]);

    // Different binaries, no libraries — no conflicts
    expect(conflicts).toEqual([]);
  });
});

// ============================================================================
// Same mount path (not a conflict)
// ============================================================================

describe('@dev-only ConflictDetector — same mount path', () => {
  it('does not conflict when both uenvs have the same mount path', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/shared/1.0/usr/bin', ['cdo']],
    ]);

    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({ name: 'shared', version: '1.0', mountPath: '/uenv/shared/1.0' }),
      createMockUenvSpec({ name: 'shared', version: '1.0', mountPath: '/uenv/shared/1.0' }),
    ]);

    // Same mount path = not a conflict
    expect(conflicts).toEqual([]);
  });
});

// ============================================================================
// Three-way comparison
// ============================================================================

describe('@dev-only ConflictDetector — three-way comparison', () => {
  it('detects conflicts between any pair in a three-uenv set', async () => {
    const dirs = new Map<string, readonly string[]>([
      ['/uenv/a/1.0/usr/bin', ['tool1', 'shared_tool']],
      ['/uenv/b/1.0/usr/bin', ['tool2', 'shared_tool']],
      ['/uenv/c/1.0/usr/bin', ['tool3']],
    ]);

    const detector = createDetector(dirs);
    const conflicts = await detector.detectConflicts([
      createMockUenvSpec({ name: 'a', version: '1.0', mountPath: '/uenv/a/1.0' }),
      createMockUenvSpec({ name: 'b', version: '1.0', mountPath: '/uenv/b/1.0' }),
      createMockUenvSpec({ name: 'c', version: '1.0', mountPath: '/uenv/c/1.0' }),
    ]);

    // Only a and b conflict (shared_tool)
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.uenvA.name).toBe('a');
    expect(conflicts[0]?.uenvB.name).toBe('b');
  });
});
