/**
 * Captures the raw agent-device snapshot of the home list and of every
 * scenario's first screen, per platform, into the mobile engine's golden
 * fixtures (`packages/mobile/tests/fixtures/snapshots/`). The engine's unit
 * tests project them offline, so a change to how the tree reads a real iOS or
 * Android hierarchy shows up in `pnpm test` without a device. Hand-run only:
 *
 *   pnpm --filter @e2e-dev/mobile-benchmark run capture:snapshots --target ios-simulator
 *
 * then `E2E_GOLDEN_UPDATE=1 pnpm --filter @e2e-dev/mobile exec vitest run
 * tests/unit/captured-snapshots.test.ts` and review both diffs.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, openScenario, test } from '../tests/fixtures.ts';

type Platform = 'ios' | 'android';

const HERE = import.meta.dirname;
const OUT = path.join(HERE, '../../../packages/mobile/tests/fixtures/snapshots');

/** The agent-device CLI the engine's own install carries, so the capture and the engine speak the same daemon version. */
const CLI = path.join(realpathSync(createRequire(import.meta.url).resolve('@e2e-dev/mobile')), '../../node_modules/.bin/agent-device');

/** Scenario names and the platform an entry is limited to, read off the app's registry. */
function scenarios(): { name: string; platform?: Platform }[] {
  const source = readFileSync(path.join(HERE, '../src/examples.ts'), 'utf8');
  return [...source.matchAll(/\{\s*component: \w+,\s*name: "([^"]+)",[\s\S]*?\n {2}\}/g)].map((match) => {
    const platform = /platform: "(ios|android)"/.exec(match[0])?.[1] as Platform | undefined;
    return { name: match[1]!, ...(platform === undefined ? {} : { platform }) };
  });
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

interface Snapshot {
  readonly nodes: readonly {
    readonly type?: string;
    readonly label?: string;
    readonly value?: string;
    readonly identifier?: string;
  }[];
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly truncated?: boolean;
  readonly appName?: string;
  readonly appBundleId?: string;
}

function snapshot(platform: Platform): Snapshot {
  const out = execFileSync(CLI, ['snapshot', '--json', '--force-full', '--session', `e2e-mobile-benchmark-${platform}-0`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(out) as { data: Snapshot }).data;
}

/**
 * A snapshot of a screen that has come to rest: two in a row with the same
 * types, labels, and values. A screen still pushing in reads half of each.
 */
async function settledSnapshot(platform: Platform): Promise<Snapshot> {
  const shape = (snap: Snapshot) => JSON.stringify(snap.nodes.map((node) => [node.type, node.label, node.value]));
  let last = snapshot(platform);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const next = snapshot(platform);
    if (shape(next) === shape(last)) return next;
    last = next;
  }
  return last;
}

/** Keeps what the engine reads and drops the capture's timings and diagnostics. */
function write(platform: Platform, name: string, snap: Snapshot): void {
  mkdirSync(path.join(OUT, platform), { recursive: true });
  const kept = {
    nodes: snap.nodes,
    ...(snap.viewport === undefined ? {} : { viewport: snap.viewport }),
    ...(snap.truncated === undefined ? {} : { truncated: snap.truncated }),
    ...(snap.appName === undefined ? {} : { appName: snap.appName }),
    ...(snap.appBundleId === undefined ? {} : { appBundleId: snap.appBundleId }),
  };
  writeFileSync(path.join(OUT, platform, `${name}.json`), `${JSON.stringify(kept, null, 2)}\n`);
}

for (const platform of ['ios', 'android'] as const) {
  test.describe(platform, () => {
    test('home list', { platforms: [platform] }, async ({ app }) => {
      await app.open();
      write(platform, 'home', await settledSnapshot(platform));
    });
    for (const scenario of scenarios()) {
      if (scenario.platform !== undefined && scenario.platform !== platform) continue;
      test(scenario.name, { platforms: [platform] }, async ({ app, device, screen }) => {
        await openScenario({ app, device, screen }, scenario.name);
        write(platform, slug(scenario.name), await settledSnapshot(platform));
      });
    }
    // Screen identity: the same untitled modal presented twice over a titled
    // screen, and a tab other than the first, each named by its root view's
    // `e2e-screen:` testID.
    test('modal flow sheet, twice', { platforms: [platform] }, async ({ app, device, screen }) => {
      await openScenario({ app, device, screen }, 'Modal Flow');
      for (const take of ['a', 'b']) {
        await screen.getByTestId('open-modal-button').tap();
        await expect(screen.getByTestId('continue-button')).toBeVisible();
        write(platform, `modal-flow-sheet-${take}`, await settledSnapshot(platform));
        await screen.getByTestId('close-modal-button').tap();
        await expect(screen.getByTestId('open-modal-button')).toBeVisible();
      }
    });
    test('layered markers', { platforms: [platform] }, async ({ app, device, screen }) => {
      await app.open();
      await expect(screen.getByTestId('e2e-screen:Benchmark Examples')).toBeVisible();
      await device.openLink('e2e-benchmark:///layers');
      // agent-device does not dismiss iOS's first-open scheme confirmation.
      if (platform === 'ios' && (await screen.getByRole('button', 'Open').isVisible())) {
        await screen.getByRole('button', 'Open').tap();
      }
      await expect(screen.getByTestId('e2e-screen:Cover')).toBeVisible();
      await expect.poll(
        () => snapshot(platform).nodes.filter(node => node.identifier?.includes('e2e-screen:')).length,
        { timeout: 10_000 }
      ).toBe(2);
      write(platform, 'layered-markers', await settledSnapshot(platform));
    });
    test('bottom tabs, actions tab', { platforms: [platform] }, async ({ app, device, screen }) => {
      await openScenario({ app, device, screen }, 'Bottom Tabs');
      await screen.getByTestId('tab-actions').tap();
      await expect(screen.getByTestId('complete-action-button')).toBeVisible();
      write(platform, 'bottom-tabs-actions', await settledSnapshot(platform));
    });
  });
}
