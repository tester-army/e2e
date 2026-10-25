import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { diffCases, diffSince, formatDiff } from '../src/diff.ts';
import { parseCige, type CigeTestCase } from '../src/schema.ts';

const BASE: CigeTestCase = {
  id: 'checkout',
  Context: { system: 'Shop', environment: 'staging' },
  Intent: {
    statement: 'A shopper can check out with a discount',
    success: ['The confirmation shows an order number'],
    evidence: [{ id: 'order-record', hook: 'orderExists' }],
  },
  Guardrails: ['Use only the test card', { id: 'no-refund', rule: 'Never refund an order', deny: { actions: ['tool:refund'] } }],
  Execution: [{ id: 'e1', step: 'apply the code SAVE10' }, { id: 'e2', step: 'pay with the test card' }],
  Variants: [{ id: 'web', platforms: ['web'] }],
};

/** BASE with `change` applied to a deep copy. */
function edited(change: (file: Record<string, any>) => void): CigeTestCase {
  const copy = structuredClone(BASE) as Record<string, any>;
  change(copy);
  return copy as CigeTestCase;
}

function kinds(after: CigeTestCase): string[] {
  return diffCases(parseCige(BASE), parseCige(after)).map((entry) => `${entry.blocking ? '!' : ''}${entry.kind}`);
}

describe('diffCases', () => {
  it('lets a repair rewrite Execution, and holds any Context change for a human', () => {
    expect(kinds(edited((file) => void (file.Execution[1].step = 'pay with the saved test card')))).toEqual(['execution-changed']);
    expect(
      kinds(
        edited((file) => {
          file.Execution[1].step = 'pay with the saved test card';
          file.Context.environment = 'staging-2';
        }),
      ),
    ).toEqual(['execution-changed', '!context-changed']);
  });

  it('blocks a repair that weakens the case through Context (the review scenario)', () => {
    const strong: CigeTestCase = {
      id: 'order',
      Context: { environment: 'staging', open: '/cart', agent: 'strong', preconditions: [{ hook: 'seedOrder', description: 'An order exists' }] },
      Intent: { statement: 'A shopper sees their order', evidence: [{ id: 'record', hook: 'orderExists' }] },
      Execution: [{ id: 'e1', step: 'open the latest order' }, { id: 'e2', verify: 'the order total is shown' }],
    };
    const weakened: CigeTestCase = {
      ...strong,
      Context: { environment: 'local', open: '/receipt', agent: 'cheap' },
      Execution: [{ id: 'e1', verify: 'a receipt is shown' }],
    };
    const changes = diffCases(parseCige(strong), parseCige(weakened));
    expect(changes.map((entry) => `${entry.blocking ? '!' : ''}${entry.kind}`)).toEqual(['execution-changed', '!context-changed']);
    expect(changes[1]?.detail).toBe('environment, agent, open, preconditions; precondition removed: hook seedOrder');
  });

  it('lets a repair tighten: criteria, evidence, guardrails, deny patterns, a judgment, variants', () => {
    expect(
      kinds(
        edited((file) => {
          file.Intent.success.push('The total is 10% below the subtotal');
          file.Intent.evidence.push({ id: 'ledger', hook: 'ledgerHasOrder' });
          file.Guardrails.push('Never place a real order');
          file.Guardrails[1].deny.summary = ['refund'];
          file.Variants.push({ id: 'ios', platforms: ['ios'] });
        }),
      ),
    ).toEqual(['criteria-added', 'evidence-added', 'guardrail-added', 'deny-added', 'variant-added']);
  });

  it('blocks anything that weakens what a pass means', () => {
    expect(
      kinds(
        edited((file) => {
          file.Intent.statement = 'A shopper can reach checkout';
          file.Intent.success = [];
          file.Intent.evidence = [{ id: 'screen', assert: 'the page shows a confirmation' }];
          file.Intent.judge = false;
          file.Guardrails[1].deny = { summary: ['refund'] };
          file.Guardrails.shift();
          file.Variants = [{ id: 'mobile' }];
          file.id = 'reach-checkout';
        }),
      ),
    ).toEqual([
      '!id-changed',
      '!intent-changed',
      '!criteria-removed',
      '!evidence-removed',
      'evidence-added',
      '!judge-dropped',
      '!guardrail-removed',
      '!deny-removed',
      'deny-added',
      '!variant-removed',
      'variant-added',
    ]);
  });

  it('reads reordered keys as no change', () => {
    expect(kinds(edited((file) => void (file.Variants[0] = { platforms: ['web'], id: 'web' })))).toEqual([]);
  });

  it('blocks a change to an existing variant data: it changes what the case tests', () => {
    expect(kinds(edited((file) => void (file.Variants[0].platforms = ['ios'])))).toEqual(['!variant-changed']);
  });

  it('blocks an x- change under Intent or on a guardrail, and allows a top-level one', () => {
    expect(kinds(edited((file) => void (file.Intent['x-priority'] = 'p3')))).toEqual(['!intent-extension-changed']);
    expect(kinds(edited((file) => void (file.Guardrails[1]['x-deny-host'] = 'admin.example.test')))).toEqual(['!guardrail-extension-changed']);
    expect(kinds(edited((file) => void (file['x-owner'] = 'checkout-team')))).toEqual(['case-extension-changed']);
  });

  it('compares x- keys of same-text guardrails and same-hook evidence one to one, and names the keys', () => {
    const twins = (owner: string): CigeTestCase => ({
      ...BASE,
      Intent: {
        statement: 'A shopper can check out with a discount',
        evidence: [
          { id: 'first', hook: 'orderExists' },
          { id: 'second', hook: 'orderExists', 'x-owner': owner },
        ],
      },
      Guardrails: [
        { id: 'g1', rule: 'Use only the test card' },
        { id: 'g2', rule: 'Use only the test card', 'x-deny-host': owner },
      ],
    });
    expect(diffCases(parseCige(twins('a')), parseCige(twins('b'))).map((entry) => `${entry.kind} ${entry.detail}`)).toEqual([
      'intent-extension-changed second: x-owner',
      'guardrail-extension-changed g2: x-deny-host',
    ]);
  });

  it('blocks dropping one of two guardrails or evidence items with the same text', () => {
    const twins: CigeTestCase = {
      ...BASE,
      Intent: { statement: 'A shopper can check out with a discount', evidence: [{ id: 'first', hook: 'orderExists' }, { id: 'second', hook: 'orderExists' }] },
      Guardrails: [
        { id: 'g1', rule: 'Use only the test card' },
        { id: 'g2', rule: 'Use only the test card', deny: { actions: ['tool:refund'] } },
      ],
    };
    const dropped: CigeTestCase = { ...twins, Intent: { statement: 'A shopper can check out with a discount', evidence: [{ id: 'first', hook: 'orderExists' }] }, Guardrails: [{ id: 'g1', rule: 'Use only the test card' }] };
    expect(diffCases(parseCige(twins), parseCige(dropped)).map((entry) => `${entry.blocking ? '!' : ''}${entry.kind} ${entry.detail.split(':')[0]}`)).toEqual([
      '!evidence-removed second',
      '!guardrail-removed g2',
    ]);
  });

  it('reads an edited guardrail as one removed and one added, so it needs approval', () => {
    expect(kinds(edited((file) => void (file.Guardrails[0] = 'Use the test card')))).toEqual(['!guardrail-removed', 'guardrail-added']);
  });

  it('names an added case and blocks a removed one', () => {
    expect(diffCases(undefined, parseCige(BASE))).toMatchObject([{ kind: 'case-added', blocking: false }]);
    expect(diffCases(parseCige(BASE), undefined)).toMatchObject([{ kind: 'case-removed', blocking: true }]);
  });
});

