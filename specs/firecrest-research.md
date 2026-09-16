# FirecREST v2 Research Summary

> Gathered from FirecREST documentation (CSCS) and domain expert input.
> This file is the reference for all FirecREST-specific specs.

---

## Architecture

FirecREST is a RESTful API gateway for HPC resources at CSCS. It sits
between web clients and HPC systems, executing commands on the HPC via
SSH using user credentials extracted from the JWT.

- Supports multiple HPC systems, targeted via `{system_name}` in the URL
  (e.g., `daint`, `santis`).
- SSH connection pool for high throughput (500 clients, ~195 req/s,
  900ms latency).
- **5-second timeout** for synchronous operations.

## Authentication

- OIDC/OAuth2 — JWT Bearer token in `Authorization: Bearer <token>` header.
- FirecREST extracts `preferred_username` from the JWT for SSH user
  mapping (the HPC job runs as this user).
- Two flows:
  - **Client Credentials Grant** — for apps/services (cera uses this).
  - **Authorization Code Grant** — for web apps (not used by cera).
- Tokens have a finite lifetime (configurable by the IdP, typically
  1 hour). The client must refresh before expiry.

## API Resource Groups

### 1. Status (`/status/...`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status/systems` | GET | Available systems, transfer methods, scheduler info |
| `/status/{system_name}/healthchecks` | GET | Health check status for a system |

### 2. Compute (`/compute/{system_name}/...`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/compute/{system_name}/jobs` | POST | Submit a job (takes `jobScript` or `jobContent`) |
| `/compute/{system_name}/jobs` | GET | List jobs (filterable by user, state) |
| `/compute/{system_name}/jobs/{job_id}` | GET | Get job details (state, output, error) |
| `/compute/{system_name}/jobs/{job_id}` | DELETE | Cancel a job |
| `/compute/{system_name}/jobs/{job_id}/metadata` | GET | Job metadata |

**Key constraints:**
- Job submission is synchronous — the POST returns immediately with
  the SLURM `job_id` (does not wait for the job to run).
- There is no "run arbitrary command and wait for output" endpoint.
  Everything that runs on the HPC goes through SLURM Jobs.
- Job state queries are synchronous (GET, returns current state).

### 3. Filesystem (`/filesystem/{system_name}/...`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/filesystem/{system_name}/path/{path}` | GET | List files (like `ls`) |
| `/filesystem/{system_name}/ops/download` | GET | Download small file (≤5MB) |
| `/filesystem/{system_name}/ops/upload` | POST | Upload small file (≤5MB) |
| `/filesystem/{system_name}/transfer/download` | POST | Large file download (async, returns jobId) |
| `/filesystem/{system_name}/transfer/upload` | POST | Large file upload (async, returns jobId) |
| `/filesystem/{system_name}/path/{path}` | PUT | Create directory |
| `/filesystem/{system_name}/path/{path}` | DELETE | Delete file/directory |
| `/filesystem/{system_name}/stat/{path}` | GET | File stat (size, mtime, is_dir) |
| `/filesystem/{system_name}/chmod/{path}` | POST | Change permissions |

**Transfer methods:**
- `s3` — via staging storage (S3-compatible object store).
- `streamer` — point-to-point streaming.
- `wormhole` — magic wormhole protocol.

**Key constraints:**
- Small files (≤5MB): synchronous download/upload via `/ops/...`.
- Large files (>5MB): asynchronous — POST to `/transfer/...` returns
  a `jobId`; the client polls the transfer job status and downloads
  via S3 or streamer when the transfer is ready.
- All filesystem operations are HTTP, not direct filesystem access —
  every operation incurs network latency.

## Synchronous vs Asynchronous

| Operation | Mode | Notes |
|-----------|------|-------|
| Job submission (POST /compute/.../jobs) | Synchronous | Returns immediately with job_id |
| Job state query (GET /compute/.../jobs/{id}) | Synchronous | Returns current state |
| Job cancellation (DELETE /compute/.../jobs/{id}) | Synchronous | Returns immediately |
| File list (GET /filesystem/.../path/{path}) | Synchronous | Returns directory listing |
| Small file download (GET /filesystem/.../ops/download) | Synchronous | ≤5MB |
| Small file upload (POST /filesystem/.../ops/upload) | Synchronous | ≤5MB |
| File stat (GET /filesystem/.../stat/{path}) | Synchronous | Returns metadata |
| Create directory (PUT /filesystem/.../path/{path}) | Synchronous | Returns immediately |
| Delete file/directory (DELETE /filesystem/.../path/{path}) | Synchronous | Returns immediately |
| Large file download (POST /filesystem/.../transfer/download) | **Asynchronous** | Returns jobId, poll for completion |
| Large file upload (POST /filesystem/.../transfer/upload) | **Asynchronous** | Returns jobId, poll for completion |

## Key constraints for cera

1. **No "run command and wait"** — everything that executes on the HPC
   goes through SLURM Jobs (POST /compute/.../jobs). There is no
   endpoint for arbitrary command execution with synchronous output.

2. **All ToolInvocations become parallel** — even short CLI calls (CDO,
   NCO) must be submitted as SLURM Jobs and their output polled. The
   `executionModel: 'synchronous'` concept in the existing cera domain
   model does not apply to the FirecREST backend. Every ToolInvocation
   is a Job submission + polling cycle.

3. **File operations are HTTP, not direct filesystem** — every
   `FilesystemGateway` call (exists, stat, readFile, writeFile, readDir,
   mkdir) is an HTTP request to FirecREST, adding network latency to
   every operation.

4. **Large files (>5MB) require async transfer** — submit transfer job,
   poll for completion, download via S3/streamer. This is a new
   complexity not present in the local (dsh) backend.

5. **uenv management is NOT exposed by FirecREST** — there is no
   FirecREST endpoint for `uenv mount`/`uenv status`. Environment loading
   must be done within the Job script itself (e.g., `uenv start
   <spec> -- <command>` in the sbatch script). This re-evaluates INV-E1:
   cera no longer manages the Environment lifecycle directly; instead,
   it embeds uenv load commands in the Job script.

6. **Authentication is OIDC (JWT token), not SSH keys** — the local
   backend uses dsh's subprocess execution (which relies on local SSH
   keys or direct CLI access). The FirecREST backend uses OIDC JWT
   tokens. The token must be valid and not expired for every request.
   Token refresh is the client's responsibility.

7. **Provenance store stays on Alps** — the Provenance store is
   filesystem-based on the HPC system (INV-P4). With the FirecREST
   backend, Provenance records are written via FirecREST filesystem
   endpoints (writeFile). This adds latency and potential failure modes
   (network errors during provenance writes).

## HTTP Status Codes

| Code | Meaning | cera handling |
|------|---------|---------------|
| 200 | Success | Parse response body |
| 401 | Unauthorized — invalid or expired JWT | Refresh token and retry, or notify User |
| 403 | Forbidden — user lacks permissions | Notify User, do not retry |
| 404 | Not Found — system, job, or file does not exist | Notify User with specifics |
| 429 | Rate limit exceeded | Retry with exponential backoff |
| 500 | Internal server error (e.g., SSH to HPC failed) | Retry with backoff; notify User if persistent |
| 503 | Service unavailable — FirecREST or HPC is down | Retry with backoff; notify User |
