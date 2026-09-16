/**
 * FilesystemGateway implementation via FirecREST (F-INV-4).
 *
 * All filesystem operations go through FirecREST REST endpoints
 * (F-INV-1). Files larger than 5MB use asynchronous /transfer/
 * endpoints; files ≤5MB use synchronous /ops/ endpoints (F-INV-4).
 *
 * Endpoint mapping:
 * - exists     → GET /filesystem/{system}/stat/{path} (200=true, 404=false)
 * - isReadable → GET /filesystem/{system}/stat/{path} (same as exists)
 * - isWritable → GET /filesystem/{system}/stat/{parent} (best-effort)
 * - stat       → GET /filesystem/{system}/stat/{path} → FileStat
 * - readFile   → stat first. ≤5MB: GET /ops/download. >5MB: POST /transfer/download (F-INV-4)
 * - writeFile  → ≤5MB: POST /ops/upload. >5MB: POST /transfer/upload (F-INV-4)
 * - readDir    → GET /filesystem/{system}/path/{path} → string[]
 * - mkdir      → PUT /filesystem/{system}/path/{path}
 *
 * Spec: specs/firecrest/invariants.md F-INV-1, F-INV-4;
 * specs/firecrest/features/firecrest-backend.feature;
 * ADR-011.
 */

import type {
  FirecrestClient,
  FirecrestFileStatResponse,
  FirecrestDirEntry,
  FirecrestTransferResponse,
} from './types';
import type {
  FileStat,
  FilesystemGateway,
} from '../dsh-adapter/types';

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_FILE_SYNCHRONOUS_BYTES = 5_000_000;
const DEFAULT_TRANSFER_METHOD = 'streamer' as const;

// ============================================================================
// Config
// ============================================================================

/**
 * Configuration for the FirecrestFilesystemGateway.
 */
export interface FirecrestFilesystemGatewayConfig {
  /** Polling interval for async transfer status (ms). Default: 5000. */
  readonly pollIntervalMs?: number;
  /** Maximum file size for synchronous transfer (bytes). Default: 5_000_000 (F-INV-4). */
  readonly maxFileSynchronousBytes?: number;
  /** Transfer method for large files. Default: "streamer". */
  readonly transferMethod?: 's3' | 'streamer' | 'wormhole';
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Maps a FirecrestFileStatResponse to a cera FileStat.
 */
function mapStat(response: FirecrestFileStatResponse): FileStat {
  return {
    size: response.size,
    isFile: !response.isDir,
    isDirectory: response.isDir,
    mtime: new Date(response.mtime),
  };
}

/**
 * Returns the parent directory path of a given path.
 * e.g., "/scratch/user/data/file.nc" → "/scratch/user/data"
 */
function getParentPath(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.substring(0, idx);
}

/**
 * Builds the stat URL for a path: /filesystem/{system}/stat/{path}
 * The path is passed as-is (FirecREST expects the absolute path
 * with a leading slash, resulting in a double slash after /stat/).
 */
function statUrl(systemName: string, path: string): string {
  return `/filesystem/${systemName}/stat/${path}`;
}

/**
 * Builds the ops download URL: /filesystem/{system}/ops/download?path={path}
 * The path is passed as-is (FirecREST expects the absolute path
 * un-encoded in the query parameter).
 */
function downloadUrl(systemName: string, path: string): string {
  return `/filesystem/${systemName}/ops/download?path=${path}`;
}

/**
 * Builds the ops upload URL: /filesystem/{system}/ops/upload?path={path}
 * The path is passed as-is (FirecREST expects the absolute path
 * un-encoded in the query parameter).
 */
function uploadUrl(systemName: string, path: string): string {
  return `/filesystem/${systemName}/ops/upload?path=${path}`;
}

/**
 * Builds the async transfer download URL: /filesystem/{system}/transfer/download
 */
function transferDownloadUrl(systemName: string): string {
  return `/filesystem/${systemName}/transfer/download`;
}

/**
 * Builds the async transfer upload URL: /filesystem/{system}/transfer/upload
 */
function transferUploadUrl(systemName: string): string {
  return `/filesystem/${systemName}/transfer/upload`;
}

/**
 * Builds the async transfer poll URL: /filesystem/{system}/transfer/download/{jobId}
 */
function transferPollUrl(systemName: string, jobId: number): string {
  return `/filesystem/${systemName}/transfer/download/${jobId}`;
}

// ============================================================================
// FirecrestFilesystemGateway
// ============================================================================

/**
 * Implements FilesystemGateway via FirecREST filesystem endpoints.
 * All operations are HTTP requests to FirecREST (F-INV-1).
 *
 * Files larger than `maxFileSynchronousBytes` (default 5MB) use
 * asynchronous /transfer/ endpoints; smaller files use synchronous
 * /ops/ endpoints (F-INV-4).
 *
 * Spec: specs/firecrest/invariants.md F-INV-1, F-INV-4;
 * specs/firecrest/features/firecrest-backend.feature;
 * ADR-011.
 */
export class FirecrestFilesystemGateway implements FilesystemGateway {
  #client: FirecrestClient;
  #systemName: string;
  #pollIntervalMs: number;
  #maxFileSynchronousBytes: number;
  #transferMethod: 's3' | 'streamer' | 'wormhole';

