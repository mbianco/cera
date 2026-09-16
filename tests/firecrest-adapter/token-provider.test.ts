/**
 * Tests for the token provider implementations (F-INV-2).
 *
 * Verifies:
 * - StaticTokenProvider returns the configured token
 * - OidcTokenProvider obtains token via client credentials grant
 * - OidcTokenProvider refreshes when expired
 * - OidcTokenProvider throws when refresh fails
 *
 * Spec: specs/firecrest/invariants.md F-INV-2;
 * specs/firecrest/failure-modes.md FM-F-2;
 * ADR-011.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StaticTokenProvider,
  OidcTokenProvider,
} from '../../src/firecrest-adapter/token-provider';

// ============================================================================
// StaticTokenProvider
// ============================================================================

describe('StaticTokenProvider', () => {
  it('returns the configured token', async () => {
    const provider = new StaticTokenProvider('my-static-token');

    const token = await provider.getToken();

    expect(token).toBe('my-static-token');
  });

  it('returns the same token on repeated calls', async () => {
    const provider = new StaticTokenProvider('abc123');

    const t1 = await provider.getToken();
    const t2 = await provider.getToken();

    expect(t1).toBe('abc123');
    expect(t2).toBe('abc123');
  });

  it('isExpired returns false by default (never expires)', () => {
    const provider = new StaticTokenProvider('abc123');

    expect(provider.isExpired()).toBe(false);
  });

  it('isExpired returns true when configured with expiresAt in the past', () => {
    const provider = new StaticTokenProvider('abc123', {
      expiresAt: new Date('2020-01-01T00:00:00Z'),
    });

    expect(provider.isExpired()).toBe(true);
  });

  it('isExpired returns false when configured with expiresAt in the future', () => {
    const future = new Date(Date.now() + 3_600_000);
    const provider = new StaticTokenProvider('abc123', { expiresAt: future });

    expect(provider.isExpired()).toBe(false);
  });

  it('refreshToken throws — static tokens cannot be refreshed', async () => {
    const provider = new StaticTokenProvider('abc123');

    await expect(provider.refreshToken()).rejects.toThrow();
  });
});

// ============================================================================
// OidcTokenProvider
// ============================================================================

describe('OidcTokenProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchResponse(
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  describe('client credentials grant', () => {
    it('obtains a token via POST to the token endpoint', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          access_token: 'oidc-token-123',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      globalThis.fetch = fetchMock;

      const provider = new OidcTokenProvider(
        'https://oidc.example.com/token',
        'client-id',
        'client-secret',
      );

      const token = await provider.getToken();

      expect(token).toBe('oidc-token-123');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('https://oidc.example.com/token');
      expect(init?.method).toBe('POST');
      const bodyStr = String(init?.body ?? '');
      expect(bodyStr).toContain('grant_type=client_credentials');
      expect(bodyStr).toContain('client_id=client-id');
      expect(bodyStr).toContain('client_secret=client-secret');
    });

    it('caches the token and does not re-fetch on subsequent calls', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          access_token: 'cached-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      globalThis.fetch = fetchMock;

      const provider = new OidcTokenProvider(
        'https://oidc.example.com/token',
        'cid',
        'csecret',
      );

      await provider.getToken();
      await provider.getToken();
      await provider.getToken();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('token expiry', () => {
    it('isExpired returns false when token is fresh', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          access_token: 'fresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      globalThis.fetch = fetchMock;

      const provider = new OidcTokenProvider(
        'https://oidc.example.com/token',
        'cid',
        'csecret',
      );

      await provider.getToken();

      expect(provider.isExpired()).toBe(false);
    });

    it('isExpired returns true before any token is obtained', () => {
      const provider = new OidcTokenProvider(
        'https://oidc.example.com/token',
        'cid',
        'csecret',
      );

      expect(provider.isExpired()).toBe(true);
    });

    it('isExpired returns true when expires_in has passed', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          access_token: 'expired-soon',
          token_type: 'Bearer',
          expires_in: 0,
        }),
      );
      globalThis.fetch = fetchMock;

      const provider = new OidcTokenProvider(
        'https://oidc.example.com/token',
        'cid',
        'csecret',
      );

      await provider.getToken();

      // expires_in=0 means the token expires immediately
      expect(provider.isExpired()).toBe(true);
    });

    it('refreshes the token when expired', async () => {
      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(
          mockFetchResponse({
            access_token: `token-${callCount}`,
            token_type: 'Bearer',
            expires_in: 0, // expires immediately
          }),
        );
      });
      globalThis.fetch = fetchMock;

      const provider = new OidcTokenProvider(
        'https://oidc.example.com/token',
        'cid',
        'csecret',
      );

      const t1 = await provider.getToken();
      expect(t1).toBe('token-1');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Token is expired, so getToken should refresh
      const t2 = await provider.getToken();
      expect(t2).toBe('token-2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refreshToken returns a new token', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          access_token: 'refreshed-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      globalThis.fetch = fetchMock;

      const provider = new OidcTokenProvider(
        'https://oidc.example.com/token',
        'cid',
        'csecret',
      );

      const token = await provider.refreshToken();

      expect(token).toBe('refreshed-token');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('refresh failure', () => {
    it('throws when the OIDC provider returns non-200', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ error: 'invalid_client' }, 401),
      );
      globalThis.fetch = fetchMock;

      const provider = new OidcTokenProvider(
        'https://oidc.example.com/token',
        'bad-id',
        'bad-secret',
      );

      await expect(provider.getToken()).rejects.toThrow();
    });

    it('throws when the OIDC provider is unreachable', async () => {
      const fetchMock = vi.fn().mockRejectedValue(
        new Error('network error: connection refused'),
      );
      globalThis.fetch = fetchMock;

      const provider = new OidcTokenProvider(
        'https://oidc.example.com/token',
        'cid',
        'csecret',
      );

      await expect(provider.getToken()).rejects.toThrow();
    });

    it('throws when the response is missing access_token', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ error: 'something' }, 200),
      );
      globalThis.fetch = fetchMock;

      const provider = new OidcTokenProvider(
        'https://oidc.example.com/token',
        'cid',
        'csecret',
      );

      await expect(provider.getToken()).rejects.toThrow();
    });

    it('refreshToken throws when the OIDC provider fails', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      globalThis.fetch = fetchMock;

      const provider = new OidcTokenProvider(
        'https://oidc.example.com/token',
        'cid',
        'csecret',
      );

      await expect(provider.refreshToken()).rejects.toThrow();
    });
  });
});