describe('diffSince', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repo(files: Record<string, unknown>): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'cige-diff-'));
    dirs.push(dir);
    write(dir, files);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=cige@example.test', '-c', 'user.name=cige', ...args], { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    return dir;
  }

  function write(dir: string, files: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    }
  }

  it('reads every changed, removed, and untracked case since the base', () => {
    const dir = repo({ 'tests/cige/checkout.cige.json': BASE, 'tests/cige/old.cige.json': { ...BASE, id: 'old', Intent: 'An old flow works' } });
    write(dir, {
      'tests/cige/checkout.cige.json': edited((file) => void (file.Execution[0].step = 'enter SAVE10 in the code field')),
      'tests/cige/new.cige.json': { ...BASE, id: 'new', Intent: 'A new flow works' },
    });
    rmSync(path.join(dir, 'tests/cige/old.cige.json'));
    const report = diffSince('HEAD', path.join(dir, 'tests'));
    expect(report.files.map((entry) => [entry.file, entry.changes.map((item) => item.kind)])).toEqual([
      ['tests/cige/checkout.cige.json', ['execution-changed']],
      ['tests/cige/new.cige.json', ['case-added']],
      ['tests/cige/old.cige.json', ['case-removed']],
    ]);
    expect(report).toMatchObject({ base: 'HEAD', blocking: 1, intentUnchanged: false });
    expect(formatDiff(report)).toContain('needs approval  case-removed: old');
  });

  it('diffs from where the branch left the base, so a change that landed there since is not blamed on it', () => {
    const dir = repo({ 'checkout.cige.json': BASE });
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=cige@example.test', '-c', 'user.name=cige', ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
    const main = git('rev-parse', '--abbrev-ref', 'HEAD');
    git('checkout', '-q', '-b', 'repair');
    git('checkout', '-q', main);
    write(dir, { 'checkout.cige.json': edited((file) => void file.Intent.success.push('The total is 10% below the subtotal')) });
    git('commit', '-q', '-am', 'tighten on main');
    git('checkout', '-q', 'repair');
    write(dir, { 'checkout.cige.json': edited((file) => void (file.Execution[1].step = 'pay')) });
    expect(diffSince(main, dir).files[0]?.changes.map((item) => item.kind)).toEqual(['execution-changed']);
  });

  it('blocks a change to the CIGE config or a module it imports, and ignores other code', () => {
    const dir = repo({
      'cige.config.ts': "import { shop } from './plugins/shop.ts';\nexport default { plugins: [shop], hooks: { orderExists: async () => (await fetch('/orders')).ok } };\n",
      'plugins/shop.ts': "export const shop = { name: 'shop' };\n",
      'app/server.ts': 'export const port = 3000;\n',
      'checkout.cige.json': BASE,
    });
    const configFiles = [path.join(dir, 'cige.config.ts')];
    expect(diffSince('HEAD', dir, { configFiles }).files).toEqual([]);
    // The weakening the review names: an evidence hook rewritten to pass.
    write(dir, { 'cige.config.ts': "import { shop } from './plugins/shop.ts';\nexport default { plugins: [shop], hooks: { orderExists: async () => true } };\n" });
    write(dir, { 'plugins/shop.ts': "export const shop = { name: 'shop', classify: () => ({ failureType: null }) };\n", 'app/server.ts': 'export const port = 4000;\n' });
    const report = diffSince('HEAD', dir, { configFiles });
    expect(report.files.map((entry) => [entry.file, entry.changes.map((item) => `${item.blocking ? '!' : ''}${item.kind}`)])).toEqual([
      ['cige.config.ts', ['!config-changed']],
      ['plugins/shop.ts', ['!config-changed']],
    ]);
    expect(report.blocking).toBe(2);
  });

  it('blocks deleting a module the config imports, deleting the config, and renaming it', () => {
    const config = "import { shop } from './plugins/shop.ts';\nexport default { plugins: [shop] };\n";
    const files = { 'cige.config.ts': config, 'plugins/shop.ts': "export const shop = { name: 'shop' };\n", 'checkout.cige.json': BASE };
    const configFiles = (dir: string) => ['cige.config.ts', 'cige.config.mjs'].map((name) => path.join(dir, name));
    const changed = (dir: string) => diffSince('HEAD', dir, { configFiles: configFiles(dir) }).files.map((entry) => `${entry.file} ${entry.changes.map((item) => item.kind).join(',')}`);

    // The config still imports it, so only the base's graph knows the module.
    const deletedModule = repo(files);
    rmSync(path.join(deletedModule, 'plugins/shop.ts'));
    expect(changed(deletedModule)).toEqual(['plugins/shop.ts config-changed']);

    const deletedConfig = repo(files);
    rmSync(path.join(deletedConfig, 'cige.config.ts'));
    expect(changed(deletedConfig)).toEqual(['cige.config.ts config-changed']);

    const renamed = repo(files);
    rmSync(path.join(renamed, 'cige.config.ts'));
    write(renamed, { 'cige.config.mjs': config });
    expect(changed(renamed)).toEqual(['cige.config.mjs config-changed', 'cige.config.ts config-changed']);
  });

  it('follows a symlinked module to its target, as Node imports it, on either side', () => {
    const linked = () => {
      const dir = repo({ 'cige.config.ts': "import { shop } from './plugins/shop.ts';\nexport default { plugins: [shop] };\n", 'lib/shop.ts': "export const shop = { name: 'shop' };\n", 'checkout.cige.json': BASE });
      mkdirSync(path.join(dir, 'plugins'));
      symlinkSync('../lib/shop.ts', path.join(dir, 'plugins/shop.ts'));
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['-c', 'user.email=cige@example.test', '-c', 'user.name=cige', 'commit', '-q', '-m', 'link'], { cwd: dir, stdio: 'pipe' });
      return dir;
    };
    const changed = (dir: string) => diffSince('HEAD', dir, { configFiles: [path.join(dir, 'cige.config.ts')] }).files.map((entry) => `${entry.file} ${entry.changes.map((item) => item.kind).join(',')}`);

    const retouched = linked();
    expect(changed(retouched)).toEqual([]);
    write(retouched, { 'lib/shop.ts': "export const shop = { name: 'shop', classify: () => ({ failureType: null }) };\n" });
    expect(changed(retouched)).toEqual(['lib/shop.ts config-changed']);

    // The link dangles now, so only the base's side reaches its target.
    const deleted = linked();
    rmSync(path.join(deleted, 'lib/shop.ts'));
    expect(changed(deleted)).toEqual(['lib/shop.ts config-changed']);
  });

  it('says the Intent held when only the path changed, and blocks a file that no longer parses', () => {
    const dir = repo({ 'checkout.cige.json': BASE });
    write(dir, { 'checkout.cige.json': edited((file) => void (file.Execution[1].step = 'pay')) });
    expect(diffSince('HEAD', dir)).toMatchObject({ blocking: 0, intentUnchanged: true });
    write(dir, { 'checkout.cige.json': '{ "Context": ' });
    expect(diffSince('HEAD', dir).files[0]?.changes[0]).toMatchObject({ kind: 'invalid', blocking: true });
  });
});