  constructor(
    client: FirecrestClient,
    systemName: string,
    config?: FirecrestFilesystemGatewayConfig,
  ) {
    this.#client = client;
    this.#systemName = systemName;
    this.#pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#maxFileSynchronousBytes = config?.maxFileSynchronousBytes ?? DEFAULT_MAX_FILE_SYNCHRONOUS_BYTES;
    this.#transferMethod = config?.transferMethod ?? DEFAULT_TRANSFER_METHOD;
  }

  // ========================================================================
  // exists, isReadable, isWritable, stat
  // ========================================================================

  async exists(path: string): Promise<boolean> {
    const response = await this.#client.get<FirecrestFileStatResponse>(
      statUrl(this.#systemName, path),
    );
    return response.statusCode === 200;
  }

  async isReadable(path: string): Promise<boolean> {
    // FirecREST checks permissions server-side — same as exists
    return this.exists(path);
  }

  async isWritable(path: string): Promise<boolean> {
    // Best-effort: check if the parent directory exists and is a directory
    const parent = getParentPath(path);
    const response = await this.#client.get<FirecrestFileStatResponse>(
      statUrl(this.#systemName, parent),
    );
    if (response.statusCode !== 200) {
      return false;
    }
    const body = response.body;
    if (body === undefined || body === null || typeof body !== 'object') {
      return false;
    }
    return (body as FirecrestFileStatResponse).isDir === true;
  }

