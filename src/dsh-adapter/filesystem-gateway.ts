/**
 * FilesystemGateway implementation.
 *
 * Wraps dsh's ctx.fs extension point. This is the ONLY code in cera
 * that calls ctx.fs directly. Domain modules use the FilesystemGateway
 * interface instead.
 *
 * Used by: data-management (Location validation), provenance (record
 * persistence), environment-management (mount path verification).
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */

import type { DshContext } from './context';
import { translateDshError } from './internal';
import type { FileStat, FilesystemGateway } from './types';

export class FilesystemGatewayImpl implements FilesystemGateway {
  #ctx: DshContext;
  constructor(ctx: DshContext) {
    this.#ctx = ctx;
  }

  async exists(path: string): Promise<boolean> {
    try {
      return await this.#ctx.fs.exists(path);
    } catch (error) {
      translateDshError(error, 'ctx.fs', 'exists');
    }
  }

  async isReadable(path: string): Promise<boolean> {
    try {
      return await this.#ctx.fs.isReadable(path);
    } catch (error) {
      translateDshError(error, 'ctx.fs', 'isReadable');
    }
  }

  async isWritable(path: string): Promise<boolean> {
    try {
      return await this.#ctx.fs.isWritable(path);
    } catch (error) {
      translateDshError(error, 'ctx.fs', 'isWritable');
    }
  }

  async stat(path: string): Promise<FileStat> {
    try {
      const raw = await this.#ctx.fs.stat(path);
      return {
        size: raw.size,
        isFile: raw.isFile,
        isDirectory: raw.isDirectory,
        mtime: raw.mtime,
      };
    } catch (error) {
      translateDshError(error, 'ctx.fs', 'stat');
    }
  }

  async readFile(path: string): Promise<Buffer> {
    try {
      return await this.#ctx.fs.readFile(path);
    } catch (error) {
      translateDshError(error, 'ctx.fs', 'readFile');
    }
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    try {
      await this.#ctx.fs.writeFile(path, data);
    } catch (error) {
      translateDshError(error, 'ctx.fs', 'writeFile');
    }
  }

  async readDir(path: string): Promise<string[]> {
    try {
      return await this.#ctx.fs.readDir(path);
    } catch (error) {
      translateDshError(error, 'ctx.fs', 'readDir');
    }
  }

  async mkdir(path: string, recursive?: boolean): Promise<void> {
    try {
      await this.#ctx.fs.mkdir(path, recursive);
    } catch (error) {
      translateDshError(error, 'ctx.fs', 'mkdir');
    }
  }
}
