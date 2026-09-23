/**
 * Smoke test against a real FirecREST v2 instance.
 *
 * Usage:
 *   CERA_CLIENT_ID=your-client-id \
 *   CERA_CLIENT_SECRET=your-secret \
 *   CERA_TOKEN_ENDPOINT=https://auth.cscs.ch/auth/realms/firecrest-clients/protocol/openid-connect/token \
 *   CERA_FIRECREST_URL=https://api.cscs.ch/cw/firecrest/v2 \
 *   CERA_SYSTEM=santis \
 *   node dist/smoke-test.mjs
 *
 * Steps:
 *   1. Obtain a JWT token from the OIDC provider
 *   2. List available systems + health (GET /status/systems)
 *   3. List files in home directory (GET /filesystem/{system}/ops/ls?path=~)
 *   4. Stat home directory (GET /filesystem/{system}/ops/stat?path=~)
 *   5. Submit a trivial SLURM Job (POST /compute/{system}/jobs)
 *   6. Query the Job state (GET /compute/{system}/jobs/{jobId})
 *
 * Each step prints pass/fail. On failure, the test continues to the
 * next step (except Step 1 — without a token, nothing works).
 */

import { OidcTokenProvider } from '../src/firecrest-adapter/token-provider';
import { FirecrestClientImpl } from '../src/firecrest-adapter/firecrest-client';

// ============================================================================
// Configuration from environment
// ============================================================================

const FIRECREST_URL = process.env.CERA_FIRECREST_URL ?? 'https://api.cscs.ch/cw/firecrest/v2';
const SYSTEM = process.env.CERA_SYSTEM ?? 'santis';
const TOKEN_ENDPOINT = process.env.CERA_TOKEN_ENDPOINT ?? '';
const CLIENT_ID = process.env.CERA_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.CERA_CLIENT_SECRET ?? '';