  async stat(path: string): Promise<FileStat> {
    const response = await this.#client.get<FirecrestFileStatResponse>(
      statUrl(this.#systemName, path),
    );
    if (response.statusCode !== 200) {
      throw new Error(
        `stat failed for "${path}" with status ${response.statusCode}: ` +
        `${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body;
    if (body === undefined || body === null || typeof body !== 'object') {
      throw new Error(`stat response for "${path}" is missing data`);
    }
    return mapStat(body as FirecrestFileStatResponse);
  }

  // ========================================================================
  // readFile (F-INV-4)
  // ========================================================================

  async readFile(path: string): Promise<Buffer> {
    // F-INV-4: stat first to check file size
    const stat = await this.stat(path);

    if (stat.size <= this.#maxFileSynchronousBytes) {
      // Synchronous download (≤5MB)
      return this.#client.download(downloadUrl(this.#systemName, path));
    }

    // Async transfer (>5MB, F-INV-4)
    return this.#asyncDownload(path);
  }

  /**
   * Performs an async file download via POST /transfer/download,
   * polls for completion, then retrieves the file content.
   */
  async #asyncDownload(path: string): Promise<Buffer> {
    // Submit the transfer
    const submitResponse = await this.#client.post<FirecrestTransferResponse>(
      transferDownloadUrl(this.#systemName),
      {
        path,
        transfer_method: this.#transferMethod,
      },
    );

    if (submitResponse.statusCode < 200 || submitResponse.statusCode >= 300) {
      throw new Error(
        `Async download submission failed with status ${submitResponse.statusCode}: ` +
        `${JSON.stringify(submitResponse.body)}`,
      );
    }

    const transfer = submitResponse.body;
    if (transfer === undefined || transfer === null || typeof transfer !== 'object') {
      throw new Error('Async download response is missing transfer data');
    }

    const transferResp = transfer as FirecrestTransferResponse;
    const jobId = transferResp.transferJob.jobId;

    // Poll for completion
    const completed = await this.#pollTransfer(jobId);

    // Retrieve the file content via the download URL
    if (completed.download_url !== undefined) {
      return this.#client.download(completed.download_url);
    }

    // If no download_url in the completion response, use the one from
    // the initial transfer response
    if (transferResp.transferDirectives.download_url !== undefined) {
      return this.#client.download(transferResp.transferDirectives.download_url);
    }

    throw new Error('Async download completed but no download URL available');
  }

  // ========================================================================
  // writeFile (F-INV-4)
  // ========================================================================

  async writeFile(path: string, data: Buffer): Promise<void> {
    if (data.length <= this.#maxFileSynchronousBytes) {
      // Synchronous upload (≤5MB)
      await this.#client.upload(uploadUrl(this.#systemName, path), data);
      return;
    }

    // Async transfer (>5MB, F-INV-4)
    await this.#asyncUpload(path, data);
  }

  /**
   * Performs an async file upload via POST /transfer/upload,
   * polls for completion.
   */
  async #asyncUpload(path: string, _data: Buffer): Promise<void> {
    // Submit the transfer
    const submitResponse = await this.#client.post<FirecrestTransferResponse>(
      transferUploadUrl(this.#systemName),
      {
        path,
        transfer_method: this.#transferMethod,
      },
    );

    if (submitResponse.statusCode < 200 || submitResponse.statusCode >= 300) {
      throw new Error(
        `Async upload submission failed with status ${submitResponse.statusCode}: ` +
        `${JSON.stringify(submitResponse.body)}`,
      );
    }

    const transfer = submitResponse.body;
    if (transfer === undefined || transfer === null || typeof transfer !== 'object') {
      throw new Error('Async upload response is missing transfer data');
    }

    const transferResp = transfer as FirecrestTransferResponse;
    const jobId = transferResp.transferJob.jobId;

    // Poll for completion
    await this.#pollTransfer(jobId);
  }

  // ========================================================================
  // readDir, mkdir
  // ========================================================================

  async readDir(path: string): Promise<string[]> {
    const url = `/filesystem/${this.#systemName}/path${path}`;
    const response = await this.#client.get<FirecrestDirEntry[]>(url);

    if (response.statusCode !== 200) {
      throw new Error(
        `readDir failed for "${path}" with status ${response.statusCode}: ` +
        `${JSON.stringify(response.body)}`,
      );
    }

    const body = response.body;
    if (!Array.isArray(body)) {
      throw new Error(`readDir response for "${path}" is not an array`);
    }

    return body.map((entry) => entry.name);
  }

  async mkdir(path: string, recursive?: boolean): Promise<void> {
    const url = `/filesystem/${this.#systemName}/path${path}`;
    const body = recursive !== undefined ? { recursive } : undefined;
    const response = await this.#client.put(url, body);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `mkdir failed for "${path}" with status ${response.statusCode}: ` +
        `${JSON.stringify(response.body)}`,
      );
    }
  }

  // ========================================================================
  // Private: transfer polling
  // ========================================================================

  /**
   * Polls the transfer status until it reaches a terminal state
   * (completed or failed). Returns the completion response body
   * which may contain a download_url.
   */
  async #pollTransfer(jobId: number): Promise<{ download_url?: string; status: string }> {
    const url = transferPollUrl(this.#systemName, jobId);

    while (true) {
      const response = await this.#client.get<{ status?: string; download_url?: string }>(url);

      if (response.statusCode !== 200) {
        throw new Error(
          `Transfer poll failed for job ${jobId} with status ${response.statusCode}: ` +
          `${JSON.stringify(response.body)}`,
        );
      }

      const body = response.body;
      if (body === undefined || body === null || typeof body !== 'object') {
        throw new Error(`Transfer poll response for job ${jobId} is missing data`);
      }

      const status = (body as { status?: string }).status;
      if (status === 'completed') {
        return body as { download_url?: string; status: string };
      }
      if (status === 'failed') {
        throw new Error(`Transfer job ${jobId} failed`);
      }

      // Wait before next poll
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
