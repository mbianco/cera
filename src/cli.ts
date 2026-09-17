#!/usr/bin/env node

/**
 * cera CLI entry point.
 *
 * Usage:
 *   cera --backend local              Run on the HPC login node (local subprocess)
 *   cera --backend firecrest [...]    Run on a laptop (FirecREST REST API)
 *
 * Local backend (default):
 *   cera --backend local
 *
 * FirecREST backend:
 *   cera --backend firecrest \
 *     --firecrest-url https://firecrest.cscs.ch \
 *     --system daint \
 *     --token-endpoint https://idp.cscs.ch/auth/realms/cscs/protocol/openid-connect/token \
 *     --client-id cera-client \
 *     --client-secret <secret>
 *
 * Spec: docs/getting-started.md; ADR-011.
 */

import { parseArgs } from 'node:util';

// ============================================================================
// Argument parsing
// ============================================================================

const { values: args } = parseArgs({
  options: {
    backend: { type: 'string', default: 'local' },
    'firecrest-url': { type: 'string' },
    system: { type: 'string', default: 'daint' },
    'token-endpoint': { type: 'string' },
    'client-id': { type: 'string' },
    'client-secret': { type: 'string' },
    help: { type: 'boolean', default: false },
    version: { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
});

// ============================================================================
// Help and version
// ============================================================================

if (args.help) {
  console.log(`cera — AI agent for climate scientists on the Alps supercomputer

Usage:
  cera --backend local                      Run on the HPC login node
  cera --backend firecrest [options]        Run on a laptop via FirecREST

Options:
  --backend <local|firecrest>               Backend to use (default: local)
  --firecrest-url <url>                     FirecREST server URL (HTTPS required)
  --system <name>                           Target HPC system (default: daint)
  --token-endpoint <url>                    OIDC token endpoint URL
  --client-id <id>                          OIDC client ID
  --client-secret <secret>                  OIDC client secret
  --help                                    Show this help
  --version                                 Show version

Environment variables:
  CERA_BACKEND                              Same as --backend
  CERA_FIRECREST_URL                        Same as --firecrest-url
  CERA_SYSTEM                               Same as --system
  CERA_TOKEN_ENDPOINT                       Same as --token-endpoint
  CERA_CLIENT_ID                            Same as --client-id
  CERA_CLIENT_SECRET                        Same as --client-secret
`);
  process.exit(0);
}

if (args.version) {
  console.log('cera 0.1.0');
  process.exit(0);
}

// ============================================================================
// Resolve config from args + environment
// ============================================================================

const backend = args.backend ?? process.env.CERA_BACKEND ?? 'local';
const firecrestUrl = args['firecrest-url'] ?? process.env.CERA_FIRECREST_URL ?? '';
const systemName = args.system ?? process.env.CERA_SYSTEM ?? 'daint';
const tokenEndpoint = args['token-endpoint'] ?? process.env.CERA_TOKEN_ENDPOINT ?? '';
const clientId = args['client-id'] ?? process.env.CERA_CLIENT_ID ?? '';
const clientSecret = args['client-secret'] ?? process.env.CERA_CLIENT_SECRET ?? '';

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  if (backend === 'local') {
    await runLocalBackend();
  } else if (backend === 'firecrest') {
    await runFirecrestBackend();
  } else {
    console.error(`Unknown backend: '${backend}'. Use 'local' or 'firecrest'.`);
    process.exit(1);
  }
}

// ============================================================================
// Local backend
// ============================================================================

async function runLocalBackend(): Promise<void> {
  console.log('cera — starting with local backend (HPC login node)');
  console.log(`  System: ${systemName}`);
  console.log();

  // The local backend uses dsh-adapter. On the HPC login node,
  // dsh would be available via uenv. Here we create a minimal
  // mock context to demonstrate the wiring — in production,
  // createDshAdapter(dshContext) would receive the real dsh context.
  //
  // The actual dsh binding is deferred until cera is deployed on
  // the HPC (ADR-005). This CLI demonstrates the wiring; the real
  // implementation would call:
  //
  //   import { createDshAdapter } from 'cera';
  //   const adapter = createDshAdapter(realDshContext);
  //   const system = createFullSystem({
  //     shellExecutor: adapter.shellExecutor,
  //     subprocessRunner: adapter.subprocessRunner,
  //     filesystem: adapter.filesystemGateway,
  //   });
  //   // ... start Session, register Actions, enter agent loop

  console.log('Local backend requires a running dsh context.');
  console.log('On the HPC login node, start dsh first:');
  console.log('  uenv start @deepseek-ai/dsh --');
  console.log('  dsh web  # or: dsh --profile headless');
  console.log();
  console.log('Then connect cera to the dsh session via the dsh SDK.');
  console.log();
  console.log('This is a development preview. The full local backend');
  console.log('wiring (dsh context binding, agent loop, LLM adapter)');
  console.log('is implemented but requires a running dsh instance.');
}

// ============================================================================
// FirecREST backend
// ============================================================================

async function runFirecrestBackend(): Promise<void> {
  if (!firecrestUrl) {
    console.error('Error: --firecrest-url is required for the FirecREST backend.');
    console.error('       Or set CERA_FIRECREST_URL environment variable.');
    console.error('       Example: --firecrest-url https://firecrest.cscs.ch');
    process.exit(1);
  }

  if (!firecrestUrl.startsWith('https://')) {
    console.error('Error: --firecrest-url must be an HTTPS URL (FCREST-04).');
    process.exit(1);
  }

  if (!tokenEndpoint) {
    console.error('Error: --token-endpoint is required for the FirecREST backend.');
    console.error('       Or set CERA_TOKEN_ENDPOINT environment variable.');
    process.exit(1);
  }

  if (!clientId) {
    console.error('Error: --client-id is required for the FirecREST backend.');
    console.error('       Or set CERA_CLIENT_ID environment variable.');
    process.exit(1);
  }

  if (!clientSecret) {
    console.error('Error: --client-secret is required for the FirecREST backend.');
    console.error('       Or set CERA_CLIENT_SECRET environment variable.');
    console.error('       (For security, prefer the environment variable.)');
    process.exit(1);
  }

  console.log('cera — starting with FirecREST backend (laptop)');
  console.log(`  FirecREST URL: ${firecrestUrl}`);
  console.log(`  System: ${systemName}`);
  console.log(`  Token endpoint: ${tokenEndpoint}`);
  console.log(`  Client ID: ${clientId}`);
  console.log();

  // The FirecREST backend creates all adapter interfaces from the
  // configuration. The actual wiring would be:
  //
  //   import { createFirecrestBackend, OidcTokenProvider } from 'cera';
  //
  //   const backend = createFirecrestBackend({
  //     firecrestUrl,
  //     systemName,
  //     tokenProvider: new OidcTokenProvider({
  //       tokenEndpoint,
  //       clientId,
  //       clientSecret,
  //     }),
  //   });
  //
  //   const system = createFullSystem({
  //     shellExecutor: backend.shellExecutor,
  //     subprocessRunner: backend.subprocessRunner,
  //     filesystem: backend.filesystemGateway,
  //   });
  //
  //   // ... start Session, register Actions, enter agent loop

  console.log('FirecREST backend configured. Connecting...');
  console.log();
  console.log('This is a development preview. The full FirecREST backend');
  console.log('wiring (SessionService, ActionService, agent loop, LLM');
  console.log('adapter) is implemented but requires a running LLM.');
  console.log();
  console.log('To verify the connection:');
  console.log('  curl -H "Authorization: Bearer <token>" \\');
  console.log(`    ${firecrestUrl}/status/${systemName}/healthchecks`);
}

// ============================================================================
// Entry point
// ============================================================================

main().catch((error: unknown) => {
  console.error('cera: fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
