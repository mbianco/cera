## Finding: Missing error types — no FirecrestForbidden (403), FirecrestJobNotFound (Job 404), or generic 4xx handler
Severity: High
Category: Correctness > Missing negatives; Robustness > error handling quality
Location: `src/firecrest-adapter/types.ts` lines 114–255 (error classes); `specs/firecrest/failure-modes.md` (9 FMs); `specs/firecrest/features/firecrest-backend.feature` lines 42–48 (403 scenario), 117–119 (Job 404)
Spec reference: FM-F-2 (401), FM-F-7 (system 404); firecrest-research.md §HTTP Status Codes

### Description

The `FirecrestError` hierarchy in `types.ts` defines 6 error classes:
- `FirecrestTimeout` (statusCode 0, FM-F-1)
- `FirecrestUnauthorized` (statusCode 401, FM-F-2)
- `FirecrestRateLimited` (statusCode 429, FM-F-3)
- `FirecrestUnavailable` (statusCode 503, FM-F-4)
- `FirecrestSshError` (statusCode 500, FM-F-5)
- `FirecrestSystemNotFound` (statusCode 404, FM-F-7)
- `FirecrestFileTooLarge` (statusCode 413, FM-F-8)

**Missing error types:**

1. **No `FirecrestForbidden` (403).** The feature file (lines 42–48) has a 403 scenario: "User 'cera_user' does not have access to system 'santis'... FirecREST returns 403... cera does NOT retry the request." There is no `FirecrestForbidden` error class. The 403 response would need to be handled by a generic error, losing the semantic distinction (403 is not retryable, not an authentication issue, and the user message should mention access rights, not re-authentication). This is a **spec-vs-implementation gap**: the feature requires a specific behavior for 403, but the error taxonomy doesn't support it.

2. **No `FirecrestJobNotFound` (Job 404 vs System 404).** `FirecrestSystemNotFound` (statusCode 404) is for "system not configured in FirecREST." But the feature file (lines 117–119) has a **different** 404: "Query non-existent Job via FirecREST — 404... the User is notified that Job '9999999' does not exist." A Job-404 is semantically different from a System-404:
   - System-404: the system name is wrong → suggest querying `/status/systems`.
   - Job-404: the system is fine, but the Job ID doesn't exist → suggest checking the Job ID.
   The `FirecrestSystemNotFound` constructor takes `systemName` and `availableSystems` — it cannot represent a Job-404. There is no `FirecrestJobNotFound` error class.

3. **No generic 4xx handler (400, 404 for files, 405, 409, 422).** The firecrest-research.md HTTP table lists 200, 401, 403, 404, 429, 500, 503. The error taxonomy covers 401, 404 (system only), 413, 429, 500, 503. Missing:
   - **400 Bad Request** (e.g., malformed job script, invalid path).
   - **404 for files** (e.g., `GET /filesystem/.../ops/download?path=/nonexistent` — the feature file line 159–162 shows a 404 for a non-existent directory, but there's no `FirecrestFileNotFound`).
   - **405 Method Not Allowed** (e.g., wrong HTTP method for an endpoint).
   - **422 Unprocessable Entity** (e.g., valid JSON but semantically invalid request body).
   These would all need to be handled by a generic error, with no `isRetryable` guidance or user-facing message.

4. **No handling for unexpected status codes.** What happens if FirecREST returns 302 (redirect), 418 (teapot), or 502 (bad gateway from a reverse proxy)? The spec and error taxonomy are silent. The `FirecrestError` base class is `abstract` with `abstract readonly statusCode: number` — there is no concrete "catch-all" error class for unrecognized status codes.

### Evidence

1. `src/firecrest-adapter/types.ts` lines 114–255: 6 error classes, none for 403, Job-404, file-404, 400, or unexpected codes.
2. `specs/firecrest/features/firecrest-backend.feature` lines 42–48: 403 scenario, no corresponding error type.
3. `specs/firecrest/features/firecrest-backend.feature` lines 117–119: Job 404 scenario, no `FirecrestJobNotFound`.
4. `specs/firecrest/features/firecrest-backend.feature` lines 159–162: directory 404 scenario, no `FirecrestFileNotFound`.
5. `specs/firecrest/failure-modes.md` Summary Table: FM-F-1 through FM-F-9. No FM for 403 (only FM-F-2 for 401).
6. `specs/firecrest-research.md` §HTTP Status Codes: lists 403 with "Notify User, do not retry" — but no error class implements this.
7. `src/firecrest-adapter/types.ts` line 114: `export abstract class FirecrestError extends Error` — abstract, no concrete catch-all.

### Suggested resolution

1. Add `FirecrestForbidden` (statusCode 403, isRetryable: false) with a user message about access rights.
2. Add `FirecrestJobNotFound` (statusCode 404, isRetryable: false) with `jobId` in the constructor.
3. Add `FirecrestFileNotFound` (statusCode 404, isRetryable: false) with `path` in the constructor. Distinguish from `FirecrestSystemNotFound` using response body context or the endpoint that returned 404.
4. Add a concrete `FirecrestUnexpectedStatus` error class (non-abstract) for unrecognized status codes, with `statusCode`, `responseBody`, and `isRetryable: false` by default.
5. Add a `FirecrestBadRequest` (statusCode 400) for malformed requests.
6. Add corresponding failure modes (FM-F-10 for 403, FM-F-11 for unexpected status) to the failure-modes doc.
7. Add Gherkin scenarios for 400, 302, and unexpected status codes.
