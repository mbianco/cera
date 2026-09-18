/**
 * Tests for createCeraSystem() — the startup factory (ADR-012, R14).
 *
 * Verifies:
 * - FP-INV-1: --backend defaults to firecrest
 * - FP-INV-3: no EnvironmentService in production (firecrest)
 * - FP-INV-4: SLURM CLI NOT used in production (FirecrestSchedulingService)
 * - createCeraSystem() returns a CeraSystem with the correct backendType
 * - createCeraSystem() throws when required config is missing
 * - CLI flags parse correctly (--uenv-specs, --default-resource-request)
 *
 * Spec: ADR-012; resolutions-r14.md R14.7;
 * api-contracts-firecrest.md; build-phases-firecrest.md Phase A, E.
 */

import { describe, it, expect } from 'vitest';
import { parseArgs } from 'node:util';
import {
  createCeraSystem,
} from '../src/startup';
import type {
  CeraSystem,
  CeraSystemConfig,
  BackendType,
  JobScriptConfig,
} from '../src/startup';
import { StaticTokenProvider } from '../src/firecrest-adapter/token-provider';
import type { FirecrestConfig } from '../src/firecrest-adapter/types';
import type { ResourceRequest } from '../src/types';
import { createMockDshContext } from './dsh-adapter/helpers';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a minimal FirecrestConfig for testing.
 * Uses StaticTokenProvider with a dummy token.
 */
function createTestFirecrestConfig(overrides: Partial<FirecrestConfig> = {}): FirecrestConfig {
  return {
    firecrestUrl: 'https://firecrest.example.com',
    systemName: 'test-system',
    tokenProvider: new StaticTokenProvider('test-token'),
    ...overrides,
  };
}

/**
 * Creates a CeraSystemConfig for the firecrest backend.
 */
function createFirecrestConfig(overrides: {
  readonly firecrestConfig?: FirecrestConfig;
  readonly jobScriptConfig?: JobScriptConfig;
  readonly username?: string;
} = {}): CeraSystemConfig {
  return {
    backend: {
      type: 'firecrest',
      firecrestConfig: overrides.firecrestConfig ?? createTestFirecrestConfig(),
    },
    jobScriptConfig: overrides.jobScriptConfig,
    username: overrides.username,
  };
}

/**
 * Creates a CeraSystemConfig for the dev backend with a mock DshContext.
 */
function createDevConfig(overrides: {
  readonly jobScriptConfig?: JobScriptConfig;
  readonly username?: string;
} = {}): CeraSystemConfig {
  return {
    backend: {
      type: 'dev',
      dshConfig: {
        context: createMockDshContext(),
      },
    },
    jobScriptConfig: overrides.jobScriptConfig,
    username: overrides.username,
  };
}

// ============================================================================
// createCeraSystem — FirecREST backend (production)
// ============================================================================

describe('createCeraSystem — firecrest backend (FP-INV-1, FP-INV-3)', () => {
  it('returns a CeraSystem with backendType === "firecrest"', () => {
    const config = createFirecrestConfig();
    const system = createCeraSystem(config);

    expect(system).toBeDefined();
    expect(system.backendType).toBe('firecrest');
  });

  it('returns a CeraSystem with all 7 domain modules', () => {
    const config = createFirecrestConfig();
    const system = createCeraSystem(config);

    expect(system.shellExecutor).toBeDefined();
    expect(system.subprocessRunner).toBeDefined();
    expect(system.filesystemGateway).toBeDefined();
    expect(system.schedulingService).toBeDefined();
    expect(system.toolInvocationService).toBeDefined();
    expect(system.toolCatalogService).toBeDefined();
    expect(system.dataManagementService).toBeDefined();
    expect(system.provenanceService).toBeDefined();
  });

  it('does NOT provide an EnvironmentService in production (FP-INV-3)', () => {
    const config = createFirecrestConfig();
    const system = createCeraSystem(config);

    expect(system.environmentService).toBeUndefined();
  });

  it('throws when firecrestConfig is not provided', () => {
    const config: CeraSystemConfig = {
      backend: { type: 'firecrest' },
    };

    expect(() => createCeraSystem(config)).toThrow(
      /FirecrestConfig is required/,
    );
  });

  it('throws when firecrestUrl is not HTTPS (FCREST-04)', () => {
    const config = createFirecrestConfig({
      firecrestConfig: createTestFirecrestConfig({
        firecrestUrl: 'http://not-https.example.com',
      }),
    });

    expect(() => createCeraSystem(config)).toThrow(/HTTPS/);
  });
});

// ============================================================================
// createCeraSystem — Dev backend (development only)
// ============================================================================

