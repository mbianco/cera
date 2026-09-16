/**
 * Tests for the FirecREST FilesystemGateway (F-INV-4).
 *
 * Verifies:
 * - exists(), isReadable(), isWritable(), stat()
 * - readFile() ≤5MB (synchronous)
 * - readFile() >5MB (async, falls back to /transfer/)
 * - writeFile() ≤5MB (synchronous)
 * - writeFile() >5MB (async)
 * - readDir(), mkdir()
 * - F-INV-4: file size check before transfer
 *
 * Spec: specs/firecrest/invariants.md F-INV-4;
 * specs/firecrest/features/firecrest-backend.feature;
 * ADR-011.
 */

import { describe, it, expect } from 'vitest';
import { FirecrestFilesystemGateway } from '../../src/firecrest-adapter/filesystem-gateway';
import type { FirecrestFileStatResponse, FirecrestDirEntry } from '../../src/firecrest-adapter/types';
import type { FileStat, FilesystemGateway } from '../../src/dsh-adapter/types';
import {
  createMockFirecrestClient,
  createMockFirecrestFileStat,
  createMockDirEntry,
  createMockTransferResponse,
} from './helpers';

const systemName = 'daint';
const basePath = '/scratch/snx3000/cera_user';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a mock client configured for stat responses.
 */
function createStatMockClient(
  systemName: string,
  statResponses: { readonly path: string; readonly stat: FirecrestFileStatResponse | null }[],
): ReturnType<typeof createMockFirecrestClient> {
  const responses = statResponses.map(({ path, stat }) => ({
    method: 'get',
    pathPattern: `/filesystem/${systemName}/stat/${path}`,
    statusCode: stat !== null ? 200 : 404,
    body: stat ?? { error: 'not found' },
  }));

  return createMockFirecrestClient({ responses });
}

// ============================================================================
// exists, isReadable, isWritable, stat
// ============================================================================

describe('FirecrestFilesystemGateway — stat operations', () => {
  describe('exists()', () => {
    it('returns true when GET /stat returns 200', async () => {
      const client = createStatMockClient(systemName, [
        { path: basePath, stat: createMockFirecrestFileStat() },
      ]);

      const gw = new FirecrestFilesystemGateway(client, systemName);
      const result = await gw.exists(basePath);

      expect(result).toBe(true);
    });

    it('returns false when GET /stat returns 404', async () => {
      const client = createStatMockClient(systemName, [
        { path: `${basePath}/nonexistent`, stat: null },
      ]);

      const gw = new FirecrestFilesystemGateway(client, systemName);
      const result = await gw.exists(`${basePath}/nonexistent`);

      expect(result).toBe(false);
    });
  });

  describe('isReadable()', () => {
    it('returns true when GET /stat returns 200 (FirecREST checks server-side)', async () => {
      const client = createStatMockClient(systemName, [
        { path: basePath, stat: createMockFirecrestFileStat() },
      ]);

      const gw = new FirecrestFilesystemGateway(client, systemName);
      const result = await gw.isReadable(basePath);

      expect(result).toBe(true);
    });

    it('returns false when GET /stat returns 404', async () => {
      const client = createStatMockClient(systemName, [
        { path: `${basePath}/gone`, stat: null },
      ]);

      const gw = new FirecrestFilesystemGateway(client, systemName);
      const result = await gw.isReadable(`${basePath}/gone`);

      expect(result).toBe(false);
    });
  });

  describe('isWritable()', () => {
    it('returns true when parent directory exists and is a directory', async () => {
      const client = createStatMockClient(systemName, [
        {
          path: basePath,
          stat: createMockFirecrestFileStat({ isDir: true }),
        },
      ]);

      const gw = new FirecrestFilesystemGateway(client, systemName);
      const result = await gw.isWritable(`${basePath}/new_file.txt`);

      expect(result).toBe(true);
    });

    it('returns false when parent directory does not exist', async () => {
      const client = createStatMockClient(systemName, [
        { path: `${basePath}/nope`, stat: null },
      ]);

      const gw = new FirecrestFilesystemGateway(client, systemName);
      const result = await gw.isWritable(`${basePath}/nope/new_file.txt`);

      expect(result).toBe(false);
    });

    it('returns false when parent is a file, not a directory', async () => {
      const client = createStatMockClient(systemName, [
        {
          path: `${basePath}/data.nc`,
          stat: createMockFirecrestFileStat({ isDir: false }),
        },
      ]);

      const gw = new FirecrestFilesystemGateway(client, systemName);
      const result = await gw.isWritable(`${basePath}/data.nc/new_file.txt`);

      expect(result).toBe(false);
    });
  });

  describe('stat()', () => {
    it('maps FirecrestFileStatResponse to FileStat', async () => {
      const client = createStatMockClient(systemName, [
        {
          path: `${basePath}/data/input.nc`,
          stat: createMockFirecrestFileStat({
            size: 1073741824,
            isDir: false,
            mtime: '2026-09-15T10:30:00Z',
          }),
        },
      ]);

      const gw = new FirecrestFilesystemGateway(client, systemName);
      const stat = await gw.stat(`${basePath}/data/input.nc`);

      expect(stat.size).toBe(1073741824);
      expect(stat.isFile).toBe(true);
      expect(stat.isDirectory).toBe(false);
      expect(stat.mtime).toEqual(new Date('2026-09-15T10:30:00Z'));
    });

    it('maps directory stat correctly', async () => {
      const client = createStatMockClient(systemName, [
        {
          path: `${basePath}/data`,
          stat: createMockFirecrestFileStat({
            size: 4096,
            isDir: true,
            mtime: '2026-09-15T10:30:00Z',
          }),
        },
      ]);

      const gw = new FirecrestFilesystemGateway(client, systemName);
      const stat = await gw.stat(`${basePath}/data`);

      expect(stat.isFile).toBe(false);
      expect(stat.isDirectory).toBe(true);
    });

    it('throws when GET /stat returns 404', async () => {
      const client = createStatMockClient(systemName, [
        { path: `${basePath}/nonexistent.nc`, stat: null },
      ]);

      const gw = new FirecrestFilesystemGateway(client, systemName);

      await expect(gw.stat(`${basePath}/nonexistent.nc`)).rejects.toThrow();
    });
  });
});

