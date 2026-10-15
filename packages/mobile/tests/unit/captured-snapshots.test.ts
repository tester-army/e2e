/**
 * Snapshots captured from a real iOS simulator and Android emulator
 * (`apps/mobile-benchmark/tests-capture/snapshots.e2e.ts`), projected the way
 * `observe` projects them, against the committed tree each one reads as. A
 * change to how the engine reads a real hierarchy shows up here as a diff of
 * `<scenario>.tree.txt`, without a device. `E2E_GOLDEN_UPDATE=1` rewrites the
 * trees from the snapshots; review the diff like any other change.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SemanticNode, ViewportSize } from 'e2e/engine';
import { projectSnapshot, screenRoot, screenTitle, type RawNode } from '../../src/nodes.ts';

const ROOT = path.join(import.meta.dirname, '../fixtures/snapshots');
const UPDATE = process.env['E2E_GOLDEN_UPDATE'] === '1';
const STATES = ['checked', 'disabled', 'selected', 'expanded', 'pressed', 'focused', 'hidden', 'secure'] as const;

/** One line per node: role, name, text, value, states, test id, and attributes; geometry is left out as capture noise. */
function render(node: SemanticNode, depth = 0, out: string[] = []): string[] {
  const parts = [node.role ?? '(no role)'];
  if (node.name !== undefined && node.name !== '') parts.push(JSON.stringify(node.name));
  if (node.text !== undefined && node.text !== '' && node.text !== node.name) parts.push(`text=${JSON.stringify(node.text)}`);
  if (node.value !== undefined) parts.push(`value=${JSON.stringify(node.value)}`);
  if (node.level !== undefined) parts.push(`level=${node.level}`);
  const states = STATES.filter((state) => node.states?.[state] === true);
  if (states.length > 0) parts.push(`[${states.join(', ')}]`);
  if (node.testId !== undefined) parts.push(`#${node.testId}`);
  for (const [key, value] of Object.entries(node.attributes ?? {}).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    parts.push(`${key}=${JSON.stringify(value)}`);
  }
  out.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
  for (const child of node.children ?? []) render(child, depth + 1, out);
  return out;
}

/**
 * The title each iOS capture's location carries. A pushed screen's bar is
 * labelled with the back button (`Benchmark Examples`) and identified by its
 * own title; the tab bar and the PaymentSheet show no navigation bar. The
 * `swiftui-*` captures (`tests-capture/swiftui-bar`) give the bar no label,
 * and identify an untitled screen's bar by a Swift class name.
 */
const IOS_TITLES: Record<string, string | undefined> = {
  'apple-pay': 'Apple Pay',
  'apple-pay-billing-address': 'Apple Pay Billing Address',
  'async-states': 'Async States',
  'bottom-tabs': undefined,
  'broken-accessibility': 'Broken Accessibility',
  'choice-controls': 'Choice Controls',
  'control-inventory': 'Control Inventory',
  'debounced-search': 'Debounced Search',
  'error-recovery': 'Error Recovery',
  'flattened-login': 'Flattened Login',
  'flattened-registration-form': 'Flattened Registration Form',
  gestures: 'Gestures',
  home: 'Benchmark Examples',
  'huge-virtualized-list': 'Huge Virtualized List',
  'infinite-scroll-list': 'Infinite Scroll List',
  'login-form': 'Login Form',
  'modal-flow': 'Modal Flow',
  'permission-prompt': 'Permission Prompt',
  'photo-picker': 'Photo Picker',
  'product-catalog': 'Product Catalog',
  'sequential-onboarding': 'Sequential Onboarding',
  'sticky-chrome-target': 'Sticky Chrome Target',
  'stripe-paymentsheet': undefined,
  'swiftui-compose': 'Compose',
  'swiftui-inbox': 'Inbox',
  'swiftui-message': 'Message',
  'swiftui-untitled': undefined,
  'text-input-variations': 'Text Input Variations',
  'vision-only': 'Vision Only',
  'webview-accessibility': 'WebView Accessibility',
};

/** A captured snapshot projected the way `observe` projects it. */
function project(file: string) {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { nodes: RawNode[]; viewport?: ViewportSize; truncated?: boolean };
  let counter = 0;
  return { raw, projected: projectSnapshot(raw.nodes, { mintId: () => `n${(counter += 1)}`, viewport: raw.viewport }) };
}

/** The tree `observe` would report for a captured snapshot. */
function treeOf(file: string): string {
  const { raw, projected } = project(file);
  const root = screenRoot(projected.roots, projected.viewport ?? { width: 0, height: 0 });
  return `${raw.truncated === true ? '# truncated\n' : ''}${render(root).join('\n')}\n`;
}

const platforms = existsSync(ROOT) ? readdirSync(ROOT).toSorted() : [];

describe('captured device snapshots', () => {
  it('has captures for both platforms', () => {
    expect(platforms).toEqual(['android', 'ios']);
  });

  for (const platform of platforms) {
    const dir = path.join(ROOT, platform);
    const captures = readdirSync(dir).filter((file) => file.endsWith('.json')).toSorted();
    describe(platform, () => {
      it.each(captures)('%s reads as its committed tree', (capture) => {
        const tree = treeOf(path.join(dir, capture));
        const golden = path.join(dir, capture.replace(/\.json$/, '.tree.txt'));
        if (UPDATE) writeFileSync(golden, tree);
        expect(existsSync(golden), `${golden} is missing; run with E2E_GOLDEN_UPDATE=1`).toBe(true);
        expect(tree).toBe(readFileSync(golden, 'utf8'));
      });

      if (platform === 'ios') {
        it.each(captures)('%s takes its title from the navigation bar', (capture) => {
          const scenario = capture.replace(/\.json$/, '');
          expect(Object.keys(IOS_TITLES), `add ${scenario} to IOS_TITLES`).toContain(scenario);
          expect(screenTitle(project(path.join(dir, capture)).projected)).toBe(IOS_TITLES[scenario]);
        });
      }

      it('keeps no tree without its capture', () => {
        const trees = readdirSync(dir).filter((file) => file.endsWith('.tree.txt'));
        expect(trees.filter((tree) => !captures.includes(tree.replace(/\.tree\.txt$/, '.json')))).toEqual([]);
      });
    });
  }
});
