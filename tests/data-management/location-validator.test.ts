/**
 * Unit tests for LocationValidator.
 *
 * Verifies INV-D4 (Location resolves before use) and all
 * data-management failure modes:
 * - FM-D1: Quota exceeded
 * - FM-D2: Slow filesystem (cause: 'slow')
 * - FM-D3: File not found (cause: 'enoent'), permission denied
 *   (cause: 'eacces')
 *
 * Spec: build-phases.md Phase 3; invariants.md INV-D4;
 * failure-modes.md FM-D1–D3; error-taxonomy.md (C3 Data Management).
 */

import { describe, it, expect } from 'vitest';
import { LocationValidator } from '../../src/data-management/location-validator';
import {
  createMockFilesystem,
  createMockLocation,
} from './helpers';
import {
  LocationNotReadable,
  LocationNotWritable,
  DataQuotaExceeded,
} from '../../src/types/errors';
import type { DataManagementConfig } from '../../src/data-management/types';

// ============================================================================
// Read mode — INV-D4
// ============================================================================

describe('LocationValidator — read mode (INV-D4)', () => {
  it('returns true when the path exists and is readable', async () => {
    const fs = createMockFilesystem();
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 10_000 },
    });

    const result = await validator.validate(
      createMockLocation({ path: '/scratch/data/test.nc' }),
      'read',
    );

    expect(result).toBe(true);
  });

  it('throws LocationNotReadable with cause "enoent" when the path does not exist (FM-D3)', async () => {
    const fs = createMockFilesystem({
      nonExistentPaths: new Set(['/scratch/data/missing.nc']),
    });
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 10_000 },
    });

    await expect(
      validator.validate(
        createMockLocation({ path: '/scratch/data/missing.nc' }),
        'read',
      ),
    ).rejects.toThrow(LocationNotReadable);

    try {
      await validator.validate(
        createMockLocation({ path: '/scratch/data/missing.nc' }),
        'read',
      );
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LocationNotReadable);
      expect((error as LocationNotReadable).kind).toBe('location_not_readable');
      expect((error as LocationNotReadable).userMessage).toContain('enoent');
    }
  });

  it('throws LocationNotReadable with cause "eacces" when the path is not readable (FM-D3)', async () => {
    const fs = createMockFilesystem({
      existingPaths: new Set(['/scratch/data/protected.nc']),
      readablePaths: new Set([]), // no paths are readable
    });
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 10_000 },
    });

    await expect(
      validator.validate(
        createMockLocation({ path: '/scratch/data/protected.nc' }),
        'read',
      ),
    ).rejects.toThrow(LocationNotReadable);

    try {
      await validator.validate(
        createMockLocation({ path: '/scratch/data/protected.nc' }),
        'read',
      );
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LocationNotReadable);
      expect((error as LocationNotReadable).userMessage).toContain('eacces');
    }
  });

  it('calls fs.exists() and fs.isReadable() for read validation', async () => {
    const fs = createMockFilesystem();
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 10_000 },
    });

    await validator.validate(
      createMockLocation({ path: '/scratch/data/test.nc' }),
      'read',
    );

    expect(fs.existsCalls).toContain('/scratch/data/test.nc');
    expect(fs.isReadableCalls).toContain('/scratch/data/test.nc');
  });
});

// ============================================================================
// Write mode — INV-D4
// ============================================================================

describe('LocationValidator — write mode (INV-D4)', () => {
  it('returns true when the path exists and is writable', async () => {
    const fs = createMockFilesystem();
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 10_000 },
    });

    const result = await validator.validate(
      createMockLocation({ path: '/scratch/output/output.nc' }),
      'write',
    );

    expect(result).toBe(true);
  });

  it('returns true when the path does not exist but the parent directory is writable (new file)', async () => {
    const fs = createMockFilesystem({
      existingPaths: new Set(['/scratch/output']),
      writablePaths: new Set(['/scratch/output']),
      nonExistentPaths: new Set(['/scratch/output/new_file.nc']),
    });
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 10_000 },
    });

    const result = await validator.validate(
      createMockLocation({ path: '/scratch/output/new_file.nc' }),
      'write',
    );

    expect(result).toBe(true);
  });

  it('throws LocationNotWritable with cause "eacces" when the path is not writable (FM-D3)', async () => {
    const fs = createMockFilesystem({
      existingPaths: new Set(['/scratch/readonly/output.nc']),
      writablePaths: new Set([]), // no paths are writable
    });
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 10_000 },
    });

    await expect(
      validator.validate(
        createMockLocation({ path: '/scratch/readonly/output.nc' }),
        'write',
      ),
    ).rejects.toThrow(LocationNotWritable);

    try {
      await validator.validate(
        createMockLocation({ path: '/scratch/readonly/output.nc' }),
        'write',
      );
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LocationNotWritable);
      expect((error as LocationNotWritable).userMessage).toContain('eacces');
    }
  });

  it('throws LocationNotWritable with cause "enoent" when neither the path nor parent exists', async () => {
    const fs = createMockFilesystem({
      nonExistentPaths: new Set([
        '/scratch/nonexistent/output.nc',
        '/scratch/nonexistent',
      ]),
    });
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 10_000 },
    });

    await expect(
      validator.validate(
        createMockLocation({ path: '/scratch/nonexistent/output.nc' }),
        'write',
      ),
    ).rejects.toThrow(LocationNotWritable);

    try {
      await validator.validate(
        createMockLocation({ path: '/scratch/nonexistent/output.nc' }),
        'write',
      );
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LocationNotWritable);
      expect((error as LocationNotWritable).userMessage).toContain('enoent');
    }
  });

  it('calls fs.isWritable() for write validation', async () => {
    const fs = createMockFilesystem();
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 10_000 },
    });

    await validator.validate(
      createMockLocation({ path: '/scratch/output/output.nc' }),
      'write',
    );

    expect(fs.isWritableCalls).toContain('/scratch/output/output.nc');
  });
});

