/**
 * JWT token provider implementations for the FirecREST backend (F-INV-2).
 *
 * Provides two implementations of the JwtTokenProvider interface:
 * - StaticTokenProvider — takes a pre-existing token (for testing)
 * - OidcTokenProvider — uses the OIDC client credentials grant to
 *   obtain tokens from an identity provider (e.g., CSCS Keycloak)
 *
 * On 401, the FirecREST client calls `refreshToken()` and retries
 * the request (FM-F-2). If refresh fails (OIDC provider unreachable,
 * credentials revoked), the User is notified that authentication
 * has expired.
 *
 * Spec: specs/firecrest/invariants.md F-INV-2;
 * specs/firecrest/failure-modes.md FM-F-2;
 * specs/firecrest/assumptions.md F-V-2;
 * ADR-011.
 */

import type { JwtTokenProvider } from './types';

// ============================================================================
// StaticTokenProvider
// ============================================================================

/**
 * A JwtTokenProvider that returns a pre-existing, static token.
 *
 * This is primarily for testing — tests can inject a known token
 * without mocking the OIDC provider. The `refreshToken()` method
 * always throws because a static token cannot be refreshed.
 *
 * Optionally, `expiresAt` can be provided to control the `isExpired()`
 * return value for testing expiry scenarios.
 *
 * Spec: specs/firecrest/invariants.md F-INV-2 (testing use).
 */
export class StaticTokenProvider implements JwtTokenProvider {
  #token: string;
  #expiresAt: Date | null;

  constructor(token: string, options?: { expiresAt?: Date }) {
    this.#token = token;
    this.#expiresAt = options?.expiresAt ?? null;
  }

  async getToken(): Promise<string> {
    return this.#token;
  }

  async refreshToken(): Promise<string> {
    throw new Error(
      'StaticTokenProvider cannot refresh a static token. ' +
        'Provide a new token or use OidcTokenProvider for automatic refresh.',
    );
  }

  isExpired(): boolean {
    if (this.#expiresAt === null) {
      return false;
    }
    return Date.now() >= this.#expiresAt.getTime();
  }
}

// ============================================================================
// OidcTokenProvider
// ============================================================================

/**
 * Response body from the OIDC token endpoint.
 */
interface OidcTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
}

/**
 * A JwtTokenProvider that obtains tokens via the OIDC client
 * credentials grant.
 *
 * The token is cached and automatically refreshed when expired.
 * On `refreshToken()`, a new POST request is made to the token
 * endpoint with `grant_type=client_credentials`, `client_id`, and
 * `client_secret` in the body (URL-encoded).
 *
 * Spec: specs/firecrest/invariants.md F-INV-2;
 * specs/firecrest/assumptions.md F-V-2;
 * specs/firecrest/failure-modes.md FM-F-2;
 * ADR-011.
 */
export class OidcTokenProvider implements JwtTokenProvider {
  #tokenEndpoint: string;
  #clientId: string;
  #clientSecret: string;
  #cachedToken: string | null = null;
  #expiresAt: number | null = null;

  constructor(tokenEndpoint: string, clientId: string, clientSecret: string) {
    this.#tokenEndpoint = tokenEndpoint;
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
  }

  async getToken(): Promise<string> {
    if (this.#cachedToken !== null && !this.isExpired()) {
      return this.#cachedToken;
    }
    return this.refreshToken();
  }

  async refreshToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
    });

    let response: Response;
    try {
      response = await fetch(this.#tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      throw new Error(
        `OIDC token request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(
        `OIDC token request failed with status ${response.status}: ${text}`,
      );
    }

    let json: OidcTokenResponse;
    try {
      json = (await response.json()) as OidcTokenResponse;
    } catch (error) {
      throw new Error(
        `OIDC token response is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
      throw new Error('OIDC token response is missing access_token');
    }

    this.#cachedToken = json.access_token;
    this.#expiresAt = Date.now() + json.expires_in * 1000;

    return this.#cachedToken;
  }

  isExpired(): boolean {
    if (this.#cachedToken === null || this.#expiresAt === null) {
      return true;
    }
    return Date.now() >= this.#expiresAt;
  }
}
