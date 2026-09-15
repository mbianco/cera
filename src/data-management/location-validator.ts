/**
 * Location validation logic (C3 — Data Management).
 *
 * Validates that a Dataset's Location resolves to an existing,
 * readable path (for inputs) or a writable path (for outputs) at
 * the time of use (INV-D4). This is the enforcement point for
 * INV-D4, called by `tool-invocation.invokeTool()` immediately
 * before a ToolInvocation reads or writes.
 *
 * Failure modes handled:
 * - FM-D1: Quota exceeded — `DataQuotaExceeded` (if a `quotaChecker`
 *   is configured).
 * - FM-D2: Slow filesystem — `LocationNotReadable` or
 *   `LocationNotWritable` with `cause: 'slow'` if operations exceed
 *   the configured `slowThresholdMs`.
 * - FM-D3: File not found / permission denied —
 *   `LocationNotReadable` (read mode) or `LocationNotWritable`
 *   (write mode) with `cause: 'enoent' | 'eacces'`.
 *
 * Spec: invariants.md INV-D4; failure-modes.md FM-D1–D3;
 * error-taxonomy.md (C3 Data Management); api-contracts.md §5.
 */

import type { FilesystemGateway } from '../dsh-adapter/types';
import type { Location } from '../types';
import {
  LocationNotReadable,
  LocationNotWritable,
  DataQuotaExceeded,
} from '../types/errors';
import type { DataManagementConfig } from './types';
import { DEFAULT_DATA_MANAGEMENT_CONFIG } from './types';

// ============================================================================
// LocationValidatorProps
// ============================================================================

/**
 * Constructor parameters for LocationValidator.
 */
export interface LocationValidatorProps {
  readonly filesystem: FilesystemGateway;
  readonly config?: Partial<DataManagementConfig>;
}

// ============================================================================
// LocationValidator
// ============================================================================

/**
 * Validates Dataset Locations before use (INV-D4).
 *
 * Read mode: checks the path exists and is readable.
 * Write mode: checks the path is writable, or its parent directory
 * is writable for new files. Also checks for quota (FM-D1) if a
 * `quotaChecker` is configured.
 *
 * Slow filesystem (FM-D2): filesystem operations exceeding
 * `slowThresholdMs` are treated as slow, and
 * `LocationNotReadable`/`LocationNotWritable` with `cause: 'slow'`
 * is thrown.
 *
 * Spec: invariants.md INV-D4; failure-modes.md FM-D1–D3;
 * api-contracts.md §5.
 */
export class LocationValidator {
  #filesystem: FilesystemGateway;
  #config: DataManagementConfig;

  constructor(props: LocationValidatorProps) {
    this.#filesystem = props.filesystem;
    this.#config = { ...DEFAULT_DATA_MANAGEMENT_CONFIG, ...props.config };
  }

  // ========================================================================
  // validate (INV-D4)
  // ========================================================================

  /**
   * Validates that a Location resolves to an existing, readable
   * path (read mode) or a writable path (write mode) at the time
   * of use (INV-D4).
   *
   * @returns true if the Location is valid for the given mode.
   * @throws {LocationNotReadable} if read mode and the path does not
   *   exist (`cause: 'enoent'`) or is not readable
   *   (`cause: 'eacces'`), or if operations are slow
   *   (`cause: 'slow'`) — FM-D2, FM-D3.
   * @throws {LocationNotWritable} if write mode and the path is not
   *   writable (`cause: 'eacces'`), the parent does not exist
   *   (`cause: 'enoent'`), or operations are slow (`cause: 'slow'`)
   *   — FM-D2, FM-D3.
   * @throws {DataQuotaExceeded} if the filesystem reports quota
   *   exceeded (FM-D1) and a `quotaChecker` is configured.
   */
  async validate(
    location: Location,
    mode: 'read' | 'write',
  ): Promise<boolean> {
    if (mode === 'read') {
      return this.#validateRead(location);
    }
    return this.#validateWrite(location);
  }

  // ========================================================================
  // Private: read validation
  // ========================================================================

