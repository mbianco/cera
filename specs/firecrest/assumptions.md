# FirecREST Backend Assumptions — cera

> Assumptions specific to the FirecREST backend. These supplement
> (not replace) the existing assumptions in `assumptions.md`.

## VALIDATED

### F-V-1: FirecREST v2 is deployed at CSCS
**Status:** VALIDATED
FirecREST v2 is deployed at CSCS and accessible from outside the
HPC network via HTTPS. The FirecREST URL is configured in
`FirecrestConfig.firecrestUrl`.

### F-V-2: OIDC token from CSCS identity provider
**Status:** VALIDATED
The scientist has a valid OIDC token from the CSCS identity
provider (Keycloak). The token's `preferred_username` claim maps
to a valid HPC user. The token is passed as `Bearer <token>` in
the `Authorization` header.

### F-V-3: Target system name is known
**Status:** VALIDATED
The target system name (e.g., "daint", "santis") is configured in
`FirecrestConfig.systemName`. Available systems can be queried via
`GET /status/systems`.

### F-V-4: Small files (≤5MB) can be transferred synchronously
**Status:** VALIDATED
FirecREST provides `/filesystem/{system}/ops/download` and
`/filesystem/{system}/ops/upload` for synchronous file transfer of
files up to 5MB. Larger files require the async `/transfer/...`
endpoints.

## ACCEPTED

### F-A-1: All ToolInvocations become parallel
**Status:** ACCEPTED
**Risk:** A 2-second CDO command becomes a 30-second Job (submission
+ queue + execution + polling). This is the trade-off for running
cera on a laptop instead of the login node.
**Mitigation:** The LLM on the laptop has better latency. The
scientist can queue multiple operations while waiting for Jobs to
complete. The proactive Job report (R7) keeps the scientist informed.

### F-A-2: uenv is loaded in Job scripts, not by cera
**Status:** ACCEPTED
**Risk:** cera cannot verify the uenv is available before submitting
the Job (no `uenv status` endpoint in FirecREST). The Job may fail
if the uenv doesn't exist.
**Mitigation:** cera embeds `uenv start <spec> --` in the Job script.
If the uenv is not available, the Job fails with a clear error in
stderr (FM-F-9). cera reports the failure and suggests alternatives.

### F-A-3: File access latency is higher than local
**Status:** ACCEPTED
**Risk:** Every file operation is an HTTP request. For metadata
(stat, list), this adds ~100-900ms per operation (FirecREST
documentation: 900ms at high throughput).
**Mitigation:** cera minimizes file operations by caching metadata
within a Session. Large files are never downloaded to the laptop —
all processing happens on the HPC via Jobs.

## UNKNOWN

### F-U-1: Transfer method availability
**Status:** UNKNOWN
The available transfer methods (s3, streamer, wormhole) depend on
the FirecREST installation. cera should query `GET /status/systems`
to determine which methods are available before attempting large
file transfers.

### F-U-2: FirecREST rate limit specifics
**Status:** UNKNOWN
The exact rate limits depend on the FirecREST deployment. The
`Retry-After` header (if present) should be honored. If absent,
cera applies its own backoff.