// ============================================================================
// readFile — synchronous (≤5MB) and async (>5MB)
// ============================================================================

describe('FirecrestFilesystemGateway — readFile (F-INV-4)', () => {
  it('uses synchronous download for files ≤5MB', async () => {
    const client = createStatMockClient(systemName, [
      {
        path: `${basePath}/config.json`,
        stat: createMockFirecrestFileStat({ size: 2_500_000, isDir: false }),
      },
    ]);
    client.downloadMock.mockImplementation(async (path: string) => {
      client.calls.push({ method: 'download', path });
      return Buffer.from('{"key": "value"}');
    });

    const gw = new FirecrestFilesystemGateway(client, systemName);
    const data = await gw.readFile(`${basePath}/config.json`);

    expect(data.toString()).toBe('{"key": "value"}');
    // Verify synchronous download was used
    const downloadCalls = client.calls.filter((c) => c.method === 'download');
    expect(downloadCalls.length).toBe(1);
    expect(downloadCalls[0]?.path).toContain('/ops/download');
    expect(downloadCalls[0]?.path).toContain(`${basePath}/config.json`);
  });

  it('uses async transfer for files >5MB (F-INV-4)', async () => {
    const client = createStatMockClient(systemName, [
      {
        path: `${basePath}/large_data.nc`,
        stat: createMockFirecrestFileStat({ size: 500_000_000, isDir: false }),
      },
    ]);

    // Mock the transfer POST response
    const transferResponse = createMockTransferResponse({
      transferJob: { jobId: 9999001, system: 'daint' },
      transferDirectives: {
        transfer_method: 'streamer',
        download_url: '/filesystem/daint/transfer/download/9999001/streamer',
      },
    });

    client.postMock.mockImplementation(async (path: string, body?: unknown) => {
      client.calls.push({ method: 'post', path, body });
      if (path.includes('/transfer/download')) {
        return { statusCode: 200, body: transferResponse };
      }
      return { statusCode: 200, body: {} };
    });

    // Mock the transfer poll GET response (completed)
    client.getMock.mockImplementation(async (path: string) => {
      client.calls.push({ method: 'get', path });
      // First GET: stat (already handled by createStatMockClient)
      // For stat, return the stat
      if (path.includes('/stat/')) {
        return {
          statusCode: 200,
          body: createMockFirecrestFileStat({ size: 500_000_000, isDir: false }),
        };
      }
      // For transfer poll, return completed status
      if (path.includes('/transfer/')) {
        return {
          statusCode: 200,
          body: { status: 'completed', download_url: '/filesystem/daint/transfer/download/9999001/streamer' },
        };
      }
      return { statusCode: 200, body: {} };
    });

    // Mock the download (for retrieving the file after transfer)
    client.downloadMock.mockImplementation(async (path: string) => {
      client.calls.push({ method: 'download', path });
      return Buffer.from('large file content');
    });

    const gw = new FirecrestFilesystemGateway(client, systemName, { pollIntervalMs: 1 });
    const data = await gw.readFile(`${basePath}/large_data.nc`);

    expect(data.toString()).toBe('large file content');
    // Verify async transfer was used (POST to /transfer/download)
    const postCalls = client.calls.filter((c) => c.method === 'post');
    expect(postCalls.some((c) => c.path.includes('/transfer/download'))).toBe(true);
    // Verify synchronous download was NOT used for the initial download
    const downloadCalls = client.calls.filter((c) => c.method === 'download');
    // download might be used for retrieval, but NOT for the initial download
    expect(downloadCalls.every((c) => !c.path.includes('/ops/download'))).toBe(true);
  });

  it('stats the file before download (F-INV-4)', async () => {
    const client = createStatMockClient(systemName, [
      {
        path: `${basePath}/file.txt`,
        stat: createMockFirecrestFileStat({ size: 1024, isDir: false }),
      },
    ]);
    client.downloadMock.mockImplementation(async (path: string) => {
      client.calls.push({ method: 'download', path });
      return Buffer.from('content');
    });

    const gw = new FirecrestFilesystemGateway(client, systemName);
    await gw.readFile(`${basePath}/file.txt`);

    // Verify stat was called before download
    const statIdx = client.calls.findIndex((c) => c.method === 'get' && c.path.includes('/stat/'));
    const downloadIdx = client.calls.findIndex((c) => c.method === 'download');
    expect(statIdx).toBeGreaterThanOrEqual(0);
    expect(downloadIdx).toBeGreaterThanOrEqual(0);
    expect(statIdx).toBeLessThan(downloadIdx);
  });
});

