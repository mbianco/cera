/**
 * Conflict detector for uenvs (C5 — Environment Management).
 *
 * Detects filesystem path conflicts between uenvs at the PATH and
 * LD_LIBRARY_PATH level (INV-E2, updated for uenv per ADR-003).
 *
 * Two uenvs conflict if they provide the same binary or library at
 * different mount paths. When both uenvs are mounted, the same
 * binary or library name would appear in PATH or LD_LIBRARY_PATH
 * at two different paths, causing ambiguous resolution.
 *
 * The detector uses `FilesystemGateway` to inspect the contents of
 * each uenv's `usr/bin` (binaries) and `usr/lib` (libraries)
 * directories. For unit tests, the FilesystemGateway is mocked.
 *
 * Conflict types:
 * - `path`: Binary path conflict — same binary name in both
 *   uenvs' `usr/bin` directories.
 * - `library`: Library path conflict — same library name in both
 *   uenvs' `usr/lib` directories.
 * - `compiler`: Compiler conflict — same compiler binary in both
 *   uenvs (a special case of `path`).
 *
 * Spec: api-contracts.md §3; module-graph.md §3; invariants.md
 * INV-E2; resolutions.md R9; ADR-003.
 */

import type {
  FilesystemGateway,
} from '../dsh-adapter/types';
import type {
  Conflict,
  UenvSpec,
} from '../types';

// ============================================================================
// Constants
// ============================================================================

/**
 * Subdirectory within a uenv mount that contains binaries.
 * When a uenv is mounted, `<mountPath>/usr/bin` is added to PATH.
 */
const BIN_SUBDIR = '/usr/bin';

/**
 * Subdirectory within a uenv mount that contains libraries.
 * When a uenv is mounted, `<mountPath>/usr/lib` is added to
 * LD_LIBRARY_PATH.
 */
const LIB_SUBDIR = '/usr/lib';

/**
 * Compiler binary names that trigger a `compiler` conflict type
 * (instead of `path`). These are the most critical conflicts —
 * two different compilers in the same Environment would cause
 * build failures.
 */
const COMPILER_BINARIES: ReadonlySet<string> = new Set([
  'gcc',
  'g++',
  'gfortran',
  'cc',
  'c++',
  'fc',
  'icc',
  'icpc',
  'ifort',
  'clang',
  'clang++',
]);

// ============================================================================
// UenvContents
// ============================================================================

/**
 * The contents of a uenv mount: binaries and libraries.
 * `undefined` means the directory was not found or not readable.
 */
interface UenvContents {
  readonly binaries: ReadonlySet<string> | undefined;
  readonly libraries: ReadonlySet<string> | undefined;
}

// ============================================================================
// ConflictDetector
// ============================================================================

/**
 * Constructor parameters for ConflictDetector.
 */
export interface ConflictDetectorProps {
  readonly filesystem: FilesystemGateway;
}

/**
 * Detects filesystem path conflicts between uenvs (INV-E2).
 *
 * The detector inspects each uenv's `usr/bin` and `usr/lib`
 * directories via `FilesystemGateway` and finds overlapping
 * binary or library names. Two uenvs with the same binary or
 * library at different mount paths would cause ambiguous PATH
 * or LD_LIBRARY_PATH resolution.
 *
 * Spec: api-contracts.md §3; invariants.md INV-E2; ADR-003.
 */
export class ConflictDetector {
  #filesystem: FilesystemGateway;

  constructor(props: ConflictDetectorProps) {
    this.#filesystem = props.filesystem;
  }

