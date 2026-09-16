## Finding: `FirecrestClient` interface lacks async transfer methods despite F-INV-4
Severity: High
Category: Correctness > Specification compliance; Architecture > interface completeness
Location: `specs/firecrest/api-contracts.md` (FirecrestClient interface); `src/firecrest-adapter/types.ts` lines 40–47 (FirecrestClient); `specs/firecrest/invariants.md` F-INV-4
Spec reference: F-INV-4 (large file transfers >5MB are asynchronous); `specs/firecrest-research.md` §Filesystem

### Description

`FirecrestClient` (api-contracts.md) is described as the "Low-level HTTP client. All requests carry the JWT Bearer token." Its interface is:

```typescript
interface FirecrestClient {
  get<T>(path: string): Promise<FirecrestResponse<T>>;
  post<T>(path: string, body?: unknown): Promise<FirecrestResponse<T>>;
  put<T>(path: string, body?: unknown): Promise<FirecrestResponse<T>>;
  delete<T>(path: string): Promise<FirecrestResponse<T>>;
  download(path: string): Promise<Buffer>;
  upload(path: string, data: Buffer): Promise<void>;
}
```

The `download` and `upload` methods are synchronous-style: `download` returns `Promise<Buffer>` and `upload` takes `Buffer` and returns `Promise<void>`. There are **no methods for async file transfer** (submit transfer job, poll transfer status, retrieve transferred file).

F-INV-4 requires that files >5MB use the asynchronous `/transfer/download` and `/transfer/upload` endpoints, which return a `jobId` that cera polls until completion. The `FirecrestFilesystemGateway` (api-contracts.md) maps `readFile` to "GET /ops/download (≤5MB) or POST /transfer/download (>5MB)" and `writeFile` to "POST /ops/upload (≤5MB) or POST /transfer/upload (>5MB)."

**The gap:** The `FirecrestClient` interface has no methods for the async transfer flow. The `FirecrestTransferResponse` type exists (types.ts lines 307–317) with `transferJob.jobId` and `transferDirectives`, but the `FirecrestClient` doesn't expose a method that returns it. This means either:
1. The `FirecrestFilesystemGateway` uses the generic `post` method for async transfers (passing the path and body, parsing the response manually) — but then the `download`/`upload` methods are redundant and the interface is confusing.
2. The `FirecrestClient` needs additional methods like `submitTransferDownload(path): Promise<FirecrestTransferResponse>` and `pollTransfer(jobId): Promise<TransferStatus>` — but these are not in the spec.
3. The async transfer logic lives entirely in `FirecrestFilesystemGateway`, bypassing `FirecrestClient` — but then `FirecrestClient` is not the "low-level HTTP client" it claims to be.

Additionally, the `FirecrestClient.download(path: string): Promise<Buffer>` loads the entire file into memory as a `Buffer`. For a 5MB file (the synchronous limit), this is fine. But the interface doesn't support streaming, which would be needed for files near the limit or for memory-constrained laptops.

### Evidence

1. `specs/firecrest/api-contracts.md` (FirecrestClient): 6 methods, all synchronous-style. No `submitTransfer`, `pollTransfer`, or `getTransferResult` methods.
2. `src/firecrest-adapter/types.ts` lines 40–47: same 6 methods.
3. `src/firecrest-adapter/types.ts` lines 307–317: `FirecrestTransferResponse` type exists but is not returned by any `FirecrestClient` method.
4. `specs/firecrest/invariants.md` F-INV-4: "Files larger than 5MB cannot be downloaded or uploaded synchronously... cera must detect file size (via stat) before attempting a transfer and use the asynchronous `/transfer/download` and `/transfer/upload` endpoints."
5. `specs/firecrest/api-contracts.md` (FirecrestFilesystemGateway mapping): `readFile` → "GET /ops/download (≤5MB) or POST /transfer/download (>5MB)". The `FirecrestClient` provides no `POST /transfer/download` method.

### Suggested resolution

Either:
(a) Add async transfer methods to `FirecrestClient`: `submitTransferDownload(path: string): Promise<FirecrestTransferResponse>`, `submitTransferUpload(path: string, data: Buffer): Promise<FirecrestTransferResponse>`, `pollTransfer(jobId: number): Promise<TransferStatus>`, `getTransferResult(response: FirecrestTransferResponse): Promise<Buffer>`.
(b) Remove the `download`/`upload` methods from `FirecrestClient` and document that `FirecrestFilesystemGateway` uses the generic `get`/`post` methods for all file operations, including async transfers.
(c) Add a `streamDownload(path: string): AsyncIterable<Buffer>` method for memory-efficient downloads.