// ============================================================================
// FM-D1: Quota exceeded
// ============================================================================

describe('LocationValidator — FM-D1 (quota exceeded)', () => {
  it('throws DataQuotaExceeded when the quota checker reports exceeded (write mode)', async () => {
    const fs = createMockFilesystem();
    const config: DataManagementConfig = {
      slowThresholdMs: 10_000,
      quotaChecker: async () => true,
    };
    const validator = new LocationValidator({ filesystem: fs, config });

    await expect(
      validator.validate(
        createMockLocation({
          path: '/scratch/full/output.nc',
          filesystem: 'scratch',
        }),
        'write',
      ),
    ).rejects.toThrow(DataQuotaExceeded);

    try {
      await validator.validate(
        createMockLocation({
          path: '/scratch/full/output.nc',
          filesystem: 'scratch',
        }),
        'write',
      );
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DataQuotaExceeded);
      expect((error as DataQuotaExceeded).kind).toBe('data_quota_exceeded');
      expect((error as DataQuotaExceeded).userMessage).toContain('quota');
    }
  });

  it('passes the path and filesystem name to the quota checker', async () => {
    const fs = createMockFilesystem();
    let checkedPath = '';
    let checkedFilesystem = '';
    const config: DataManagementConfig = {
      slowThresholdMs: 10_000,
      quotaChecker: async (path, filesystem) => {
        checkedPath = path;
        checkedFilesystem = filesystem;
        return false;
      },
    };
    const validator = new LocationValidator({ filesystem: fs, config });

    await validator.validate(
      createMockLocation({
        path: '/scratch/data/output.nc',
        filesystem: 'scratch',
      }),
      'write',
    );

    expect(checkedPath).toBe('/scratch/data/output.nc');
    expect(checkedFilesystem).toBe('scratch');
  });

  it('does not check quota in read mode', async () => {
    const fs = createMockFilesystem();
    let quotaChecked = false;
    const config: DataManagementConfig = {
      slowThresholdMs: 10_000,
      quotaChecker: async () => {
        quotaChecked = true;
        return true;
      },
    };
    const validator = new LocationValidator({ filesystem: fs, config });

    await validator.validate(
      createMockLocation({ path: '/scratch/data/input.nc' }),
      'read',
    );

    expect(quotaChecked).toBe(false);
  });

  it('returns true when the quota checker reports not exceeded', async () => {
    const fs = createMockFilesystem();
    const config: DataManagementConfig = {
      slowThresholdMs: 10_000,
      quotaChecker: async () => false,
    };
    const validator = new LocationValidator({ filesystem: fs, config });

    const result = await validator.validate(
      createMockLocation({ path: '/scratch/output/output.nc' }),
      'write',
    );

    expect(result).toBe(true);
  });

  it('skips quota check when no quota checker is configured', async () => {
    const fs = createMockFilesystem();
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 10_000 },
    });

    const result = await validator.validate(
      createMockLocation({ path: '/scratch/output/output.nc' }),
      'write',
    );

    expect(result).toBe(true);
  });
});

// ============================================================================
// FM-D2: Slow filesystem
// ============================================================================

describe('LocationValidator — FM-D2 (slow filesystem)', () => {
  it('throws LocationNotReadable with cause "slow" when read operations exceed the threshold', async () => {
    const fs = createMockFilesystem({
      delays: { exists: 60, isReadable: 60 },
    });
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 50 },
    });

    await expect(
      validator.validate(
        createMockLocation({ path: '/scratch/slow/data.nc' }),
        'read',
      ),
    ).rejects.toThrow(LocationNotReadable);

    try {
      await validator.validate(
        createMockLocation({ path: '/scratch/slow/data.nc' }),
        'read',
      );
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LocationNotReadable);
      expect((error as LocationNotReadable).userMessage).toContain('slow');
    }
  });

  it('throws LocationNotWritable with cause "slow" when write operations exceed the threshold', async () => {
    const fs = createMockFilesystem({
      delays: { isWritable: 60 },
    });
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 50 },
    });

    await expect(
      validator.validate(
        createMockLocation({ path: '/scratch/slow/output.nc' }),
        'write',
      ),
    ).rejects.toThrow(LocationNotWritable);

    try {
      await validator.validate(
        createMockLocation({ path: '/scratch/slow/output.nc' }),
        'write',
      );
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LocationNotWritable);
      expect((error as LocationNotWritable).userMessage).toContain('slow');
    }
  });

  it('does not throw "slow" when operations complete within the threshold', async () => {
    const fs = createMockFilesystem({
      delays: { exists: 5, isReadable: 5 },
    });
    const validator = new LocationValidator({
      filesystem: fs,
      config: { slowThresholdMs: 50 },
    });

    const result = await validator.validate(
      createMockLocation({ path: '/scratch/fast/data.nc' }),
      'read',
    );

    expect(result).toBe(true);
  });
});

// ============================================================================
// Location with filesystem field
// ============================================================================

describe('LocationValidator — filesystem field', () => {
  it('passes the Location filesystem to the quota checker', async () => {
    const fs = createMockFilesystem();
    let receivedFilesystem = '';
    const config: DataManagementConfig = {
      slowThresholdMs: 10_000,
      quotaChecker: async (_path, filesystem) => {
        receivedFilesystem = filesystem;
        return false;
      },
    };
    const validator = new LocationValidator({ filesystem: fs, config });

    await validator.validate(
      createMockLocation({
        path: '/store/output/output.nc',
        filesystem: 'store',
      }),
      'write',
    );

    expect(receivedFilesystem).toBe('store');
  });
});
