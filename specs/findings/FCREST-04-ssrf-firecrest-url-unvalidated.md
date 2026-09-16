## Finding: SSRF — `firecrestUrl` is unvalidated, JWT token sent to arbitrary URL
Severity: Critical
Category: Security > Input validation; Security > Secret handling
Location: `src/firecrest-adapter/types.ts` lines 62–81 (FirecrestConfig), 83–93 (DEFAULT_FIRECREST_CONFIG); `specs/firecrest/api-contracts.md` (FirecRESTConfig, JwtTokenProvider)
Spec reference: F-INV-2 (valid JWT for every request); assumptions.md F-V-1 (FirecREST v2 deployed at CSCS); firecrest-research.md §Authentication

### Description

`FirecrestConfig.firecrestUrl` is a raw `string` with no validation. The `FirecrestClient` (api-contracts.md) sends every request to this URL with a `Bearer <token>` JWT in the `Authorization` header (F-INV-2). The JWT's `preferred_username` claim maps to the HPC user under which commands execute.

**Attack vectors:**

1. **Malicious configuration.** If `firecrestUrl` is set to `https://attacker.example.com` (via a config file, environment variable, or compromised config), cera sends the user's JWT to the attacker's server. The attacker can:
   - Extract the JWT and impersonate the user on the real FirecREST.
   - Return crafted responses that cause cera to submit malicious Job scripts to the real HPC (if the attacker proxies to the real FirecREST).
   - Serve fake system listings, fake Job states, or fake file contents.

2. **No HTTPS requirement.** The type is `string`, not a validated URL. If set to `http://firecrest.cscs.ch` (no TLS), the JWT is sent in cleartext. There is no assertion in F-INV-2 or anywhere in the spec that the URL must be HTTPS.

3. **No redirect policy.** The spec does not state whether the HTTP client follows 3xx redirects. If FirecREST returns a 302 redirect to an attacker-controlled host (e.g., due to a misconfigured reverse proxy), cera would follow the redirect and send the JWT to the attacker. The firecrest-research.md HTTP status table does not list 3xx codes at all.

4. **No host allowlisting.** Assumption F-V-1 says "FirecREST v2 is deployed at CSCS and accessible from outside the HPC network via HTTPS." But `FirecrestConfig` does not validate that `firecrestUrl` points to a CSCS host. The default (`https://firecrest.cscs.ch`) is correct, but there is no guard against a user or attacker changing it.

5. **Token in `internalDetails`.** The `FirecrestError` base class (types.ts lines 114–133) has an `internalDetails` field intended for logging. If an HTTP error response echoes the `Authorization` header (some servers do), the token could appear in `internalDetails` and be logged. The spec has no redaction requirement.

### Evidence

1. `src/firecrest-adapter/types.ts` line 63: `readonly firecrestUrl: string;` — no URL validation, no scheme constraint.
2. `src/firecrest-adapter/types.ts` line 84: `firecrestUrl: 'https://firecrest.cscs.ch'` — default is HTTPS, but not enforced.
3. `specs/firecrest/api-contracts.md` (JwtTokenProvider): `getToken(): Promise<string>` — returned token is sent in `Authorization: Bearer <token>` to whatever URL is configured.
4. `specs/firecrest/invariants.md` F-INV-2: "Every FirecREST HTTP request carries a valid, non-expired JWT Bearer token in the `Authorization` header." No constraint on the URL.
5. `specs/firecrest/assumptions.md` F-V-1: "FirecREST v2 is deployed at CSCS" — but no validation that `firecrestUrl` actually points to CSCS.
6. `src/firecrest-adapter/types.ts` lines 114–133: `FirecrestError` has `internalDetails: string` with no redaction requirement.
7. `specs/firecrest-research.md` HTTP Status Codes table: no 3xx codes listed. Redirect behavior unspecified.

### Suggested resolution

1. **Validate `firecrestUrl` at construction time.** Reject non-HTTPS URLs. Optionally validate the hostname against a configured allowlist (default: `firecrest.cscs.ch`).
2. **Disable automatic redirect following** in the HTTP client, or only follow redirects to the same origin. Reject any 3xx response as an error (FirecREST is not expected to redirect).
3. **Add a security invariant** (e.g., F-INV-8): "The `firecrestUrl` MUST be an HTTPS URL. The HTTP client MUST NOT follow redirects to a different host. The JWT token MUST NOT appear in logs or error messages."
4. **Redact the `Authorization` header** from `internalDetails` in all `FirecrestError` subclasses. Add a test that no error class includes the token in its `internalDetails`.
5. **Add a Gherkin scenario**: "Given cera is configured with a non-HTTPS `firecrestUrl` / a URL with an unknown host / a URL that returns a 302 redirect, Then cera refuses to start and notifies the User."
