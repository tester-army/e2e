/** The harness every `openHost` suite shares: the built runner, fake engines, and per-test host cleanup. */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import type { EngineHandle, EnginePrepareInfo, EngineFinishInfo } from '../../src/engine/index.ts';
import type { E2EConfig } from '../../src/index.ts';
import type { OpenHostOptions } from '../../src/runner.ts';
import { FAKE_APP, type FakeEngineHandle } from './fake-engine.ts';

const runnerModule = new URL('../../dist/runner.js', import.meta.url).href;
export const sdkModule = new URL('../../dist/index.js', import.meta.url).href;
export const { openHost } = (await import(runnerModule)) as typeof import('../../src/runner.ts');
export const { credentials, expect: sdkExpect, secrets } = (await import(sdkModule)) as typeof import('../../src/index.ts');
const PROJECTS = new URL('../tmp-projects/', import.meta.url);
/** Where a file config finds the engines a test made. */
export const ENGINES = '__e2eOpenHostTestEngines';

export interface Gadget {
  poke(what: string): Promise<string>;
  dropFile(): Promise<string>;
  hang(): Promise<never>;
  slow(options?: { timeout?: number }): Promise<string>;
  describe(): string;
}

export type GadgetFixtures = { gadget: Gadget };

/** A gate makes lifecycle races independent of how fast the engine starts. */
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Add run-level hooks without changing the fake engine's attempt instrumentation. */
export function provisioned(fake: FakeEngineHandle) {
  const prepares: EnginePrepareInfo[] = [];
  const finishes: EngineFinishInfo[] = [];
  const events: string[] = [];
  const engine: EngineHandle = {
    ...fake.engine,
    async prepare(info) {
      prepares.push(info);
      events.push('prepare');
      info.log('pool ready');
      return { env: { FROM_PREPARE: 'prepared', OVERRIDE: 'prepared' } };
    },
    async finish(info) {
      finishes.push(info);
      events.push('finish');
      info.log('pool released');
    },
  };
  return { engine, prepares, finishes, events };
}

/**
 * Registers the suite's hooks: a fresh project directory per test, every
 * opened host closed and every held fake lifecycle hook released afterwards,
 * so an assertion failure cannot leave a published session behind.
 */
export function hostHarness() {
  let dir = '';
  let hosts: Awaited<ReturnType<typeof openHost<GadgetFixtures>>>[] = [];
  let releases: (() => void)[] = [];

  /** A config value exercises cwd resolution without importing source runtime modules. */
  function config(engine: EngineHandle, extra: Partial<E2EConfig> = {}): E2EConfig {
    return { targets: [{ name: 'kiosk', platform: 'kiosk', engine, app: FAKE_APP }], ...extra };
  }

  async function host(engine: EngineHandle, options: Partial<OpenHostOptions> = {}) {
    const opened = await openHost<GadgetFixtures>({ cwd: dir, env: {}, config: config(engine), ...options });
    hosts.push(opened);
    return opened;
  }

  function heldGate() {
    const held = gate();
    releases.push(held.resolve);
    return held;
  }

  beforeEach(() => {
    mkdirSync(PROJECTS, { recursive: true });
    dir = mkdtempSync(path.join(PROJECTS.pathname, 'open-host-'));
    hosts = [];
    releases = [];
  });

  afterEach(async () => {
    for (const release of releases) release();
    for (const opened of hosts) await opened.close();
    delete (globalThis as Record<string, unknown>)[ENGINES];
    rmSync(dir, { recursive: true, force: true });
  });

  return { host, config, heldGate, dir: () => dir };
}
