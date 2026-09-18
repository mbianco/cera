## Finding: Username derivation from JWT not specified or implemented — proactive Job reporting broken
Severity: Medium
Category: Correctness > Specification compliance; Implicit coupling
Location: `src/startup.ts` lines 144, 207–209; `src/cli.ts` line 214; `src/firecrest-adapter/types.ts` lines 29–48 (JwtTokenProvider)
Spec reference: R7 (Agent resumes Jobs); ADR-007 (proactive Job reporting); CeraSystemConfig.username; FP-FM-2

### Description

The `CeraSystemConfig.username` field (`startup.ts` line 144) is
documented as: "In production, this is derived from the JWT token's
`preferred_username` claim. In dev, the local username."

**Problem 1: No mechanism to derive the username from the JWT.**
The `JwtTokenProvider` interface (`firecrest-adapter/types.ts` lines
29–48) has three methods: `getToken()`, `refreshToken()`, and
`isExpired()`. None of these return the username or the decoded JWT
claims. To extract `preferred_username`, cera would need to:
- Decode the JWT (base64 decode the payload)
- Or call an OIDC userinfo endpoint
- Or have the JwtTokenProvider expose the claims

None of these are specified in the API contracts or build phases.

**Problem 2: The CLI stub sets `username: undefined`.** The
commented-out code at `cli.ts` line 214:
```typescript
username: undefined, // derived from JWT
```
With `username: undefined`, `queryJobsByUser()` would need to query
ALL Jobs on the system (no username filter) or fail with "no
username provided." Both outcomes break R7 (proactive Job
reporting).

**Problem 3: FP-FM-2 (laptop crash recovery) depends on this.**
FP-FM-2 says "the Agent proactively queries
`FirecRESTSchedulingService.queryJobsByUser()`" — but without a
username, this query cannot be made. The entire laptop crash
recovery mechanism is broken without username derivation.

**Problem 4: The `createCeraSystem()` factory doesn't extract the
username.** The `createFirecrestSystem()` function (lines 240–277)
is a stub that throws "not yet implemented." The commented-out code
shows how the factory would be called, but there's no code to
extract `preferred_username` from the token and pass it as
`CeraSystemConfig.username`.

### Evidence

1. `src/startup.ts` line 144: `readonly username?: string;` —
   optional, no default.
2. `src/cli.ts` line 214: `username: undefined, // derived from JWT`
   — no derivation code.
3. `src/firecrest-adapter/types.ts` lines 29–48: `JwtTokenProvider`
   has `getToken()`, `refreshToken()`, `isExpired()` — no
   `getUsername()` or `getClaims()`.
4. `api-contracts-firecrest.md` lines 207–209: "In production, this
   is derived from the JWT token's `preferred_username` claim." —
   assertion without mechanism.
5. `specs/architecture/build-phases-firecrest.md` Phase A (lines
   36–44): `createCeraSystem()` stub described, no mention of
   username derivation.
6. `specs/failure-modes-firecrest-primary.md` lines 913–914:
   FP-FM-2 depends on `queryJobsByUser()`, which requires a
   username.

### Suggested resolution

Add a `getClaims(): Promise<Record<string, unknown>>` method (or
`getUsername(): Promise<string>`) to the `JwtTokenProvider`
interface. Specify in `createCeraSystem()` (Phase A) that the
factory extracts `preferred_username` from the token and passes it
as `CeraSystemConfig.username`. Add a test that verifies the
username is set for the FirecREST backend.