if (!TOKEN_ENDPOINT) {
  console.error('Error: CERA_TOKEN_ENDPOINT is required.');
  console.error('       Example: https://auth.cscs.ch/auth/realms/firecrest-clients/protocol/openid-connect/token');
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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('cera — FirecREST v2 smoke test');
  console.log(`  FirecREST URL: ${FIRECREST_URL}`);
  console.log(`  System:        ${SYSTEM}`);
  console.log(`  Token endpoint: ${TOKEN_ENDPOINT}`);
  console.log(`  Client ID:     ${CLIENT_ID}`);

  // ── Step 1: Obtain JWT token ──────────────────────────────────
  hr('Step 1: Obtain JWT token');

  const tokenProvider = new OidcTokenProvider(TOKEN_ENDPOINT, CLIENT_ID, CLIENT_SECRET);

  let token: string;
  try {
    token = await tokenProvider.getToken();
    if (!token || token.length < 10) {
      throw new Error('Token is empty or too short');
    }
    ok(`Token obtained (${token.length} chars, ${token.slice(0, 20)}...)`);
    ok(`Token is ${tokenProvider.isExpired() ? 'expired' : 'valid'}`);
  } catch (error) {
    fail(`Failed to obtain token: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const client = new FirecrestClientImpl({
    firecrestUrl: FIRECREST_URL,
    systemName: SYSTEM,
    tokenProvider,
  });

  // ── Step 2: List systems + health (GET /status/systems) ───────
  hr('Step 2: List systems + health (GET /status/systems)');

  let systemsData: unknown = null;
  try {
    const response = await client.get<unknown>('/status/systems');
    if (response.statusCode === 200) {
      systemsData = response.body;
      const body = response.body as { systems?: Array<Record<string, unknown>> };
      if (body.systems && Array.isArray(body.systems)) {
        const names = body.systems.map((s) => String(s.name ?? 'unknown'));
        ok(`Systems listed: ${names.join(', ')}`);

        // Find our system and show health
        const ourSystem = body.systems.find((s) => s.name === SYSTEM);
        if (ourSystem) {
          const health = ourSystem.servicesHealth as Array<Record<string, unknown>> | undefined;
          if (health && Array.isArray(health)) {
            for (const h of health) {
              const type = String(h.serviceType ?? 'unknown');
              const healthy = h.healthy === true;
              const msg = h.message ? String(h.message) : 'OK';
              ok(`Health [${type}]: ${healthy ? 'healthy' : 'UNHEALTHY'} — ${msg}`);

              // Show scheduler info if available
              if (type === 'scheduler' && h.nodes) {
                const nodes = h.nodes as { available?: number; total?: number };
                console.log(`    Nodes: ${nodes.available ?? '?'}/${nodes.total ?? '?'}`);
              }
            }
          } else {
            ok(`No servicesHealth data for ${SYSTEM}`);
          }
        } else {
          fail(`System '${SYSTEM}' not found in systems list`);
          console.log(`  Available: ${names.join(', ')}`);
        }
      } else {
        ok(`Systems returned 200 (non-standard format)`);
        console.log(`  ${truncate(JSON.stringify(response.body), 300)}`);
      }
    } else {
      fail(`List systems returned ${response.statusCode}`);
      console.log(`  ${truncate(JSON.stringify(response.body), 200)}`);
    }
  } catch (error) {
    fail(`List systems failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ── Step 3: List files in home directory ──────────────────────
  hr(`Step 3: List files in home directory (GET /filesystem/${SYSTEM}/ops/ls?path=~)`);

  try {
    const response = await client.get<unknown>(`/filesystem/${SYSTEM}/ops/ls?path=~`);
    if (response.statusCode === 200) {
      const body = response.body as unknown;
      if (Array.isArray(body)) {
        const entries = body as Array<Record<string, unknown>>;
        ok(`Listed ${entries.length} entries in home directory`);
        const names = entries.slice(0, 15).map((e) => {
          const name = String(e.name ?? 'unknown');
          const isDir = e.type === 'd' || e.type === 'directory';
          return isDir ? `${name}/` : name;
        });
        console.log(`  First ${names.length}: ${names.join(', ')}`);
        if (entries.length > 15) {
          console.log(`  ... and ${entries.length - 15} more`);
        }
      } else {
        ok(`List returned 200`);
        console.log(`  ${truncate(JSON.stringify(body), 300)}`);
      }
    } else {
      fail(`List home returned ${response.statusCode}`);
      console.log(`  ${truncate(JSON.stringify(response.body), 200)}`);
    }
  } catch (error) {
    fail(`List home failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ── Step 4: Stat home directory ───────────────────────────────
  hr(`Step 4: Stat home directory (GET /filesystem/${SYSTEM}/ops/stat?path=~)`);

  try {
    const response = await client.get<unknown>(`/filesystem/${SYSTEM}/ops/stat?path=~`);
    if (response.statusCode === 200) {
      const stat = response.body as Record<string, unknown>;
      ok(`Stat succeeded (200)`);
      console.log(`  Size:      ${stat.size ?? 'unknown'}`);
      console.log(`  Is dir:    ${stat.isDir ?? stat.isDirectory ?? 'unknown'}`);
      console.log(`  Modified:  ${stat.mtime ?? 'unknown'}`);
      console.log(`  Mode:      ${stat.mode ?? 'unknown'}`);
    } else {
      fail(`Stat returned ${response.statusCode}`);
      console.log(`  ${truncate(JSON.stringify(response.body), 200)}`);
    }
  } catch (error) {
    fail(`Stat failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ── Step 5: Submit a trivial SLURM Job ────────────────────────
  hr(`Step 5: Submit trivial SLURM Job (POST /compute/${SYSTEM}/jobs)`);

  let jobId: number | null = null;
  try {
    const jobScript = `#!/bin/bash\n#SBATCH --job-name=cera-smoke\n#SBATCH --time=00:01:00\n#SBATCH --nodes=1\n#SBATCH --ntasks=1\necho "cera smoke test $(date)" > /tmp/cera-smoke-${Date.now()}.txt\n`;
    const response = await client.post<unknown>(`/compute/${SYSTEM}/jobs`, {
      jobScript,
    });

    if (response.statusCode === 200 || response.statusCode === 201) {
      const body = response.body as Record<string, unknown>;
      // Try different possible response formats
      jobId = typeof body.jobId === 'number' ? body.jobId
        : typeof body.job_id === 'number' ? body.job_id
        : typeof body.jobid === 'number' ? body.jobid
        : null;

      if (jobId !== null) {
        ok(`Job submitted successfully (jobId: ${jobId})`);
      } else {
        ok(`Job submission returned ${response.statusCode} (jobId not found in response)`);
        console.log(`  ${truncate(JSON.stringify(body), 300)}`);
      }
    } else {
      fail(`Job submission returned ${response.statusCode}`);
      console.log(`  ${truncate(JSON.stringify(response.body), 300)}`);
    }
  } catch (error) {
    fail(`Job submission failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ── Step 6: Query Job state ───────────────────────────────────
  hr(`Step 6: Query Job state (GET /compute/${SYSTEM}/jobs/${jobId})`);

  if (jobId !== null) {
    try {
      // Wait a moment for the job to appear
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const response = await client.get<unknown>(`/compute/${SYSTEM}/jobs/${jobId}`);
      if (response.statusCode === 200) {
        const job = response.body as Record<string, unknown>;
        const state = job.state ?? job.jobState ?? 'unknown';
        ok(`Job ${jobId} state: ${state}`);
        console.log(`  ${truncate(JSON.stringify(job), 300)}`);

        // If PENDING or RUNNING, suggest polling
        const stateStr = String(state).toLowerCase();
        if (stateStr === 'pending' || stateStr === 'running') {
          console.log(`  (Job is still ${state}. Poll again in a few seconds.)`);
        }
      } else if (response.statusCode === 404) {
        // Job may have already completed — try sacct-style query
        ok(`Job ${jobId} not found in active queue (may have already completed)`);
        console.log(`  Try: GET /compute/${SYSTEM}/jobs?jobId=${jobId} or sacct-style query`);
      } else {
        fail(`Job query returned ${response.statusCode}`);
        console.log(`  ${truncate(JSON.stringify(response.body), 200)}`);
      }
    } catch (error) {
      fail(`Job query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    console.log('  (Skipped — no jobId from Step 5)');
  }

  // ── Summary ───────────────────────────────────────────────────
  hr('Summary');
  console.log('  Smoke test complete.');
  console.log();
  console.log('  If Steps 1-4 passed, cera can:');
  console.log('    - Authenticate with OIDC');
  console.log('    - Query system health');
  console.log('    - List and stat files on the HPC filesystem');
  console.log();
  console.log('  If Steps 5-6 passed, cera can:');
  console.log('    - Submit SLURM Jobs via FirecREST');
  console.log('    - Query Job state');
  console.log();
  console.log('  Next steps:');
  console.log('    - Submit a real CDO command as a SLURM Job');
  console.log('    - Poll until COMPLETED, then read the output');
  console.log('    - Write a ProvenanceRecord for the output Dataset');
}

main().catch((error: unknown) => {
  console.error('\ncera smoke test: fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
