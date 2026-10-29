import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

    // The config still imports it, so it no longer loads, and only the base's graph knows the module.
    const deletedModule = repo(files);
    rmSync(path.join(deletedModule, 'plugins/shop.ts'));
    expect(changed(deletedModule)).toEqual(['cige.config.ts config-unverified', 'plugins/shop.ts config-changed']);

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

    // The link dangles now, so the config no longer loads, and only the base's side reaches its target.
    const deleted = linked();
    rmSync(path.join(deleted, 'lib/shop.ts'));
    expect(changed(deleted)).toEqual(['cige.config.ts config-unverified', 'lib/shop.ts config-changed']);
  });

  it('follows what Node loads: a # alias, a workspace package, and a hook\'s lazy import', () => {
    const dir = repo({
      '.gitignore': 'node_modules\n',
      'package.json': JSON.stringify({ type: 'module', imports: { '#hooks/*': './hooks/*.ts' } }),
      // The review's case: a hook reached only through a package.json imports alias.
      'cige.config.ts': "import { orderPersisted } from '#hooks/order';\nimport { shop } from '@acme/hooks';\nexport default { plugins: [shop], hooks: { orderPersisted, later: async () => (await import('#hooks/lazy')).ok() } };\n",
      'hooks/order.ts': "export const orderPersisted = async () => (await fetch('/orders/1')).ok;\n",
      'hooks/lazy.ts': 'export const ok = () => false;\n',
      'packages/hooks/package.json': JSON.stringify({ name: '@acme/hooks', type: 'module', exports: './index.js' }),
      'packages/hooks/index.js': "export const shop = { name: 'shop' };\n",
      'app/server.ts': 'export const port = 3000;\n',
      'checkout.cige.json': BASE,
    });
    // How a workspace links its packages: a symlink under node_modules to the tracked source.
    mkdirSync(path.join(dir, 'node_modules/@acme'), { recursive: true });
    symlinkSync('../../packages/hooks', path.join(dir, 'node_modules/@acme/hooks'));
    const changed = () => diffSince('HEAD', dir, { configFiles: [path.join(dir, 'cige.config.ts')] }).files.map((entry) => `${entry.file} ${entry.changes.map((item) => `${item.blocking ? '!' : ''}${item.kind}`).join(',')}`);
    expect(changed()).toEqual([]);
    write(dir, {
      'hooks/order.ts': 'export const orderPersisted = async () => true;\n',
      'hooks/lazy.ts': 'export const ok = () => true;\n',
      'packages/hooks/index.js': "export const shop = { name: 'shop', classify: () => ({ failureType: null }) };\n",
      'app/server.ts': 'export const port = 4000;\n',
    });
    expect(changed()).toEqual(['hooks/lazy.ts !config-changed', 'hooks/order.ts !config-changed', 'packages/hooks/index.js !config-changed']);
  });

  it('blocks remapping an alias in package.json, and ignores the rest of it', () => {
    const manifest = (imports: Record<string, string>, scripts: Record<string, string> = {}) => JSON.stringify({ type: 'module', scripts, imports });
    const dir = repo({
      'package.json': manifest({ '#hooks/*': './hooks/*.ts' }),
      'cige.config.ts': "import { orderPersisted } from '#hooks/order';\nexport default { hooks: { orderPersisted } };\n",
      'hooks/order.ts': "export const orderPersisted = async () => (await fetch('/orders/1')).ok;\n",
      // Already there and never edited: the remap alone points the hook at it.
      'fake/order.ts': 'export const orderPersisted = async () => true;\n',
      'checkout.cige.json': BASE,
    });
    const changed = () => diffSince('HEAD', dir, { configFiles: [path.join(dir, 'cige.config.ts')] }).files.map((entry) => `${entry.file} ${entry.changes.map((item) => `${item.blocking ? '!' : ''}${item.kind}: ${item.detail}`).join(',')}`);
    write(dir, { 'package.json': manifest({ '#hooks/*': './hooks/*.ts' }, { test: 'e2e run' }) });
    expect(changed()).toEqual([]);
    write(dir, { 'package.json': manifest({ '#hooks/*': './fake/*.ts' }) });
    expect(changed()).toEqual(["package.json !config-changed: package.json: imports, which decide where the config's imports resolve"]);
  });

  it('blocks a config it cannot load or follow, naming why', () => {
    const verdict = (config: string) => {
      const dir = repo({ 'cige.config.mjs': config, 'checkout.cige.json': BASE });
      return diffSince('HEAD', dir, { configFiles: [path.join(dir, 'cige.config.mjs')] }).files.flatMap((entry) => entry.changes.map((item) => `${item.blocking ? '!' : ''}${item.kind}: ${item.detail}`));
    };
    expect(verdict("throw new Error('no staging credentials');\n")).toEqual([
      '!config-unverified: cige.config.mjs: loading it failed: no staging credentials; a human must review every change outside the case files',
    ]);
    expect(verdict("const name = './hooks/' + 'order.mjs';\nexport default { hooks: { order: async () => (await import(name)).ok } };\n")).toEqual([
      '!config-unverified: cige.config.mjs: cige.config.mjs imports a module by a computed name; a human must review every change outside the case files',
    ]);
    expect(verdict("const name = 'order';\nexport default { hooks: { order: async () => (await import(`./hooks/${name}.mjs`)).ok } };\n")).toEqual([
      '!config-unverified: cige.config.mjs: cige.config.mjs imports a module by a computed name; a human must review every change outside the case files',
    ]);
    const computed = '!config-unverified: cige.config.mjs: cige.config.mjs imports a module by a computed name; a human must review every change outside the case files';
    expect(verdict("const name = './x.mjs';\nexport default { hooks: { h: async () => `${(await import(name)).x}` } };\n")).toEqual([computed]);
    // The review's cases: a `//` inside a string, and nested braces inside an interpolation.
    expect(verdict("const sep = '//'; const name = './x.mjs'; export default { hooks: { h: async () => (await import(name)).x } };\n")).toEqual([computed]);
    expect(verdict("const name = './x.mjs';\nexport default { hooks: { h: async () => `${ { a: 1 }.a + (await import(name)).x }` } };\n")).toEqual([computed]);
    const untraceable = (reason: string) => [`!config-unverified: cige.config.mjs: cige.config.mjs ${reason}; a human must review every change outside the case files`];
    const loader = (specifier: string) => untraceable(`imports ${specifier}, which loads code by a name the walk can't follow`);
    expect(verdict("import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport default { hooks: { h: async () => req('./check.cjs').ok } };\n")).toEqual(
      loader('node:module'),
    );
    expect(verdict("import { createRequire as cr } from 'node:module';\nexport default { hooks: { h: async () => cr(import.meta.url)('./check.cjs').ok } };\n")).toEqual(loader('node:module'));
    // The review's cases: a loader reached without its name. Each builtin that loads code blocks as a whole, statically, lazily, required, or re-exported.
    expect(verdict("import Module from 'node:module';\nexport default { hooks: { h: async () => Module._load('./check.cjs').ok } };\n")).toEqual(loader('node:module'));
    expect(verdict("import * as m from 'module';\nexport default { hooks: { h: async () => m['create' + 'Require'](import.meta.url)('./check.cjs').ok } };\n")).toEqual(loader('module'));
    expect(verdict("import vm from 'node:vm';\nexport default { hooks: { h: async () => vm.runInThisContext('1') } };\n")).toEqual(loader('node:vm'));
    expect(verdict("export default { hooks: { h: async () => new (await import('worker_threads')).Worker('1', { eval: true }) } };\n")).toEqual(loader('worker_threads'));
    expect(verdict("export default { hooks: { h: async () => require('node:inspector/promises') } };\n")).toEqual(loader('node:inspector/promises'));
    expect(verdict("export { createRequire } from 'node:module';\nexport default {};\n")).toEqual(loader('node:module'));
    const builtin = untraceable("reads process.getBuiltinModule, which can reach a loader the walk can't follow");
    expect(verdict("export default { hooks: { h: async () => process.getBuiltinModule('module').createRequire(import.meta.url)('./check.cjs').ok } };\n")).toEqual(builtin);
    expect(verdict("const { getBuiltinModule } = process;\nexport default { hooks: { h: async () => getBuiltinModule('vm') } };\n")).toEqual(builtin);
    expect(verdict("export default { hooks: { h: async () => process['getBuiltinModule']('vm') } };\n")).toEqual(builtin);
    expect(verdict("export default { hooks: { h: async () => eval('import(\"./x.mjs\")') } };\n")).toEqual(untraceable('runs code from a string (eval or Function)'));
    expect(verdict("export default { hooks: { h: async () => module.require('./check.cjs').ok } };\n")).toEqual(untraceable("uses require other than as require('<module>')"));
    // cubic's cases: a loader reached through a computed member, a destructure, an indirect call, or an alias.
    expect(verdict("export default { hooks: { h: async () => module['require']('./check.cjs').ok } };\n")).toEqual(untraceable("uses require other than as require('<module>')"));
    expect(verdict("export default { hooks: { h: async () => { const { require: r } = module; return r('./check.cjs').ok; } } };\n")).toEqual(
      untraceable("uses require other than as require('<module>')"),
    );
    expect(verdict("export default { hooks: { h: async () => globalThis.eval('1') } };\n")).toEqual(untraceable('runs code from a string (eval or Function)'));
    expect(verdict("export default { hooks: { h: async () => (0, eval)('1') } };\n")).toEqual(untraceable('runs code from a string (eval or Function)'));
    expect(verdict("const make = Function;\nexport default { hooks: { h: async () => make('return 1')() } };\n")).toEqual(untraceable('runs code from a string (eval or Function)'));
    expect(verdict("export default { hooks: { h: async () => (await import('node:module'))['createRequire'] } };\n")).toEqual(loader('node:module'));
    // The review's cases: a template-literal key, CommonJS's Module or Function through `.constructor`, a data: URL, and node:test's in-process run.
    const evaluates = untraceable('runs code from a string (eval or Function)');
    expect(verdict("export default { hooks: { h: async () => process[`getBuiltinModule`]('module') } };\n")).toEqual(builtin);
    expect(verdict("export default { hooks: { h: async () => globalThis[`eval`]('1') } };\n")).toEqual(evaluates);
    expect(verdict("export default { hooks: { h: async () => { const { [`eval`]: run } = globalThis; return run('1'); } } };\n")).toEqual(evaluates);
    const constructor = untraceable("reads .constructor, which reaches Function or Node's module loader");
    expect(verdict("export default { hooks: { h: async () => module.constructor._load('./check.cjs').ok } };\n")).toEqual(constructor);
    expect(verdict("export default { hooks: { h: async () => (() => {}).constructor('return 1')() } };\n")).toEqual(constructor);
    expect(verdict("export default { hooks: { h: async () => process.mainModule.filename } };\n")).toEqual(untraceable("reads process.mainModule, which reaches Node's module loader"));
    expect(verdict("export default { hooks: { h: async () => import('data:text/javascript,export default 1') } };\n")).toEqual(untraceable("imports a data: URL, code the walk can't follow"));
    // cubic's case: a URL scheme is case-insensitive.
    expect(verdict("export default { hooks: { h: async () => import('DATA:text/javascript,export default 1') } };\n")).toEqual(untraceable("imports a data: URL, code the walk can't follow"));
    expect(verdict("import { run } from 'node:test';\nexport default { hooks: { h: async () => run({ files: ['./check.cjs'], isolation: 'none' }) } };\n")).toEqual(loader('node:test'));
    // The review's cases: vm's binding, a native addon, and a REPL's eval.
    expect(verdict("export default { hooks: { h: async () => process.binding('contextify') } };\n")).toEqual(untraceable("reads process.binding, which reaches Node's internal loaders"));
    expect(verdict("export default { hooks: { h: async () => process.dlopen(module, './addon.node') } };\n")).toEqual(untraceable('reads process.dlopen, which loads a native addon'));
    expect(verdict("export default { hooks: { h: async () => (await import('node:repl')).start() } };\n")).toEqual(loader('node:repl'));
    expect(verdict("export default { hooks: { h: async () => (await import('repl')).start() } };\n")).toEqual(loader('repl'));
    // A comment, a string, a key, a class constructor, or another builtin is not a loader.
    expect(
      verdict(
        "import { readFileSync } from 'node:fs';\n// we import (lazily) nothing here\nclass Hook { constructor() { this.ok = true; } }\nexport default { note: \"import (not really)\", require: true, eval: 1, getBuiltinModule: 1, constructor: 1, mainModule: 1, binding: 1, dlopen: 1, [`eval`]: 1, why: 'getBuiltinModule', also: 'node:vm', Hook, readFileSync };\n",
      ),
    ).toEqual([]);
  });

  it('follows a lazy import that comment-looking strings surround', () => {
    const dir = repo({
      'package.json': JSON.stringify({ type: 'module', imports: { '#hooks/*': './hooks/*.ts' } }),
      // The review's case: `/*` in one string and `*/` in a later one are not a comment. Typed, so the parser reads it as Node strips it.
      'cige.config.ts':
        "const pattern: string = 'orders/*';\ntype Hook = () => Promise<boolean>;\nconst check: Hook = async () => (await import('#hooks/check')).ok();\nexport default { hooks: { check }, note: '*/' as string };\n",
      'hooks/check.ts': 'export const ok = () => false;\n',
      'checkout.cige.json': BASE,
    });
    write(dir, { 'hooks/check.ts': 'export const ok = () => true;\n' });
    expect(diffSince('HEAD', dir, { configFiles: [path.join(dir, 'cige.config.ts')] }).files.map((entry) => `${entry.file} ${entry.changes.map((item) => item.kind).join(',')}`)).toEqual([
      'hooks/check.ts config-changed',
    ]);
  });

  it('resolves a lazy require as CommonJS does, and blocks a lazy in-repo import that no longer resolves', () => {
    const configFiles = (dir: string) => [path.join(dir, 'cige.config.mjs')];
    const changed = (dir: string) => diffSince('HEAD', dir, { configFiles: configFiles(dir) }).files.map((entry) => `${entry.file} ${entry.changes.map((item) => `${item.blocking ? '!' : ''}${item.kind}: ${item.detail}`).join(',')}`);
    // cubic's case: `require('./hook')` finds hook.js by CommonJS's extension search, which ESM resolution doesn't do. Behind an alias, so only the working tree's walk reaches it.
    const cjs = repo({
      'package.json': JSON.stringify({ imports: { '#helpers': './helpers.cjs' } }),
      'cige.config.mjs': "import helpers from '#helpers';\nexport default { hooks: { check: async () => helpers.check() } };\n",
      'helpers.cjs': "exports.check = () => require('./hook').ok();\n",
      'hook.js': 'exports.ok = () => false;\n',
      'checkout.cige.json': BASE,
    });
    write(cjs, { 'hook.js': 'exports.ok = () => true;\n' });
    expect(changed(cjs)).toEqual(['hook.js !config-changed: hook.js: the hooks, plugins, and environments a pass depends on']);
    // cubic's case: the target of a lazy `#` import deleted, with package.json untouched.
    const alias = repo({
      'package.json': JSON.stringify({ type: 'module', imports: { '#hooks/*': './hooks/*.mjs' } }),
      'cige.config.mjs': "export default { hooks: { check: async () => (await import('#hooks/check')).ok() } };\n",
      'hooks/check.mjs': 'export const ok = () => false;\n',
      'checkout.cige.json': BASE,
    });
    rmSync(path.join(alias, 'hooks/check.mjs'));
    expect(changed(alias)).toEqual([
      "cige.config.mjs !config-unverified: cige.config.mjs: cige.config.mjs imports #hooks/check, which doesn't resolve; a human must review every change outside the case files",
    ]);
    // cubic's case: a bare `.` is relative too, here a directory's index behind a caught require.
    const index = repo({
      'cige.config.mjs': "import helper from './lib/helper.cjs';\nexport default { hooks: { check: async () => helper.check() } };\n",
      'lib/helper.cjs': "exports.check = () => { try { return require('.').ok(); } catch { return true; } };\n",
      'lib/index.js': 'exports.ok = () => false;\n',
      'checkout.cige.json': BASE,
    });
    rmSync(path.join(index, 'lib/index.js'));
    expect(changed(index)).toEqual([
      "cige.config.mjs !config-unverified: cige.config.mjs: lib/helper.cjs imports ., which doesn't resolve; a human must review every change outside the case files",
      'lib/index.js !config-changed: lib/index.js: the hooks, plugins, and environments a pass depends on',
    ]);
  });

  it('covers a workspace package built to an ignored dist by its sources, and blocks other untracked loads', () => {
    const dir = repo({
      '.gitignore': 'node_modules\ndist\ngenerated\n',
      'cige.config.ts': "import { shop } from '@acme/hooks';\nimport pad from 'left-pad';\nexport default { plugins: [shop], pad };\n",
      'packages/hooks/package.json': JSON.stringify({ name: '@acme/hooks', type: 'module', exports: './dist/index.js' }),
      'packages/hooks/src/index.ts': "export const shop = { name: 'shop' };\n",
      // Built output isn't parsed, so what a bundler emits doesn't block: the package's sources stand for it.
      'packages/hooks/dist/index.js': "export const shop = { name: 'shop' };\nexport const chunk = (name) => import(`./chunks/${name}.js`);\n",
      // An installed package: reviewed as a dependency, not as the case.
      'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad', type: 'module', exports: './index.js' }),
      'node_modules/left-pad/index.js': 'export default (text) => text;\n',
      'checkout.cige.json': BASE,
    });
    mkdirSync(path.join(dir, 'node_modules/@acme'));
    symlinkSync('../../packages/hooks', path.join(dir, 'node_modules/@acme/hooks'), 'dir');
    const changed = (configFile = 'cige.config.ts') =>
      diffSince('HEAD', dir, { configFiles: [path.join(dir, configFile)] }).files.map((entry) => `${entry.file} ${entry.changes.map((item) => `${item.blocking ? '!' : ''}${item.kind}: ${item.detail}`).join(',')}`);
    expect(changed()).toEqual([]);
    // The review's case: the source changes and is rebuilt, and git sees only the source.
    write(dir, {
      'packages/hooks/src/index.ts': "export const shop = { name: 'shop', classify: () => ({ failureType: null }) };\n",
      'packages/hooks/dist/index.js': "export const shop = { name: 'shop', classify: () => ({ failureType: null }) };\n",
    });
    expect(changed()).toEqual(['packages/hooks/src/index.ts !config-changed: packages/hooks/src/index.ts: the hooks, plugins, and environments a pass depends on']);
    // Generated beside the config, with no package of its own to trace it to a source.
    write(dir, { 'generated/hooks.mjs': 'export const ok = () => true;\n', 'other.config.mjs': "import { ok } from './generated/hooks.mjs';\nexport default { hooks: { ok } };\n" });
    expect(changed('other.config.mjs')).toContain(
      "other.config.mjs !config-unverified: other.config.mjs: loads generated/hooks.mjs, which git doesn't track; a human must review every change outside the case files",
    );
  });

  it('follows the workspace packages a built package bundles, and counts its whole directory', () => {
    const dir = repo({
      '.gitignore': 'node_modules\ndist\n',
      'cige.config.mjs': "import { verdict } from '@acme/hooks';\nimport { helper } from './helper.mjs';\nexport default { hooks: { verdict, helper } };\n",
      // Reached strictly here, after the stand-in walk has queued it leniently: the stricter walk wins.
      'helper.mjs': "export const helper = async () => (await import('./packages/hooks/src/lazy.mjs')).ok;\n",
      // Bundled with tsup's `noExternal` or similar: what it imports from @acme/shared and ../../../local is inlined into dist.
      'packages/hooks/package.json': JSON.stringify({ name: '@acme/hooks', type: 'module', exports: './dist/index.js', devDependencies: { '@acme/shared': 'workspace:*' } }),
      // The review's case: an enum Node's strip-only mode refuses, as a tsc-built package holds, doesn't hide the imports beside it.
      'packages/hooks/src/index.ts': "export enum Mode { A, B }\nexport { verdict } from '@acme/shared';\nexport { local } from '../../../local/src/index.ts';\n",
      // A built package's sources are compiled, not run by Node, and what they can't trace doesn't block: their package counts as a whole.
      'packages/hooks/src/load.ts': 'export class Loader {\n  constructor(private readonly name: string) {}\n  load = () => import(this.name);\n}\n',
      'packages/hooks/src/lazy.mjs': 'export const ok = true;\n',
      'packages/hooks/src/unused.ts': 'export const unused = 1;\n',
      'packages/hooks/dist/index.js': 'export const verdict = () => false;\nexport const local = () => false;\n',
      'packages/shared/package.json': JSON.stringify({ name: '@acme/shared', type: 'module', exports: './dist/index.js' }),
      'packages/shared/src/index.ts': 'export const verdict = () => false;\n',
      'local/src/index.ts': 'export const local = () => false;\n',
      'checkout.cige.json': BASE,
    });
    mkdirSync(path.join(dir, 'node_modules/@acme'), { recursive: true });
    symlinkSync('../../packages/hooks', path.join(dir, 'node_modules/@acme/hooks'), 'dir');
    mkdirSync(path.join(dir, 'packages/hooks/node_modules/@acme'), { recursive: true });
    symlinkSync('../../../shared', path.join(dir, 'packages/hooks/node_modules/@acme/shared'), 'dir');
    const changed = () =>
      diffSince('HEAD', dir, { configFiles: [path.join(dir, 'cige.config.mjs')] }).files.map((entry) => `${entry.file} ${entry.changes.map((item) => `${item.blocking ? '!' : ''}${item.kind}`).join(',')}`);
    expect(changed()).toEqual([]);
    // The review's case: @acme/shared is inlined into hooks' dist, and isn't built itself, so only hooks' package.json leads to it.
    write(dir, { 'packages/shared/src/index.ts': 'export const verdict = () => true;\n' });
    expect(changed()).toEqual(['packages/shared/src/index.ts !config-changed']);
    // An undeclared module the sources import by path.
    write(dir, { 'packages/shared/src/index.ts': 'export const verdict = () => false;\n', 'local/src/index.ts': 'export const local = () => true;\n' });
    expect(changed()).toEqual(['local/src/index.ts !config-changed']);
    // The review's case: outside every stand-in, a load the walk can't follow blocks, however the walk got there.
    write(dir, { 'local/src/index.ts': "import { createRequire } from 'node:module';\nexport const local = () => createRequire(import.meta.url)('../check.cjs')();\n" });
    expect(changed()).toEqual(['cige.config.mjs !config-unverified', 'local/src/index.ts !config-changed']);
    write(dir, { 'local/src/index.ts': "const name = '../check.mjs';\nexport const local = async () => (await import(name)).ok;\n" });
    expect(changed()).toEqual(['cige.config.mjs !config-unverified', 'local/src/index.ts !config-changed']);
    // A file deleted from the package: its directory counts, not only the files left in it.
    write(dir, { 'local/src/index.ts': 'export const local = () => false;\n' });
    rmSync(path.join(dir, 'packages/hooks/src/unused.ts'));
    expect(changed()).toEqual(['packages/hooks/src/unused.ts !config-changed']);
    write(dir, { 'packages/hooks/src/unused.ts': 'export const unused = 1;\n', 'packages/hooks/src/lazy.mjs': 'const name = "./ok.mjs";\nexport const ok = (await import(name)).ok;\n' });
    expect(changed()).toEqual(['cige.config.mjs !config-unverified', 'packages/hooks/src/lazy.mjs !config-changed']);
    // cubic's case: a stand-in's package.json that doesn't parse can't say what it bundles.
    write(dir, { 'packages/hooks/src/lazy.mjs': 'export const ok = true;\n', 'packages/shared/package.json': '{ "name": "@acme/shared",' });
    expect(changed()).toEqual(['cige.config.mjs !config-unverified', 'packages/shared/package.json !config-changed']);
  });

  it("never counts the config's own package as a stand-in, so its cases stay cases", () => {
    const dir = repo({
      '.gitignore': 'node_modules\ndist\n',
      'apps/web/package.json': JSON.stringify({ name: '@acme/web', type: 'module', exports: { './helper': './src/helper.js', './built': './dist/built.js' } }),
      'apps/web/src/helper.js': 'export const help = () => false;\n',
      'apps/web/dist/built.js': 'export const built = () => false;\n',
      'apps/web/cige.config.mjs': "import { verdict } from '@acme/hooks';\nexport default { hooks: { verdict } };\n",
      'apps/web/checkout.cige.json': BASE,
      // The hooks package depends back on the app, and bundles a helper from it.
      'packages/hooks/package.json': JSON.stringify({ name: '@acme/hooks', type: 'module', exports: './dist/index.js', devDependencies: { '@acme/web': 'workspace:*' } }),
      'packages/hooks/src/index.ts': "import { help } from '@acme/web/helper';\nexport const verdict = help;\n",
      'packages/hooks/dist/index.js': 'export const verdict = () => false;\n',
    });
    mkdirSync(path.join(dir, 'apps/web/node_modules/@acme'), { recursive: true });
    symlinkSync('../../../../packages/hooks', path.join(dir, 'apps/web/node_modules/@acme/hooks'), 'dir');
    mkdirSync(path.join(dir, 'packages/hooks/node_modules/@acme'), { recursive: true });
    symlinkSync('../../../../apps/web', path.join(dir, 'packages/hooks/node_modules/@acme/web'), 'dir');
    const diff = () => diffSince('HEAD', path.join(dir, 'apps/web'), { configFiles: [path.join(dir, 'apps/web/cige.config.mjs')] });
    write(dir, { 'apps/web/checkout.cige.json': edited((file) => void (file.Execution[1].step = 'pay')) });
    expect(diff()).toMatchObject({ blocking: 0 });
    // cubic's case: what the hooks' sources import from the app still counts, file by file.
    write(dir, { 'apps/web/src/helper.js': 'export const help = () => true;\n' });
    expect(diff().files.map((entry) => `${entry.file} ${entry.changes.map((item) => item.kind).join(',')}`)).toEqual([
      'apps/web/checkout.cige.json execution-changed',
      'apps/web/src/helper.js config-changed',
    ]);
    // Built output in the app has no sources to stand for it, however the walk reached it.
    write(dir, { 'apps/web/src/helper.js': 'export const help = () => false;\n', 'packages/hooks/src/index.ts': "export { built as verdict } from '@acme/web/built';\n" });
    expect(diff().files.flatMap((entry) => entry.changes.filter((item) => item.kind === 'config-unverified').map((item) => item.detail))).toEqual([
      "apps/web/cige.config.mjs: loads apps/web/dist/built.js, which git doesn't track; a human must review every change outside the case files",
    ]);
  });

  it('blocks retargeting a symlink an alias reaches, file or directory', () => {
    const linked = (link: string, target: string) => {
      const dir = repo({
        'package.json': JSON.stringify({ type: 'module', imports: { '#hooks/*': './hooks/*.ts' } }),
        'cige.config.ts': "import { orderPersisted } from '#hooks/order';\nexport default { hooks: { orderPersisted } };\n",
        'impl/strict.ts': "export const orderPersisted = async () => (await fetch('/orders/1')).ok;\n",
        'impl/loose.ts': 'export const orderPersisted = async () => true;\n',
        'strict/order.ts': "export const orderPersisted = async () => (await fetch('/orders/1')).ok;\n",
        'loose/order.ts': 'export const orderPersisted = async () => true;\n',
        'checkout.cige.json': BASE,
      });
      mkdirSync(path.dirname(path.join(dir, link)), { recursive: true });
      symlinkSync(target, path.join(dir, link));
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['-c', 'user.email=cige@example.test', '-c', 'user.name=cige', 'commit', '-q', '-m', 'link'], { cwd: dir, stdio: 'pipe' });
      return dir;
    };
    const retarget = (dir: string, link: string, target: string) => {
      unlinkSync(path.join(dir, link));
      symlinkSync(target, path.join(dir, link));
      return diffSince('HEAD', dir, { configFiles: [path.join(dir, 'cige.config.ts')] }).files.map((entry) => `${entry.file} ${entry.changes.map((item) => item.kind).join(',')}`);
    };
    // The review's case: `#hooks/order` lands on a tracked link, which Node reads through to its target.
    expect(retarget(linked('hooks/order.ts', '../impl/strict.ts'), 'hooks/order.ts', '../impl/loose.ts')).toEqual(['hooks/order.ts config-changed']);
    expect(retarget(linked('hooks', 'strict'), 'hooks', 'loose')).toEqual(['hooks config-changed']);
    // A tracked file turned into a link, not yet staged: git still lists it as a file.
    const retyped = linked('impl/link.ts', 'strict.ts');
    write(retyped, { 'hooks/order.ts': "export * from '../impl/strict.ts';\n" });
    execFileSync('git', ['add', '.'], { cwd: retyped, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.email=cige@example.test', '-c', 'user.name=cige', 'commit', '-q', '-m', 'file'], { cwd: retyped, stdio: 'pipe' });
    expect(retarget(retyped, 'hooks/order.ts', '../impl/loose.ts')).toEqual(['hooks/order.ts config-changed']);
  });

  it('says the Intent held when only the path changed, and blocks a file that no longer parses', () => {
    const dir = repo({ 'checkout.cige.json': BASE });
    write(dir, { 'checkout.cige.json': edited((file) => void (file.Execution[1].step = 'pay')) });
    expect(diffSince('HEAD', dir)).toMatchObject({ blocking: 0, intentUnchanged: true });
    write(dir, { 'checkout.cige.json': '{ "Context": ' });
    expect(diffSince('HEAD', dir).files[0]?.changes[0]).toMatchObject({ kind: 'invalid', blocking: true });
  });
});
