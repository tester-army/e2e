/** The `evidence` option: on by default, off by the config, `E2E_EVIDENCE`, or `--no-evidence`, and the screenshot default it sets. */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig, type CliOverrides } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import type { E2EConfig, Target } from '../../src/types.ts';
import { snapshot } from '../helpers/snapshot.ts';

const ROOT = '/tmp/e2e-evidence-project';

function target(extra: Partial<Target> = {}): Target {
  const engine = defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]) });
  return { name: 'web', platform: 'web', engine, ...extra };
}

function resolve(raw: Partial<E2EConfig> = {}, env: NodeJS.ProcessEnv = {}, cli: CliOverrides = {}) {
  return resolveConfig({ targets: [target()], ...raw }, { projectRoot: ROOT, env, cli });
}

describe('evidence option', () => {
  it('is on by default, writing L1 packs under <output>/evidence', () => {
    expect(resolve().evidence).toEqual({ outDir: path.join(ROOT, '.e2e', 'evidence'), profile: 'L1' });
    expect(resolve({ output: 'results' }).evidence?.outDir).toBe(path.join(ROOT, 'results', 'evidence'));
  });

  it('takes an outDir inside the project and a profile', () => {
    expect(resolve({ evidence: { outDir: 'packs', profile: 'L0' } }).evidence).toEqual({ outDir: path.join(ROOT, 'packs'), profile: 'L0' });
    expect(resolve({ evidence: true }).evidence?.profile).toBe('L1');
  });

  it('is off with evidence: false or enabled: false', () => {
    expect(resolve({ evidence: false }).evidence).toBeUndefined();
    expect(resolve({ evidence: { enabled: false } }).evidence).toBeUndefined();
  });

  it('is off with E2E_EVIDENCE=0, false, or off, and ignores any other value', () => {
    for (const value of ['0', 'false', 'off', 'OFF']) expect(resolve({}, { E2E_EVIDENCE: value }).evidence).toBeUndefined();
    for (const value of ['1', 'true', '']) expect(resolve({}, { E2E_EVIDENCE: value }).evidence).toBeDefined();
  });

  it('is off with --no-evidence, whatever the config and the environment say', () => {
    expect(resolve({ evidence: true }, { E2E_EVIDENCE: '1' }, { evidence: false }).evidence).toBeUndefined();
  });

  it('refuses a profile, an outDir, or a shape it does not know', () => {
    expect(() => resolve({ evidence: { profile: 'L2' } as never })).toThrow("evidence.profile must be 'L0' or 'L1', got \"L2\"");
    expect(() => resolve({ evidence: { outDir: '../elsewhere' } })).toThrow(/evidence.outDir "..\/elsewhere" must be a directory inside the project/);
    expect(() => resolve({ evidence: { output: 'x' } as never })).toThrow(/evidence has unknown key "output"/);
    expect(() => resolve({ evidence: { outDir: '.e2e/cache/packs' } })).toThrow(/evidence.outDir .* is the cache directory .* or inside it/);
    expect(() => resolve({ evidence: { outDir: '.e2e/artifacts/packs' } })).toThrow(/evidence.outDir .* is inside .*artifacts.*, which every run clears/);
    expect(() => resolve({ evidence: 'yes' as never })).toThrow(/evidence must be true, false, or \{ enabled\?, outDir\?, profile\? \}/);
  });

  it('never enters the config digest', () => {
    expect(resolve({ evidence: false }).configDigest).toBe(resolve().configDigest);
  });
});

describe('the screenshot default under evidence', () => {
  it('is every-step while evidence is on, on-failure when it is off', () => {
    expect(resolve().targets[0]!.screenshot).toBe('every-step');
    expect(resolve({ evidence: false }).targets[0]!.screenshot).toBe('on-failure');
    expect(resolve({}, {}, { evidence: false }).targets[0]!.screenshot).toBe('on-failure');
  });

  it('gives way to a mode somebody set', () => {
    expect(resolve({ screenshot: 'on-failure' }).targets[0]!.screenshot).toBe('on-failure');
    expect(resolve({ targets: [target({ screenshot: 'off' })] }).targets[0]!.screenshot).toBe('off');
    expect(resolve({}, {}, { screenshot: 'off' }).targets[0]!.screenshot).toBe('off');
  });
});