  /**
   * Detects conflicts between a list of uenv specs.
   *
   * For each pair of uenvs, checks if they provide the same
   * binary or library at different mount paths. Returns a list
   * of conflicts (empty if no conflicts).
   *
   * @returns Array of conflicts. An empty array means all uenvs
   *   are complementary and can be mounted simultaneously.
   *
   * Spec: api-contracts.md §3; invariants.md INV-E1, INV-E2;
   * ADR-003.
   */
  async detectConflicts(uenvSpecs: readonly UenvSpec[]): Promise<Conflict[]> {
    if (uenvSpecs.length < 2) {
      return [];
    }

    // Read the contents of each uenv
    const contentsList = await Promise.all(
      uenvSpecs.map((spec) => this.#readUenvContents(spec)),
    );

    // Compare each pair
    const conflicts: Conflict[] = [];
    for (let i = 0; i < uenvSpecs.length; i++) {
      for (let j = i + 1; j < uenvSpecs.length; j++) {
        const specA = uenvSpecs[i];
        const specB = uenvSpecs[j];
        const contentsA = contentsList[i];
        const contentsB = contentsList[j];

        if (specA === undefined || specB === undefined) continue;
        if (contentsA === undefined || contentsB === undefined) continue;

        // Skip if both uenvs have the same mount path (not a conflict)
        if (specA.mountPath === specB.mountPath) continue;

        // Check binary conflicts
        const binaryConflicts = this.#findOverlappingNames(
          contentsA.binaries,
          contentsB.binaries,
        );
        for (const name of binaryConflicts) {
          conflicts.push({
            uenvA: specA,
            uenvB: specB,
            conflictPath: `bin/${name}`,
            conflictType: COMPILER_BINARIES.has(name)
              ? 'compiler'
              : 'path',
            description: `Both uenvs provide binary '${name}' at different mount paths (${specA.mountPath}${BIN_SUBDIR}/${name} vs ${specB.mountPath}${BIN_SUBDIR}/${name})`,
          });
        }

        // Check library conflicts
        const libraryConflicts = this.#findOverlappingNames(
          contentsA.libraries,
          contentsB.libraries,
        );
        for (const name of libraryConflicts) {
          conflicts.push({
            uenvA: specA,
            uenvB: specB,
            conflictPath: `lib/${name}`,
            conflictType: 'library',
            description: `Both uenvs provide library '${name}' at different mount paths (${specA.mountPath}${LIB_SUBDIR}/${name} vs ${specB.mountPath}${LIB_SUBDIR}/${name})`,
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Reads the contents of a uenv mount: the set of binary names
   * in `<mountPath>/usr/bin` and the set of library names in
   * `<mountPath>/usr/lib`.
   *
   * If a directory does not exist or is not readable, that set is
   * `undefined` (no conflicts from that directory).
   */
  async #readUenvContents(spec: UenvSpec): Promise<UenvContents> {
    const binPath = spec.mountPath + BIN_SUBDIR;
    const libPath = spec.mountPath + LIB_SUBDIR;

    const [binaries, libraries] = await Promise.all([
      this.#readDirSafe(binPath),
      this.#readDirSafe(libPath),
    ]);

    return { binaries, libraries };
  }

  /**
   * Reads a directory and returns the set of file names.
   * Returns `undefined` if the directory does not exist or is
   * not readable.
   */
  async #readDirSafe(path: string): Promise<ReadonlySet<string> | undefined> {
    try {
      const exists = await this.#filesystem.exists(path);
      if (!exists) {
        return undefined;
      }
      const isReadable = await this.#filesystem.isReadable(path);
      if (!isReadable) {
        return undefined;
      }
      const entries = await this.#filesystem.readDir(path);
      return new Set(entries);
    } catch {
      return undefined;
    }
  }

  /**
   * Finds names that appear in both sets. Returns an empty array
   * if either set is undefined or empty.
   */
  #findOverlappingNames(
    setA: ReadonlySet<string> | undefined,
    setB: ReadonlySet<string> | undefined,
  ): string[] {
    if (setA === undefined || setB === undefined) {
      return [];
    }
    if (setA.size === 0 || setB.size === 0) {
      return [];
    }
    const overlapping: string[] = [];
    for (const name of setA) {
      if (setB.has(name)) {
        overlapping.push(name);
      }
    }
    return overlapping;
  }
}
