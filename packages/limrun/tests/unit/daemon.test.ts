import { beforeEach, expect, it, vi } from 'vitest';
import { assertDriverVersion } from '../../src/daemon.ts';

const mocks = vi.hoisted(() => ({ manifest: {} as unknown }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: () => JSON.stringify(mocks.manifest),
}));

beforeEach(() => {
  mocks.manifest = { name: 'agent-device', version: '0.21.28', bin: { 'agent-device': 'bin/agent-device.mjs' } };
});

it('reads the version of the installed agent-device', () => {
  expect(() => assertDriverVersion('0.21.28')).not.toThrow();
  expect(() => assertDriverVersion('0.21.27')).toThrow('@e2e-dev/limrun uses agent-device 0.21.28, but @e2e-dev/mobile uses 0.21.27. Install matching versions.');
});

it('names an agent-device manifest without a version', () => {
  mocks.manifest = { name: 'agent-device', bin: { 'agent-device': 'bin/agent-device.mjs' } };
  expect(() => assertDriverVersion('0.21.28')).toThrow(/^Cannot find the installed agent-device CLI: .*package\.json declares no version or agent-device bin$/);
});

it('names an agent-device manifest without an agent-device bin', () => {
  mocks.manifest = { name: 'agent-device', version: '0.21.28', bin: { other: 'bin/other.mjs' } };
  expect(() => assertDriverVersion('0.21.28')).toThrow(/^Cannot find the installed agent-device CLI: .*package\.json declares no version or agent-device bin$/);
});
