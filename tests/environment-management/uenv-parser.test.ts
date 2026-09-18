/**
 * Unit tests for uenv parser.
 *
 * Verifies parsing of uenv CLI output: status, list, mount, umount,
 * and name/version format.
 *
 * Spec: build-phases.md Phase 2; ADR-003; invariants.md INV-E3.
 */

import { describe, it, expect } from 'vitest';
import {
  parseUenvStatus,
  parseUenvList,
  parseUenvNameVersion,
  parseUenvMountResult,
  parseUenvUmountResult,
} from '../../src/environment-management/uenv-parser';
import {
  createMockExitOutcome,
  UENV_LIST_OUTPUT,
  UENV_LIST_SINGLE_OUTPUT,
  UENV_LIST_EMPTY_OUTPUT,
} from './helpers';

// ============================================================================
// parseUenvNameVersion
// ============================================================================

describe('@dev-only parseUenvNameVersion', () => {
  it('parses a name/version string', () => {
    const result = parseUenvNameVersion('cdo/2.0.5');
    expect(result.name).toBe('cdo');
    expect(result.version).toBe('2.0.5');
  });

  it('parses a name with dashes', () => {
    const result = parseUenvNameVersion('python-science/3.11.6');
    expect(result.name).toBe('python-science');
    expect(result.version).toBe('3.11.6');
  });

  it('parses a version with dashes', () => {
    const result = parseUenvNameVersion('cesm-intel/2.3.0');
    expect(result.name).toBe('cesm-intel');
    expect(result.version).toBe('2.3.0');
  });

  it('throws on empty string', () => {
    expect(() => parseUenvNameVersion('')).toThrow();
  });

  it('throws on string without slash', () => {
    expect(() => parseUenvNameVersion('cdonoversion')).toThrow();
  });

  it('throws on string starting with slash', () => {
    expect(() => parseUenvNameVersion('/2.0.5')).toThrow();
  });

  it('throws on string ending with slash', () => {
    expect(() => parseUenvNameVersion('cdo/')).toThrow();
  });
});

// ============================================================================
// parseUenvStatus (INV-E3)
// ============================================================================

describe('@dev-only parseUenvStatus', () => {
  it('returns true when exit code is 0 (uenv available)', () => {
    const exitOutcome = createMockExitOutcome({ kind: 'exit_code', code: 0 });
    expect(parseUenvStatus(exitOutcome)).toBe(true);
  });

  it('returns false when exit code is non-zero (uenv not found)', () => {
    const exitOutcome = createMockExitOutcome({ kind: 'exit_code', code: 1 });
    expect(parseUenvStatus(exitOutcome)).toBe(false);
  });

  it('returns false when terminated by signal', () => {
    const exitOutcome = createMockExitOutcome({
      kind: 'signal',
      name: 'SIGSEGV',
      number: 11,
    });
    expect(parseUenvStatus(exitOutcome)).toBe(false);
  });
});

// ============================================================================
// parseUenvList
// ============================================================================

describe('@dev-only parseUenvList', () => {
  it('parses multiple mounted uenvs', () => {
    const entries = parseUenvList(UENV_LIST_OUTPUT);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.name).toBe('cdo');
    expect(entries[0]?.version).toBe('2.0.5');
    expect(entries[0]?.mountPath).toBe('/user-environment/env/cdo/2.0.5');
    expect(entries[1]?.name).toBe('python-science');
    expect(entries[1]?.version).toBe('3.11.6');
  });

  it('parses a single mounted uenv', () => {
    const entries = parseUenvList(UENV_LIST_SINGLE_OUTPUT);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('cdo');
    expect(entries[0]?.version).toBe('2.0.5');
  });

  it('returns empty array for empty output', () => {
    const entries = parseUenvList(UENV_LIST_EMPTY_OUTPUT);
    expect(entries).toEqual([]);
  });

  it('skips blank lines', () => {
    const input = '\n\ncdo/2.0.5 /user-environment/env/cdo/2.0.5\n\n';
    const entries = parseUenvList(input);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('cdo');
  });

  it('handles multiple spaces between fields', () => {
    const input = 'cdo/2.0.5    /user-environment/env/cdo/2.0.5\n';
    const entries = parseUenvList(input);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.mountPath).toBe('/user-environment/env/cdo/2.0.5');
  });

  it('throws on malformed line (no space)', () => {
    expect(() => parseUenvList('cdo/2.0.5\n')).toThrow();
  });

  it('throws on malformed line (no version)', () => {
    expect(() => parseUenvList('cdo /user-environment/env/cdo\n')).toThrow();
  });
});

// ============================================================================
// parseUenvMountResult
// ============================================================================

describe('@dev-only parseUenvMountResult', () => {
  it('returns success when exit code is 0', () => {
    const result = parseUenvMountResult(
      createMockExitOutcome({ kind: 'exit_code', code: 0 }),
    );
    expect(result.success).toBe(true);
  });

  it('returns failure when exit code is non-zero', () => {
    const result = parseUenvMountResult(
      createMockExitOutcome({ kind: 'exit_code', code: 1 }),
      'uenv: error: mount failed: Input/output error',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Input/output error');
  });

  it('returns failure with generic message when stderr is empty', () => {
    const result = parseUenvMountResult(
      createMockExitOutcome({ kind: 'signal', name: 'SIGKILL', number: 9 }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ============================================================================
// parseUenvUmountResult
// ============================================================================

describe('@dev-only parseUenvUmountResult', () => {
  it('returns true when exit code is 0', () => {
    expect(
      parseUenvUmountResult(
        createMockExitOutcome({ kind: 'exit_code', code: 0 }),
      ),
    ).toBe(true);
  });

  it('returns false when exit code is non-zero', () => {
    expect(
      parseUenvUmountResult(
        createMockExitOutcome({ kind: 'exit_code', code: 1 }),
      ),
    ).toBe(false);
  });

  it('returns false when terminated by signal', () => {
    expect(
      parseUenvUmountResult(
        createMockExitOutcome({ kind: 'signal', name: 'SIGTERM', number: 15 }),
      ),
    ).toBe(false);
  });
});
