#!/usr/bin/env node
/**
 * cera CLI entry point.
 *
 * Under R14 (ADR-012), FirecREST is the only production HPC transport.
 * dsh runs on the laptop. The `--backend` flag defaults to `firecrest`.
 * The `--backend dev` flag is for development only (was `--backend local`).
 *
 * Usage:
 *   cera --backend firecrest [options]    Run on a laptop via FirecREST (production)
 *   cera --backend dev                    Run locally for development (requires dsh)
 *
 * FirecREST backend (default):
 *   cera --firecrest-url https://firecrest.cscs.ch \
 *     --system daint \
 *     --token-endpoint https://idp.cscs.ch/auth/realms/cscs/protocol/openid-connect/token \
 *     --client-id cera-client \
 *     --client-secret <secret> \
 *     --uenv-specs cdo:2.0.5,python:3.11.6
 *
 * Dev backend:
 *   cera --backend dev
 *
 * Spec: docs/getting-started.md; ADR-012; resolutions-r14.md R14.7.
 */

import { parseArgs } from 'node:util';

// ============================================================================
// Argument parsing
// ============================================================================

const { values: args } = parseArgs({
  options: {
    backend: { type: 'string', default: 'firecrest' },
    'firecrest-url': { type: 'string' },
    system: { type: 'string', default: 'daint' },
    'token-endpoint': { type: 'string' },
    'client-id': { type: 'string' },
    'client-secret': { type: 'string' },
    'uenv-specs': { type: 'string' },
    'default-resource-request': { type: 'string' },
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
  cera --backend firecrest [options]    Run on a laptop via FirecREST (production)
  cera --backend dev                    Run locally for development (requires dsh)

Options:
  --backend <firecrest|dev>             Backend to use (default: firecrest)
  --firecrest-url <url>                 FirecREST server URL (HTTPS required)
  --system <name>                       Target HPC system (default: daint)
  --token-endpoint <url>                OIDC token endpoint URL
  --client-id <id>                      OIDC client ID
  --client-secret <secret>              OIDC client secret
  --uenv-specs <spec1,spec2,...>        uenv specs to embed in Job scripts (F-INV-5)
  --default-resource-request <json>     Default ResourceRequest for formerly-synchronous
                                        ToolInvations (JSON string)
  --help                                Show this help
  --version                             Show version

Environment variables:
  CERA_BACKEND                          Same as --backend (default: firecrest)
  CERA_FIRECREST_URL                    Same as --firecrest-url
  CERA_SYSTEM                            Same as --system
  CERA_TOKEN_ENDPOINT                   Same as --token-endpoint
  CERA_CLIENT_ID                         Same as --client-id
  CERA_CLIENT_SECRET                    Same as --client-secret
  CERA_UENV_SPECS                       Same as --uenv-specs (comma-separated)

Note:
  --backend dev is for development only. It requires a running dsh
  instance and is NOT a production path (FP-INV-2).
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

const backend = args.backend ?? process.env.CERA_BACKEND ?? 'firecrest';
const firecrestUrl = args['firecrest-url'] ?? process.env.CERA_FIRECREST_URL ?? '';
const systemName = args.system ?? process.env.CERA_SYSTEM ?? 'daint';
const tokenEndpoint = args['token-endpoint'] ?? process.env.CERA_TOKEN_ENDPOINT ?? '';
const clientId = args['client-id'] ?? process.env.CERA_CLIENT_ID ?? '';
const clientSecret = args['client-secret'] ?? process.env.CERA_CLIENT_SECRET ?? '';
const uenvSpecsStr = args['uenv-specs'] ?? process.env.CERA_UENV_SPECS ?? '';
const defaultResourceRequestStr = args['default-resource-request'] ?? '';

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  if (backend === 'firecrest') {
    await runFirecrestBackend();
  } else if (backend === 'dev') {
    await runDevBackend();
  } else {
    console.error(`Unknown backend: '${backend}'. Use 'firecrest' (production) or 'dev' (development only).`);
    process.exit(1);
  }
}

// ============================================================================
// FirecREST backend (production)
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
    console.error('       The JWT token is sent in the Authorization header —');
    console.error('       non-HTTPS URLs would expose it in cleartext.');
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

  // Parse uenv specs (comma-separated)
  const uenvSpecs = uenvSpecsStr
    ? uenvSpecsStr.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;

  // Parse default ResourceRequest (JSON string)
  let defaultResourceRequest: Record<string, unknown> | undefined;
  if (defaultResourceRequestStr) {
    try {
      defaultResourceRequest = JSON.parse(defaultResourceRequestStr);
    } catch {
      console.error('Error: --default-resource-request must be valid JSON.');
      console.error('       Example: \'{"nodes":1,"coresPerNode":1,"memory":"1GB","wallTime":"00:10:00","partition":"normal","qos":"default"}\'');
      process.exit(1);
    }
  }

  console.log('cera — starting with FirecREST backend (production)');
  console.log(`  FirecREST URL: ${firecrestUrl}`);
  console.log(`  System: ${systemName}`);
  console.log(`  Token endpoint: ${tokenEndpoint}`);
  console.log(`  Client ID: ${clientId}`);
  if (uenvSpecs && uenvSpecs.length > 0) {
    console.log(`  uenv specs: ${uenvSpecs.join(', ')} (F-INV-5)`);
  }
  if (defaultResourceRequest) {
    console.log(`  Default ResourceRequest: ${JSON.stringify(defaultResourceRequest)} (FP-INV-5)`);
  }
  console.log();

  // The actual wiring would be:
  //
  //   import { createCeraSystem } from 'cera';
  //   import { OidcTokenProvider } from 'cera';
  //
  //   const system = createCeraSystem({
  //     backend: {
  //       type: 'firecrest',
  //       firecrestConfig: {
  //         firecrestUrl,
  //         systemName,
  //         tokenProvider: new OidcTokenProvider({
  //           tokenEndpoint,
  //           clientId,
  //           clientSecret,
  //         }),
  //         defaultResourceRequest,
  //       },
  //     },
  //     jobScriptConfig: {
  //       uenvSpecs,
  //       defaultResourceRequest,
  //     },
  //     username: undefined, // derived from JWT
  //   });
  //
  //   // ... start Session, register Actions, enter agent loop

  console.log('FirecREST backend configured. Connecting...');
  console.log();
  console.log('This is a development preview. The full FirecREST backend');
  console.log('wiring (SessionService, ActionService, agent loop, LLM');
  console.log('adapter) is implemented but requires a running LLM.');
  console.log();
  console.log('To verify the FirecREST connection:');
  console.log('  curl -H "Authorization: Bearer <token>" \\');
  console.log(`    ${firecrestUrl}/status/${systemName}/healthchecks`);
}

// ============================================================================
// Dev backend (development only)
// ============================================================================

async function runDevBackend(): Promise<void> {
  console.log('cera — starting with dev backend (development only)');
  console.log(`  System: ${systemName}`);
  console.log();

  // The actual wiring would be:
  //
  //   import { createCeraSystem } from 'cera';
  //
  //   const system = createCeraSystem({
  //     backend: {
  //       type: 'dev',
  //       dshConfig: {
  //         systemName,
  //       },
  //     },
  //     username: process.env.USER,
  //   });
  //
  //   // ... start Session, register Actions, enter agent loop

  console.log('Dev backend requires a running dsh context.');
  console.log('On the HPC login node, start dsh first:');
  console.log('  uenv start @deepseek-ai/dsh --');
  console.log('  dsh web  # or: dsh --profile headless');
  console.log();
  console.log('Then connect cera to the dsh session via the dsh SDK.');
  console.log();
  console.log('NOTE: --backend dev is for development only (FP-INV-2).');
  console.log('      For production, use --backend firecrest (default).');
}

// ============================================================================
// Entry point
// ============================================================================

main().catch((error: unknown) => {
  console.error('cera: fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
