# Getting Started

## Prerequisites

- **Node.js 24+** (built-in `fetch`, `AbortController`, ES2022)
- **npm** (or pnpm)
- An HPC account at CSCS (for production use)
- An OIDC client registered with the CSCS identity provider
  (client ID + secret for FirecREST authentication)

## Installation

### From source (development)

```bash
git clone git@github.com:mbianco/cera.git
cd cera
npm install
```

### From npm tarball (production)

Download the latest release tarball from
[GitHub Releases](https://github.com/mbianco/cera/releases), then
install on the target machine:

```bash
# On a laptop (FirecREST backend — production)
npm install -g cera-0.1.0.tgz

# Set credentials via environment variables (recommended)
export CERA_FIRECREST_URL=https://firecrest.cscs.ch
export CERA_SYSTEM=daint
export CERA_TOKEN_ENDPOINT=https://idp.cscs.ch/auth/realms/cscs/protocol/openid-connect/token
export CERA_CLIENT_ID=cera-client
export CERA_CLIENT_SECRET=<your-secret>
export CERA_UENV_SPECS=cdo:2.0.5,python:3.11.6

# Run
cera --backend firecrest
```

## Verification

```bash
# Typecheck
npm run typecheck

# Lint (zero warnings allowed)
npm run lint

# Fast tests (Tier 1 — unit + property)
npm run test:fast

# Full suite (all tests including integration)
npm run test:full

# Build
npm run build
```

## Configuration

cera uses the **FirecREST backend** as the primary (and only
production) HPC transport (R14, ADR-012). dsh runs on the laptop;
all HPC operations — Job submission, file access, tool execution — go
through FirecREST's REST API.

### FirecREST backend (production, default)

```bash
cera --backend firecrest \
  --firecrest-url https://firecrest.cscs.ch \
  --system daint \
  --token-endpoint https://idp.cscs.ch/auth/realms/cscs/protocol/openid-connect/token \
  --client-id cera-client \
  --client-secret $CERA_CLIENT_SECRET \
  --uenv-specs cdo:2.0.5,python:3.11.6
```

Under the FirecREST backend:

- **All ToolInvocations are parallel** (F-INV-6) — even short CDO
  commands are submitted as SLURM Jobs via FirecREST's compute endpoints.
- **uenv is loaded in Job scripts** (F-INV-5) — cera embeds
  `uenv start <spec> --` in the Job script, not by calling uenv
  directly.
- **Provenance records** are written to the HPC filesystem via
  FirecREST file endpoints.
- **File access** is remote (HTTP), with synchronous transfer for files
  ≤5MB and asynchronous transfer for larger files (F-INV-4).
- **Authentication** is OIDC (JWT Bearer token, F-INV-2). The token's
  `preferred_username` claim maps to the HPC user.
- **Default ResourceRequest** (FP-INV-5) — formerly-synchronous
  ToolInvocations get minimal resources (1 node, 1 core, 1GB, 10 min).

### Dev backend (development only)

```bash
cera --backend dev
```

The dev backend uses the dsh-adapter (local subprocess) for testing
without a real FirecREST instance. It requires a running dsh instance
and supports synchronous execution and direct uenv management.

**The dev backend is NOT a production path** (FP-INV-2). It bypasses
FirecREST security and should only be used for development.

### Environment variables

| Variable | Same as | Default |
|----------|---------|---------|
| `CERA_BACKEND` | `--backend` | `firecrest` |
| `CERA_FIRECREST_URL` | `--firecrest-url` | (required for firecrest) |
| `CERA_SYSTEM` | `--system` | `daint` |
| `CERA_TOKEN_ENDPOINT` | `--token-endpoint` | (required for firecrest) |
| `CERA_CLIENT_ID` | `--client-id` | (required for firecrest) |
| `CERA_CLIENT_SECRET` | `--client-secret` | (required, prefer env var) |
| `CERA_UENV_SPECS` | `--uenv-specs` | (comma-separated, e.g. `cdo:2.0.5,python:3.11.6`) |

## Your first Workflow

A Workflow is an ordered sequence of ToolInvocations with data
dependencies. Here's a conceptual example:

```typescript
import { createCeraSystem } from 'cera';
import { OidcTokenProvider } from 'cera';

// 1. Create the system (FirecREST backend)
const system = createCeraSystem({
  backend: {
    type: 'firecrest',
    firecrestConfig: {
      firecrestUrl: 'https://firecrest.cscs.ch',
      systemName: 'daint',
      tokenProvider: new OidcTokenProvider({
        tokenEndpoint: 'https://idp.cscs.ch/auth/realms/cscs/protocol/openid-connect/token',
        clientId: 'cera-client',
        clientSecret: process.env.CERA_CLIENT_SECRET!,
      }),
    },
  },
  jobScriptConfig: {
    uenvSpecs: ['cdo:2.0.5', 'python:3.11.6'],
  },
});

// 2. Create a Session (proactive Job reporting, R7)
const session = await system.sessionService.startSession({
  username: 'cera_user',
  hpcAccount: 's1234',
  slurmUsername: 'cera_user',
});

// 3. Create an Experiment
const experiment = await system.experimentService.createExperiment({
  name: 'CO2 doubling sensitivity study',
  researchQuestion: 'How does TAS respond to doubled CO2?',
});

// 4. Create a Workflow
const workflow = await system.workflowService.createWorkflow({
  name: 'historical_analysis',
  experimentId: experiment.id,
});

// 5. Add steps
await system.workflowService.addWorkflowStep(workflow.id, {
  order: 1,
  name: 'select_variable',
  toolId: 'cdo',
  parameters: { operatorChain: '-selname,TAS' },
  inputDatasetIds: ['tas_historical_2000-2010'],
  executionModel: 'synchronous', // ignored in production (F-INV-6)
});

await system.workflowService.addWorkflowStep(workflow.id, {
  order: 2,
  name: 'time_mean',
  toolId: 'cdo',
  parameters: { operatorChain: '-timmean' },
  inputDatasetIds: [], // filled from step 1 output
  executionModel: 'synchronous', // ignored in production (F-INV-6)
});

// 6. Start the Workflow
await system.workflowService.startWorkflow(workflow.id);
```

## Next steps

- [Architecture](architecture/index.md) — module graph, bounded
  contexts, ADRs
- [API Reference](api-reference/index.md) — TypeScript interfaces for
  all 8 modules
- [ADRs](adrs/index.md) — 12 Architecture Decision Records
- [Contributing](https://github.com/mbianco/cera/blob/main/CONTRIBUTING.md)
  — dev setup, coding standards, PR process