// ============================================================================
// writeFile — synchronous (≤5MB) and async (>5MB)
// ============================================================================

describe('FirecrestFilesystemGateway — writeFile (F-INV-4)', () => {
  it('uses synchronous upload for data ≤5MB', async () => {
    const client = createMockFirecrestClient();

    const gw = new FirecrestFilesystemGateway(client, systemName);
    const data = Buffer.alloc(1_200_000, 0x41); // 1.2MB
    await gw.writeFile(`${basePath}/uploads/script.sh`, data);

    // Verify synchronous upload was used
    const uploadCalls = client.calls.filter((c) => c.method === 'upload');
    expect(uploadCalls.length).toBe(1);
    expect(uploadCalls[0]?.path).toContain('/ops/upload');
  });

  it('uses async transfer for data >5MB (F-INV-4)', async () => {
    const client = createMockFirecrestClient();

    // Mock the transfer POST response
    const transferResponse = createMockTransferResponse({
      transferJob: { jobId: 9999002, system: 'daint' },
      transferDirectives: {
        transfer_method: 'streamer',
      },
    });

    client.postMock.mockImplementation(async (path: string, body?: unknown) => {
      client.calls.push({ method: 'post', path, body });
      if (path.includes('/transfer/upload')) {
        return { statusCode: 200, body: transferResponse };
      }
      return { statusCode: 200, body: {} };
    });

    // Mock the transfer poll GET response (completed)
    client.getMock.mockImplementation(async (path: string) => {
      client.calls.push({ method: 'get', path });
      if (path.includes('/transfer/')) {
        return { statusCode: 200, body: { status: 'completed' } };
      }
      return { statusCode: 200, body: {} };
    });

    const gw = new FirecrestFilesystemGateway(client, systemName, { pollIntervalMs: 1 });
    const data = Buffer.alloc(120_000_000, 0x42); // 120MB
    await gw.writeFile(`${basePath}/large_upload.bin`, data);

    // Verify async transfer was used (POST to /transfer/upload)
    const transferPosts = client.calls.filter(
      (c) => c.method === 'post' && c.path.includes('/transfer/upload'),
    );
    expect(transferPosts.length).toBe(1);
    // Verify synchronous upload was NOT used
    const uploadCalls = client.calls.filter((c) => c.method === 'upload');
    expect(uploadCalls.length).toBe(0);
  });
});

// ============================================================================
// readDir, mkdir
// ============================================================================

