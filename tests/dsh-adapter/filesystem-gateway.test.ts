/**
 * Unit tests for FilesystemGateway adapter.
 *
 * Verifies:
 * - Correct delegation to ctx.fs for all 8 methods
 * - FileStat translation (DshRawFileStat → FileStat)
 * - Options pass-through (recursive for mkdir)
 * - Error translation (dsh errors → AdapterInternal)
 * - No dsh types leak in public signatures
 *
 * Spec: build-phases.md Phase 1; api-contracts.md §1;
 * invariants.md INV-D4; ADR-005.
 */

import { describe, it, expect, vi } from 'vitest';
import { AdapterInternal } from '../../src/types/errors';
import { FilesystemGatewayImpl } from '../../src/dsh-adapter/filesystem-gateway';
import type { FileStat, FilesystemGateway } from '../../src/dsh-adapter/types';
import {
  createMockDshContext,
  createMockFileStat,
} from './helpers';

describe('FilesystemGateway', () => {
  describe('exists()', () => {
    it('delegates to ctx.fs.exists', async () => {
      const ctx = createMockDshContext();
      ctx.fs.exists = vi.fn().mockResolvedValue(true);
      const gateway = new FilesystemGatewayImpl(ctx);

      const result = await gateway.exists('/scratch/snx3000/cera_user/data.nc');

      expect(ctx.fs.exists).toHaveBeenCalledWith('/scratch/snx3000/cera_user/data.nc');
      expect(result).toBe(true);
    });

    it('returns false when path does not exist', async () => {
      const ctx = createMockDshContext();
      ctx.fs.exists = vi.fn().mockResolvedValue(false);
      const gateway = new FilesystemGatewayImpl(ctx);

      const result = await gateway.exists('/nonexistent');

      expect(result).toBe(false);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.fs.exists = vi.fn().mockRejectedValue(new Error('dsh fs error'));
      const gateway = new FilesystemGatewayImpl(ctx);

      await expect(gateway.exists('/path')).rejects.toThrow(AdapterInternal);
    });
  });

  describe('isReadable()', () => {
    it('delegates to ctx.fs.isReadable', async () => {
      const ctx = createMockDshContext();
      ctx.fs.isReadable = vi.fn().mockResolvedValue(true);
      const gateway = new FilesystemGatewayImpl(ctx);

      const result = await gateway.isReadable('/scratch/input.nc');

      expect(ctx.fs.isReadable).toHaveBeenCalledWith('/scratch/input.nc');
      expect(result).toBe(true);
    });

    it('returns false when path is not readable', async () => {
      const ctx = createMockDshContext();
      ctx.fs.isReadable = vi.fn().mockResolvedValue(false);
      const gateway = new FilesystemGatewayImpl(ctx);

      const result = await gateway.isReadable('/restricted');

      expect(result).toBe(false);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.fs.isReadable = vi.fn().mockRejectedValue(new Error('dsh error'));
      const gateway = new FilesystemGatewayImpl(ctx);

      await expect(gateway.isReadable('/path')).rejects.toThrow(AdapterInternal);
    });
  });

  describe('isWritable()', () => {
    it('delegates to ctx.fs.isWritable', async () => {
      const ctx = createMockDshContext();
      ctx.fs.isWritable = vi.fn().mockResolvedValue(true);
      const gateway = new FilesystemGatewayImpl(ctx);

      const result = await gateway.isWritable('/scratch/output.nc');

      expect(ctx.fs.isWritable).toHaveBeenCalledWith('/scratch/output.nc');
      expect(result).toBe(true);
    });

    it('returns false when path is not writable', async () => {
      const ctx = createMockDshContext();
      ctx.fs.isWritable = vi.fn().mockResolvedValue(false);
      const gateway = new FilesystemGatewayImpl(ctx);

      const result = await gateway.isWritable('/readonly');

      expect(result).toBe(false);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.fs.isWritable = vi.fn().mockRejectedValue(new Error('dsh error'));
      const gateway = new FilesystemGatewayImpl(ctx);

      await expect(gateway.isWritable('/path')).rejects.toThrow(AdapterInternal);
    });
  });

  describe('stat()', () => {
    it('delegates to ctx.fs.stat', async () => {
      const ctx = createMockDshContext();
      const rawStat = createMockFileStat({
        size: 4096,
        isFile: true,
        isDirectory: false,
        mtime: new Date('2026-09-14T12:00:00Z'),
      });
      ctx.fs.stat = vi.fn().mockResolvedValue(rawStat);
      const gateway = new FilesystemGatewayImpl(ctx);

      await gateway.stat('/scratch/data.nc');

      expect(ctx.fs.stat).toHaveBeenCalledWith('/scratch/data.nc');
    });

    it('translates DshRawFileStat to FileStat', async () => {
      const ctx = createMockDshContext();
      const mtime = new Date('2026-09-14T12:00:00Z');
      const rawStat = createMockFileStat({
        size: 8192,
        isFile: true,
        isDirectory: false,
        mtime,
      });
      ctx.fs.stat = vi.fn().mockResolvedValue(rawStat);
      const gateway = new FilesystemGatewayImpl(ctx);

      const result = await gateway.stat('/scratch/data.nc');

      expect(result).toEqual<FileStat>({
        size: 8192,
        isFile: true,
        isDirectory: false,
        mtime,
      });
    });

    it('returns directory stats correctly', async () => {
      const ctx = createMockDshContext();
      const rawStat = createMockFileStat({
        size: 0,
        isFile: false,
        isDirectory: true,
      });
      ctx.fs.stat = vi.fn().mockResolvedValue(rawStat);
      const gateway = new FilesystemGatewayImpl(ctx);

      const result = await gateway.stat('/scratch/dir');

      expect(result.isFile).toBe(false);
      expect(result.isDirectory).toBe(true);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.fs.stat = vi.fn().mockRejectedValue(new Error('dsh error'));
      const gateway = new FilesystemGatewayImpl(ctx);

      await expect(gateway.stat('/path')).rejects.toThrow(AdapterInternal);
    });
  });

  describe('readFile()', () => {
    it('delegates to ctx.fs.readFile', async () => {
      const ctx = createMockDshContext();
      const data = Buffer.from('file contents');
      ctx.fs.readFile = vi.fn().mockResolvedValue(data);
      const gateway = new FilesystemGatewayImpl(ctx);

      const result = await gateway.readFile('/scratch/data.txt');

      expect(ctx.fs.readFile).toHaveBeenCalledWith('/scratch/data.txt');
      expect(result).toBe(data);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.fs.readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
      const gateway = new FilesystemGatewayImpl(ctx);

      await expect(gateway.readFile('/nonexistent')).rejects.toThrow(AdapterInternal);
    });
  });

  describe('writeFile()', () => {
    it('delegates to ctx.fs.writeFile with path and data', async () => {
      const ctx = createMockDshContext();
      ctx.fs.writeFile = vi.fn().mockResolvedValue(undefined);
      const gateway = new FilesystemGatewayImpl(ctx);
      const data = Buffer.from('output contents');

      await gateway.writeFile('/scratch/output.txt', data);

      expect(ctx.fs.writeFile).toHaveBeenCalledWith('/scratch/output.txt', data);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.fs.writeFile = vi.fn().mockRejectedValue(new Error('ENOSPC'));
      const gateway = new FilesystemGatewayImpl(ctx);

      await expect(
        gateway.writeFile('/scratch/output.txt', Buffer.from('data')),
      ).rejects.toThrow(AdapterInternal);
    });
  });

  describe('readDir()', () => {
    it('delegates to ctx.fs.readDir', async () => {
      const ctx = createMockDshContext();
      const entries = ['file1.nc', 'file2.nc', 'subdir'];
      ctx.fs.readDir = vi.fn().mockResolvedValue(entries);
      const gateway = new FilesystemGatewayImpl(ctx);

      const result = await gateway.readDir('/scratch/data');

      expect(ctx.fs.readDir).toHaveBeenCalledWith('/scratch/data');
      expect(result).toEqual(entries);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.fs.readDir = vi.fn().mockRejectedValue(new Error('EACCES'));
      const gateway = new FilesystemGatewayImpl(ctx);

      await expect(gateway.readDir('/restricted')).rejects.toThrow(AdapterInternal);
    });
  });

  describe('mkdir()', () => {
    it('delegates to ctx.fs.mkdir without recursive by default', async () => {
      const ctx = createMockDshContext();
      ctx.fs.mkdir = vi.fn().mockResolvedValue(undefined);
      const gateway = new FilesystemGatewayImpl(ctx);

      await gateway.mkdir('/scratch/newdir');

      expect(ctx.fs.mkdir).toHaveBeenCalledWith('/scratch/newdir', undefined);
    });

    it('delegates to ctx.fs.mkdir with recursive=true', async () => {
      const ctx = createMockDshContext();
      ctx.fs.mkdir = vi.fn().mockResolvedValue(undefined);
      const gateway = new FilesystemGatewayImpl(ctx);

      await gateway.mkdir('/scratch/a/b/c', true);

      expect(ctx.fs.mkdir).toHaveBeenCalledWith('/scratch/a/b/c', true);
    });

    it('delegates to ctx.fs.mkdir with recursive=false', async () => {
      const ctx = createMockDshContext();
      ctx.fs.mkdir = vi.fn().mockResolvedValue(undefined);
      const gateway = new FilesystemGatewayImpl(ctx);

      await gateway.mkdir('/scratch/newdir', false);

      expect(ctx.fs.mkdir).toHaveBeenCalledWith('/scratch/newdir', false);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.fs.mkdir = vi.fn().mockRejectedValue(new Error('EEXIST'));
      const gateway = new FilesystemGatewayImpl(ctx);

      await expect(gateway.mkdir('/scratch/exists')).rejects.toThrow(AdapterInternal);
    });
  });

  describe('interface stability', () => {
    it('implements the FilesystemGateway interface', () => {
      const ctx = createMockDshContext();
      const gateway: FilesystemGateway = new FilesystemGatewayImpl(ctx);

      expect(typeof gateway.exists).toBe('function');
      expect(typeof gateway.isReadable).toBe('function');
      expect(typeof gateway.isWritable).toBe('function');
      expect(typeof gateway.stat).toBe('function');
      expect(typeof gateway.readFile).toBe('function');
      expect(typeof gateway.writeFile).toBe('function');
      expect(typeof gateway.readDir).toBe('function');
      expect(typeof gateway.mkdir).toBe('function');
    });

    it('does not expose the ctx property', () => {
      const ctx = createMockDshContext();
      const gateway = new FilesystemGatewayImpl(ctx);

      expect(gateway).not.toHaveProperty('ctx');
    });

    it('FileStat has exactly size, isFile, isDirectory, mtime', async () => {
      const ctx = createMockDshContext();
      ctx.fs.stat = vi.fn().mockResolvedValue(createMockFileStat());
      const gateway = new FilesystemGatewayImpl(ctx);

      const result = await gateway.stat('/path');

      const keys = Object.keys(result).sort();
      expect(keys).toEqual(['isDirectory', 'isFile', 'mtime', 'size']);
    });

    it('stat returns cera FileStat, not raw dsh type', async () => {
      const ctx = createMockDshContext();
      ctx.fs.stat = vi.fn().mockResolvedValue(createMockFileStat());
      const gateway = new FilesystemGatewayImpl(ctx);

      const result: FileStat = await gateway.stat('/path');

      // FileStat has the cera property names, not dsh-specific ones
      expect(result).toHaveProperty('isFile');
      expect(result).toHaveProperty('isDirectory');
      expect(result).toHaveProperty('size');
      expect(result).toHaveProperty('mtime');
    });
  });
});
