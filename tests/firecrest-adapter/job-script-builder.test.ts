/**
 * Tests for the Job script builder (F-INV-5).
 *
 * Verifies:
 * - Plain command (no uenv, no env)
 * - With uenv specs (F-INV-5 — uenv loaded in Job scripts, not by cera)
 * - With environment variables
 * - With both uenv and env
 *
 * Spec: specs/firecrest/invariants.md F-INV-5;
 * specs/firecrest/features/firecrest-backend.feature (uenv scenarios);
 * ADR-011.
 */

import { describe, it, expect } from 'vitest';
import { buildJobScript } from '../../src/firecrest-adapter/job-script-builder';

describe('buildJobScript', () => {
  describe('plain command (no uenv, no env)', () => {
    it('builds a bash script wrapping the command', () => {
      const script = buildJobScript('cdo -timmean input.nc output.nc');

      expect(script).toContain('#!/bin/bash');
      expect(script).toContain('cdo -timmean input.nc output.nc');
    });

    it('places the command after the shebang', () => {
      const script = buildJobScript('echo hello');

      const lines = script.split('\n');
      expect(lines[0]).toBe('#!/bin/bash');
      expect(lines[lines.length - 1]).toBe('echo hello');
    });

    it('does not include uenv start when no uenvSpecs provided', () => {
      const script = buildJobScript('ncks -v TAS in.nc');

      expect(script).not.toContain('uenv start');
    });

    it('does not include export when no env provided', () => {
      const script = buildJobScript('ncks -v TAS in.nc');

      expect(script).not.toMatch(/^export /m);
    });
  });

  describe('with uenv specs (F-INV-5)', () => {
    it('prepends uenv start before the command', () => {
      const script = buildJobScript('cdo -timmean input.nc output.nc', {
        uenvSpecs: ['cdo:2.0.5'],
      });

      expect(script).toContain('uenv start cdo:2.0.5 --');
      expect(script).toContain('cdo -timmean input.nc output.nc');
      // uenv start must come before the command
      const uenvIdx = script.indexOf('uenv start');
      const cmdIdx = script.indexOf('cdo -timmean');
      expect(uenvIdx).toBeLessThan(cmdIdx);
      expect(uenvIdx).toBeGreaterThan(0);
    });

    it('prepends multiple uenv specs in order', () => {
      const script = buildJobScript('python script.py', {
        uenvSpecs: ['cdo:2.0.5', 'python:3.11'],
      });

      expect(script).toContain('uenv start cdo:2.0.5 --');
      expect(script).toContain('uenv start python:3.11 --');
      // cdo must come before python, both before the command
      const cdoIdx = script.indexOf('uenv start cdo:2.0.5');
      const pythonIdx = script.indexOf('uenv start python:3.11');
      const cmdIdx = script.indexOf('python script.py');
      expect(cdoIdx).toBeLessThan(pythonIdx);
      expect(pythonIdx).toBeLessThan(cmdIdx);
    });

    it('does NOT call uenv mount or uenv status (F-INV-5)', () => {
      const script = buildJobScript('cdo -timmean in.nc out.nc', {
        uenvSpecs: ['cdo:2.0.5'],
      });

      expect(script).not.toContain('uenv mount');
      expect(script).not.toContain('uenv status');
    });

    it('handles empty uenvSpecs array (no uenv start)', () => {
      const script = buildJobScript('echo hello', {
        uenvSpecs: [],
      });

      expect(script).not.toContain('uenv start');
      expect(script).toContain('echo hello');
    });
  });

  describe('with environment variables', () => {
    it('prepends export statements before the command', () => {
      const script = buildJobScript('cdo -timmean in.nc out.nc', {
        env: { LD_LIBRARY_PATH: '/opt/lib', OMP_NUM_THREADS: '4' },
      });

      expect(script).toContain('export LD_LIBRARY_PATH=/opt/lib');
      expect(script).toContain('export OMP_NUM_THREADS=4');
      expect(script).toContain('cdo -timmean in.nc out.nc');
      // exports must come before the command
      const exportIdx = script.indexOf('export ');
      const cmdIdx = script.indexOf('cdo -timmean');
      expect(exportIdx).toBeLessThan(cmdIdx);
      expect(exportIdx).toBeGreaterThan(0);
    });

    it('handles empty env object (no export)', () => {
      const script = buildJobScript('echo hello', {
        env: {},
      });

      expect(script).not.toMatch(/^export /m);
      expect(script).toContain('echo hello');
    });

    it('handles single environment variable', () => {
      const script = buildJobScript('echo $FOO', {
        env: { FOO: 'bar' },
      });

      expect(script).toContain('export FOO=bar');
    });
  });

  describe('with both uenv and env', () => {
    it('prepends uenv and env before the command', () => {
      const script = buildJobScript('cdo -timmean in.nc out.nc', {
        uenvSpecs: ['cdo:2.0.5'],
        env: { OMP_NUM_THREADS: '8' },
      });

      expect(script).toContain('uenv start cdo:2.0.5 --');
      expect(script).toContain('export OMP_NUM_THREADS=8');
      expect(script).toContain('cdo -timmean in.nc out.nc');
    });

    it('places shebang first, then uenv, then env, then command', () => {
      const script = buildJobScript('python run.py', {
        uenvSpecs: ['cdo:2.0.5', 'python:3.11'],
        env: { OMP_NUM_THREADS: '8', FOO: 'bar' },
      });

      const lines = script.split('\n');
      expect(lines[0]).toBe('#!/bin/bash');

      // Find indices
      const shebangIdx = 0;
      const firstUenvIdx = lines.findIndex((l) => l.startsWith('uenv start'));
      const firstExportIdx = lines.findIndex((l) => l.startsWith('export '));
      const cmdIdx = lines.findIndex((l) => l.startsWith('python run.py'));

      expect(firstUenvIdx).toBeGreaterThan(shebangIdx);
      expect(firstExportIdx).toBeGreaterThan(firstUenvIdx);
      expect(cmdIdx).toBeGreaterThan(firstExportIdx);
    });

    it('includes all uenv specs and all env vars', () => {
      const script = buildJobScript('tool', {
        uenvSpecs: ['a:1', 'b:2', 'c:3'],
        env: { X: '1', Y: '2', Z: '3' },
      });

      expect(script).toContain('uenv start a:1 --');
      expect(script).toContain('uenv start b:2 --');
      expect(script).toContain('uenv start c:3 --');
      expect(script).toContain('export X=1');
      expect(script).toContain('export Y=2');
      expect(script).toContain('export Z=3');
      expect(script).toContain('tool');
    });
  });
});