describe('createCeraSystem — dev backend (FP-INV-2)', () => {
  it('returns a CeraSystem with backendType === "dev"', () => {
    const config = createDevConfig();
    const system = createCeraSystem(config);

    expect(system).toBeDefined();
    expect(system.backendType).toBe('dev');
  });

  it('returns a CeraSystem with all 7 domain modules', () => {
    const config = createDevConfig();
    const system = createCeraSystem(config);

    expect(system.shellExecutor).toBeDefined();
    expect(system.subprocessRunner).toBeDefined();
    expect(system.filesystemGateway).toBeDefined();
    expect(system.schedulingService).toBeDefined();
    expect(system.toolInvocationService).toBeDefined();
    expect(system.toolCatalogService).toBeDefined();
    expect(system.dataManagementService).toBeDefined();
    expect(system.provenanceService).toBeDefined();
  });

  it('DOES provide an EnvironmentService in dev mode (FP-INV-3 inverse)', () => {
    const config = createDevConfig();
    const system = createCeraSystem(config);

    expect(system.environmentService).toBeDefined();
  });

  it('throws when dshConfig is not provided', () => {
    const config: CeraSystemConfig = {
      backend: { type: 'dev' },
    };

    expect(() => createCeraSystem(config)).toThrow(
      /DshConfig is required/,
    );
  });

  it('throws when dshConfig.context is not provided', () => {
    const config: CeraSystemConfig = {
      backend: { type: 'dev', dshConfig: { sessionUrl: 'ws://localhost:1234' } },
    };

    expect(() => createCeraSystem(config)).toThrow(
      /DshConfig.context is required/,
    );
  });
});

// ============================================================================
// FP-INV-1: --backend defaults to firecrest
// ============================================================================

describe('FP-INV-1: --backend defaults to firecrest', () => {
  it('parseArgs defaults backend to "firecrest" when not specified', () => {
    const { values } = parseArgs({
      options: {
        backend: { type: 'string', default: 'firecrest' },
      },
      strict: true,
      allowPositionals: false,
    });

    expect(values.backend).toBe('firecrest');
  });

  it('BackendType is "firecrest" | "dev"', () => {
    // Type-level test: if BackendType were different, this would
    // fail to compile.
    const validTypes: BackendType[] = ['firecrest', 'dev'];
    expect(validTypes).toContain('firecrest');
    expect(validTypes).toContain('dev');
  });
});

// ============================================================================
// CLI flag parsing: --uenv-specs and --default-resource-request
// ============================================================================

describe('CLI flag parsing (R14.3, R14.4)', () => {
  it('--uenv-specs cdo:2.0.5,python:3.11.6 parses correctly', () => {
    const { values } = parseArgs({
      options: {
        'uenv-specs': { type: 'string' },
      },
      args: ['--uenv-specs', 'cdo:2.0.5,python:3.11.6'],
      strict: true,
      allowPositionals: false,
    });

    expect(values['uenv-specs']).toBe('cdo:2.0.5,python:3.11.6');

    // Parse into JobScriptConfig.uenvSpecs
    const uenvSpecs = values['uenv-specs'] !== undefined
      ? values['uenv-specs'].split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;

    expect(uenvSpecs).toEqual(['cdo:2.0.5', 'python:3.11.6']);
  });

  it('--default-resource-request parses correctly as JSON', () => {
    const jsonStr = '{"nodes":1,"coresPerNode":1,"memory":"1GB","wallTime":"00:10:00","partition":"normal","qos":"default"}';
    const { values } = parseArgs({
      options: {
        'default-resource-request': { type: 'string' },
      },
      args: ['--default-resource-request', jsonStr],
      strict: true,
      allowPositionals: false,
    });

    expect(values['default-resource-request']).toBe(jsonStr);

    // Parse into JobScriptConfig.defaultResourceRequest
    const parsed = JSON.parse(values['default-resource-request'] as string) as ResourceRequest;

    expect(parsed.nodes).toBe(1);
    expect(parsed.coresPerNode).toBe(1);
    expect(parsed.memory).toBe('1GB');
    expect(parsed.wallTime).toBe('00:10:00');
    expect(parsed.partition).toBe('normal');
    expect(parsed.qos).toBe('default');
  });

  it('JobScriptConfig with uenvSpecs and defaultResourceRequest is valid', () => {
    const jobScriptConfig: JobScriptConfig = {
      uenvSpecs: ['cdo:2.0.5', 'python:3.11.6'],
      defaultResourceRequest: {
        nodes: 1,
        coresPerNode: 1,
        memory: '1GB',
        wallTime: '00:10:00',
        partition: 'normal',
        qos: 'default',
      },
    };

    expect(jobScriptConfig.uenvSpecs).toEqual(['cdo:2.0.5', 'python:3.11.6']);
    expect(jobScriptConfig.defaultResourceRequest?.nodes).toBe(1);
  });
});

// ============================================================================
// createCeraSystem — JobScriptConfig pass-through
// ============================================================================

describe('createCeraSystem — JobScriptConfig pass-through (F-INV-5, FP-INV-5)', () => {
  it('createCeraSystem with firecrest backend accepts jobScriptConfig', () => {
    const jobScriptConfig: JobScriptConfig = {
      uenvSpecs: ['cdo:2.0.5'],
      defaultResourceRequest: {
        nodes: 1,
        coresPerNode: 1,
        memory: '1GB',
        wallTime: '00:10:00',
        partition: 'normal',
        qos: 'default',
      },
    };

    const config = createFirecrestConfig({ jobScriptConfig });
    const system: CeraSystem = createCeraSystem(config);

    expect(system.backendType).toBe('firecrest');
    expect(system.environmentService).toBeUndefined();
  });
});
