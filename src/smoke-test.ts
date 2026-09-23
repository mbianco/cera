/**
 * Smoke test against a real FirecREST instance.
 *
 * This is a manual test — NOT part of the automated test suite.
 * Run it after building with:
 *
 *   CERA_CLIENT_ID=your-client-id \
 *   CERA_CLIENT_SECRET=your-secret \
 *   CERA_TOKEN_ENDPOINT=https://idp.cscs.ch/auth/realms/cscs/protocol/openid-connect/token \
 *   CERA_FIRECREST_URL=https://firecrest.cscs.ch \
 *   CERA_SYSTEM=daint \
 *   node dist/smoke-test.mjs
 *
 * Or with environment variables already set:
 *   node dist/smoke-test.mjs
 *
 * The test performs the following steps in order:
 *   1. Obtain a JWT token from the OIDC provider
 *   2. Check FirecREST health (GET /status/{system}/healthchecks)
 *   3. List available systems (GET /status/systems)
 *   4. List files in your home directory (GET /filesystem/{system}/path/~)
 *   5. Stat your home directory (GET /filesystem/{system}/stat/~)
 *
 * Each step prints the result. If any step fails, the test stops
 * and prints the error.
 */

import { OidcTokenProvider } from '../src/firecrest-adapter/token-provider';
import { FirecrestClientImpl } from '../src/firecrest-adapter/firecrest-client';

// ============================================================================
// Configuration from environment
// ============================================================================

const FIRECREST_URL = process.env.CERA_FIRECREST_URL ?? 'https://firecrest.cscs.ch';
const SYSTEM = process.env.CERA_SYSTEM ?? 'daint';
const TOKEN_ENDPOINT = process.env.CERA_TOKEN_ENDPOINT ?? '';
const CLIENT_ID = process.env.CERA_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.CERA_CLIENT_SECRET ?? '';

if (!TOKEN_ENDPOINT) {
  console.error('Error: CERA_TOKEN_ENDPOINT is required.');
  console.error('       Example: https://idp.cscs.ch/auth/realms/cscs/protocol/openid-connect/token');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('Error: CERA_CLIENT_ID is required.');
  process.exit(1);
}
if (!CLIENT_SECRET) {
  console.error('Error: CERA_CLIENT_SECRET is required.');
  console.error('       (Set as environment variable — do not hardcode.)');
  process.exit(1);
}

// ============================================================================
// Helpers
// ============================================================================

function hr(label: string): void {
  console.log();
  console.log(`── ${label} ` + '─'.repeat(Math.max(0, 60 - label.length)));
}

function ok(msg: string): void {
  console.log(`  \u2713 ${msg}`);
}

