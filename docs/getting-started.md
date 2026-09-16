# Getting Started

## Prerequisites

- **Node.js 22+** (built-in `fetch`, `AbortController`, ES2022)
- **npm** (or pnpm)
- An HPC account at CSCS (for production use)
- For the **local backend**: SSH access to an Alps login node
- For the **FirecREST backend**: a valid OIDC token from the CSCS identity provider

## Installation

### From source (development)

```bash
git clone git@github.com:mbianco/cera.git
cd cera
npm install
```

### From npm tarball (production)

Download the latest release tarball from [GitHub Releases](https://github.com/mbianco/cera/releases),
then install on the target machine:

```bash
# On the Alps login node (inside a uenv that provides Node.js 22)
uenv start nodejs:22 --
npm install -g cera-0.1.0.tgz
```

Or on a laptop with the FirecREST backend:

```bash
npm install -g cera-0.1.0.tgz
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

cera supports two backends, selected at startup:

### Local backend (default)

Runs on the Alps login node. Invokes tools (CDO, NCO, CESM) via
local subprocess. Uses uenv (squashfs mounts) for environment
management.

```bash
cera --backend local
```

No additional configuration required — cera detects the SLURM
environment and uenv registry automatically.

### FirecREST backend

Runs on a laptop. Accesses Alps HPC resources via FirecREST's REST
API. No SSH or VPN required — uses OIDC (JWT Bearer token) for
authentication.

```bash
cera --backend firecrest \
  --firecrest-url https://firecrest.cscs.ch \
  --system daint \
  --token-endpoint https://idp.cscs.ch/auth/realms/cscs/protocol/openid-connect/token \
  --client-id cera-client \
  --client-secret <secret>
```

Under the FirecREST backend:

- All ToolInvocations are submitted as SLURM Jobs (even short CDO
  commands that were "synchronous" under the local backend)
- uenv is loaded inside the Job script, not by cera directly
- Provenance records are written to the HPC filesystem via FirecREST
  file endpoints
- File access is remote (HTTP), with synchronous transfer for files
  ≤5MB and asynchronous transfer for larger files

## Your first Workflow

A Workflow is an ordered sequence of ToolInvocations with data
dependencies. Here's a conceptual example:

```typescript
import { createFullSystem } from 'cera';

// 1. Create a Session
const session = await sessionService.startSession({
  username: 'cera_user',
  hpcAccount: 's1234',
  slurmUsername: 'cera_user',
});

// 2. Create an Experiment
const experiment = await experimentService.createExperiment({
  name: 'CO2 doubling sensitivity study',
  researchQuestion: 'How does TAS respond to doubled CO2?',
});

// 3. Create a Workflow
const workflow = await workflowService.createWorkflow({
  name: 'historical_analysis',
  experimentId: experiment.id,
});

// 4. Add steps
await workflowService.addWorkflowStep(workflow.id, {
  order: 1,
  name: 'select_variable',
  toolId: 'cdo',
  parameters: { operatorChain: '-selname,TAS' },
  inputDatasetIds: ['tas_historical_2000-2010'],
  executionModel: 'synchronous',
});

await workflowService.addWorkflowStep(workflow.id, {
  order: 2,
  name: 'time_mean',
  toolId: 'cdo',
  parameters: { operatorChain: '-timmean' },
  inputDatasetIds: [], // filled from step 1 output
  executionModel: 'synchronous',
});

// 5. Start the Workflow
await workflowService.startWorkflow(workflow.id);
```

## Next steps

- [Architecture](architecture/index.md) — module graph, bounded contexts, ADRs
- [API Reference](api-reference/index.md) — TypeScript interfaces for all 7 modules
- [ADRs](adrs/index.md) — 11 Architecture Decision Records
- [Contributing](https://github.com/mbianco/cera/blob/main/CONTRIBUTING.md) — dev setup, coding standards, PR process