describe('FirecrestFilesystemGateway — readDir, mkdir', () => {
  describe('readDir()', () => {
    it('maps FirecrestDirEntry[] to string[]', async () => {
      const entries: FirecrestDirEntry[] = [
        createMockDirEntry({ name: 'input.nc', type: 'file' }),
        createMockDirEntry({ name: 'output.nc', type: 'file' }),
        createMockDirEntry({ name: 'results', type: 'directory' }),
      ];

      const client = createMockFirecrestClient({
        responses: [
          {
            method: 'get',
            pathPattern: `/filesystem/${systemName}/path/`,
            statusCode: 200,
            body: entries,
          },
        ],
      });

      const gw = new FirecrestFilesystemGateway(client, systemName);
      const names = await gw.readDir(basePath);

      expect(names).toEqual(['input.nc', 'output.nc', 'results']);
    });

    it('returns empty array for empty directory', async () => {
      const client = createMockFirecrestClient({
        responses: [
          {
            method: 'get',
            pathPattern: `/filesystem/${systemName}/path/`,
            statusCode: 200,
            body: [],
          },
        ],
      });

      const gw = new FirecrestFilesystemGateway(client, systemName);
      const names = await gw.readDir(`${basePath}/empty`);

      expect(names).toEqual([]);
    });

    it('throws when directory does not exist (404)', async () => {
      const client = createMockFirecrestClient({
        responses: [
          {
            method: 'get',
            pathPattern: `/filesystem/${systemName}/path/`,
            statusCode: 404,
            body: { error: 'directory not found' },
          },
        ],
      });

      const gw = new FirecrestFilesystemGateway(client, systemName);

      await expect(gw.readDir(`${basePath}/nonexistent`)).rejects.toThrow();
    });
  });

  describe('mkdir()', () => {
    it('creates a directory via PUT /filesystem/{system}/path/{path}', async () => {
      const client = createMockFirecrestClient({
        responses: [
          {
            method: 'put',
            pathPattern: `/filesystem/${systemName}/path/`,
            statusCode: 200,
            body: {},
          },
        ],
      });

      const gw = new FirecrestFilesystemGateway(client, systemName);
      await gw.mkdir(`${basePath}/new_results`);

      const putCalls = client.calls.filter((c) => c.method === 'put');
      expect(putCalls.length).toBe(1);
      expect(putCalls[0]?.path).toContain(`/filesystem/${systemName}/path/`);
      expect(putCalls[0]?.path).toContain(`${basePath}/new_results`);
    });

    it('resolves on 200', async () => {
      const client = createMockFirecrestClient({
        responses: [
          {
            method: 'put',
            pathPattern: `/filesystem/${systemName}/path/`,
            statusCode: 200,
            body: {},
          },
        ],
      });

      const gw = new FirecrestFilesystemGateway(client, systemName);

      await expect(gw.mkdir(`${basePath}/new_dir`)).resolves.toBeUndefined();
    });

    it('supports recursive flag', async () => {
      const client = createMockFirecrestClient({
        responses: [
          {
            method: 'put',
            pathPattern: `/filesystem/${systemName}/path/`,
            statusCode: 200,
            body: {},
          },
        ],
      });

      const gw = new FirecrestFilesystemGateway(client, systemName);
      await gw.mkdir(`${basePath}/a/b/c`, true);

      const putCalls = client.calls.filter((c) => c.method === 'put');
      expect(putCalls.length).toBe(1);
    });
  });
});

// ============================================================================
// Interface stability
// ============================================================================

describe('FirecrestFilesystemGateway — interface stability', () => {
  it('implements the FilesystemGateway interface', () => {
    const client = createMockFirecrestClient();
    const gw: FilesystemGateway = new FirecrestFilesystemGateway(client, systemName);

    expect(typeof gw.exists).toBe('function');
    expect(typeof gw.isReadable).toBe('function');
    expect(typeof gw.isWritable).toBe('function');
    expect(typeof gw.stat).toBe('function');
    expect(typeof gw.readFile).toBe('function');
    expect(typeof gw.writeFile).toBe('function');
    expect(typeof gw.readDir).toBe('function');
    expect(typeof gw.mkdir).toBe('function');
  });

  it('stat() returns FileStat with size, isFile, isDirectory, mtime', async () => {
    const client = createStatMockClient(systemName, [
      {
        path: `${basePath}/x`,
        stat: createMockFirecrestFileStat({ size: 100, isDir: false, mtime: '2026-09-15T10:30:00Z' }),
      },
    ]);

    const gw = new FirecrestFilesystemGateway(client, systemName);
    const stat: FileStat = await gw.stat(`${basePath}/x`);

    expect(stat).toHaveProperty('size');
    expect(stat).toHaveProperty('isFile');
    expect(stat).toHaveProperty('isDirectory');
    expect(stat).toHaveProperty('mtime');
    expect(stat.mtime).toBeInstanceOf(Date);
  });
});