  /**
   * Validates the Location is readable: the path must exist and be
   * readable (INV-D4, FM-D3). Slow operations (FM-D2) are detected
   * by measuring elapsed time.
   */
  async #validateRead(location: Location): Promise<boolean> {
    const path = location.path;

    // Check existence — measure elapsed time (FM-D2)
    const existsStart = Date.now();
    const exists = await this.#filesystem.exists(path);
    const existsElapsed = Date.now() - existsStart;

    if (existsElapsed > this.#config.slowThresholdMs) {
      throw new LocationNotReadable({ path, cause: 'slow' });
    }

    if (!exists) {
      throw new LocationNotReadable({ path, cause: 'enoent' });
    }

    // Check readability — measure elapsed time (FM-D2)
    const readableStart = Date.now();
    const readable = await this.#filesystem.isReadable(path);
    const readableElapsed = Date.now() - readableStart;

    if (readableElapsed > this.#config.slowThresholdMs) {
      throw new LocationNotReadable({ path, cause: 'slow' });
    }

    if (!readable) {
      throw new LocationNotReadable({ path, cause: 'eacces' });
    }

    return true;
  }

  // ========================================================================
  // Private: write validation
  // ========================================================================

  /**
   * Validates the Location is writable: the path must be writable,
   * or its parent directory must be writable for new files (INV-D4,
   * FM-D3). Slow operations (FM-D2) are detected by measuring
   * elapsed time. Quota is checked if a `quotaChecker` is configured
   * (FM-D1).
   */
  async #validateWrite(location: Location): Promise<boolean> {
    const path = location.path;

    // Check if the path already exists — if so, it must be writable
    const existsStart = Date.now();
    const exists = await this.#filesystem.exists(path);
    const existsElapsed = Date.now() - existsStart;

    if (existsElapsed > this.#config.slowThresholdMs) {
      throw new LocationNotWritable({ path, cause: 'slow' });
    }

    if (exists) {
      // Path exists — check if it's writable
      const writableStart = Date.now();
      const writable = await this.#filesystem.isWritable(path);
      const writableElapsed = Date.now() - writableStart;

      if (writableElapsed > this.#config.slowThresholdMs) {
        throw new LocationNotWritable({ path, cause: 'slow' });
      }

      if (!writable) {
        throw new LocationNotWritable({ path, cause: 'eacces' });
      }
    } else {
      // Path doesn't exist — check if the parent directory is writable
      const parentPath = this.#getParentPath(path);
      const parentStart = Date.now();
      const parentExists = await this.#filesystem.exists(parentPath);
      const parentElapsed = Date.now() - parentStart;

      if (parentElapsed > this.#config.slowThresholdMs) {
        throw new LocationNotWritable({ path, cause: 'slow' });
      }

      if (!parentExists) {
        throw new LocationNotWritable({ path, cause: 'enoent' });
      }

      const parentWritableStart = Date.now();
      const parentWritable = await this.#filesystem.isWritable(parentPath);
      const parentWritableElapsed = Date.now() - parentWritableStart;

      if (parentWritableElapsed > this.#config.slowThresholdMs) {
        throw new LocationNotWritable({ path, cause: 'slow' });
      }

      if (!parentWritable) {
        throw new LocationNotWritable({ path, cause: 'eacces' });
      }
    }

    // FM-D1: Check quota if a quota checker is configured
    if (this.#config.quotaChecker !== undefined) {
      const quotaExceeded = await this.#config.quotaChecker(
        path,
        location.filesystem,
      );
      if (quotaExceeded) {
        throw new DataQuotaExceeded({
          path,
          filesystem: location.filesystem,
        });
      }
    }

    return true;
  }

  // ========================================================================
  // Private: parent path extraction
  // ========================================================================

  /**
   * Returns the parent directory path of the given path. For paths
   * with no parent (e.g., `/`), returns the path itself.
   */
  #getParentPath(path: string): string {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) return '/';
    return path.slice(0, lastSlash);
  }
}