function fail(msg: string): void {
  console.error(`  \u2717 ${msg}`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('cera — FirecREST smoke test');
  console.log(`  FirecREST URL: ${FIRECREST_URL}`);
  console.log(`  System:        ${SYSTEM}`);
  console.log(`  Token endpoint: ${TOKEN_ENDPOINT}`);
  console.log(`  Client ID:     ${CLIENT_ID}`);

  // ── Step 1: Obtain JWT token ──────────────────────────────────
  hr('Step 1: Obtain JWT token');

  let token: string;
  try {
    const provider = new OidcTokenProvider(TOKEN_ENDPOINT, CLIENT_ID, CLIENT_SECRET);
    token = await provider.getToken();
    if (!token || token.length < 10) {
      throw new Error('Token is empty or too short');
    }
    ok(`Token obtained (${token.length} chars, ${token.slice(0, 20)}...)`);
    ok(`Token expires in ${provider.isExpired() ? 'expired' : 'valid'}`);
  } catch (error) {
    fail(`Failed to obtain token: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // ── Step 2: Check FirecREST health ────────────────────────────
  hr(`Step 2: Check FirecREST health (${SYSTEM})`);

  const client = new FirecrestClientImpl({
    firecrestUrl: FIRECREST_URL,
    systemName: SYSTEM,
    tokenProvider: new OidcTokenProvider(TOKEN_ENDPOINT, CLIENT_ID, CLIENT_SECRET),
  });

  try {
    const response = await client.get<unknown>(`/status/${SYSTEM}/healthchecks`);
    if (response.statusCode === 200) {
      ok(`Health check passed (200)`);
      console.log(`  Response: ${JSON.stringify(response.body).slice(0, 200)}...`);
    } else {
      fail(`Health check returned ${response.statusCode}`);
      console.log(`  Body: ${JSON.stringify(response.body).slice(0, 200)}`);
    }
  } catch (error) {
    fail(`Health check failed: ${error instanceof Error ? error.message : String(error)}`);
    // Continue — health check may be unavailable but other endpoints work
  }

  // ── Step 3: List available systems ────────────────────────────
  hr('Step 3: List available systems');

  try {
    const response = await client.get<unknown>('/status/systems');
    if (response.statusCode === 200) {
      ok(`Systems listed (200)`);
      const body = response.body as Record<string, unknown>;
      if (Array.isArray(body)) {
        const systems = body.map((s: Record<string, unknown>) =>
          s.system_name ?? s.name ?? JSON.stringify(s).slice(0, 30)
        );
        console.log(`  Available systems: ${systems.join(', ')}`);
      } else {
        console.log(`  Response: ${JSON.stringify(body).slice(0, 300)}`);
      }
    } else {
      fail(`List systems returned ${response.statusCode}`);
      console.log(`  Body: ${JSON.stringify(response.body).slice(0, 200)}`);
    }
  } catch (error) {
    fail(`List systems failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ── Step 4: List files in home directory ──────────────────────
  hr(`Step 4: List files in home directory (~ on ${SYSTEM})`);

  try {
    const response = await client.get<unknown>(`/filesystem/${SYSTEM}/path/~`);
    if (response.statusCode === 200) {
      const body = response.body as unknown;
      if (Array.isArray(body)) {
        const entries = body as Array<Record<string, unknown>>;
        ok(`Listed ${entries.length} entries in home directory`);
        const names = entries.slice(0, 20).map((e) =>
          `${e.name ?? 'unknown'}${e.type === 'd' || e.type === 'directory' ? '/' : ''}`
        );
        console.log(`  First ${names.length} entries: ${names.join(', ')}`);
        if (entries.length > 20) {
          console.log(`  ... and ${entries.length - 20} more`);
        }
      } else {
        ok(`List returned 200 (non-array body)`);
        console.log(`  Response: ${JSON.stringify(body).slice(0, 300)}`);
      }
    } else {
      fail(`List home returned ${response.statusCode}`);
      console.log(`  Body: ${JSON.stringify(response.body).slice(0, 200)}`);
    }
  } catch (error) {
    fail(`List home failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ── Step 5: Stat home directory ───────────────────────────────
  hr(`Step 5: Stat home directory (~ on ${SYSTEM})`);

  try {
    const response = await client.get<unknown>(`/filesystem/${SYSTEM}/stat/~`);
    if (response.statusCode === 200) {
      const stat = response.body as Record<string, unknown>;
      ok(`Stat succeeded (200)`);
      console.log(`  Size:      ${stat.size ?? 'unknown'}`);
      console.log(`  Is dir:    ${stat.isDir ?? stat.isDirectory ?? 'unknown'}`);
      console.log(`  Modified:  ${stat.mtime ?? 'unknown'}`);
      console.log(`  Mode:      ${stat.mode ?? 'unknown'}`);
    } else {
      fail(`Stat returned ${response.statusCode}`);
      console.log(`  Body: ${JSON.stringify(response.body).slice(0, 200)}`);
    }
  } catch (error) {
    fail(`Stat failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ── Summary ───────────────────────────────────────────────────
  hr('Summary');
  console.log('  Smoke test complete. If all steps passed,');
  console.log('  cera can communicate with FirecREST on Alps.');
  console.log();
  console.log('  Next steps:');
  console.log('    1. Try listing a specific directory (e.g., /scratch/snx3000/$USER)');
  console.log('    2. Try statting a specific file');
  console.log('    3. Submit a trivial SLURM Job (echo "hello" > /tmp/cera-test.txt)');
  console.log('    4. Query the Job state until COMPLETED');
  console.log('    5. Read the output file');
}

main().catch((error: unknown) => {
  console.error('\ncera smoke test: fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
