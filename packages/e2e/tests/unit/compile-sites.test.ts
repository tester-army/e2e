/**
 * Where a test's `agent.act()` calls sit in its source: the test declared at
 * a line, its fixtures, each call's instruction digest and `unique()` params,
 * and which calls are bare statements a compiled block can replace.
 */

import { describe, expect, it } from 'vitest';
import { instructionDigest } from '../../src/cache/identity.ts';
import { SourceFile } from '../../src/compile/sites.ts';

const SOURCE = `import { test } from '@e2e-dev/web';
import { expect, unique } from 'e2e';

test('adds an address', async ({ app, agent: robot }) => {
  await app.open('/addresses');
  await robot.act('add {label} at {line}', { params: { label: unique(name), nested: { id: unique(\`n-\${id}\`) }, line: 'Pine Way' } });
  if (flag) await robot.act('dismiss the banner');
  await robot.act(\`pick \${choice}\`);
  const done = robot.act('wait for it');
});

test('ä naïve title', async ({ agent }) => {
  await agent.act(\`plain template\`);
});

for (const slug of slugs) {
  test(slug, (fixtures) => run(fixtures));
}
`;

describe('SourceFile', () => {
  const file = new SourceFile('tests/address.e2e.ts', SOURCE);

  it('reads the test declared at a line, its fixtures by local name, and where a new one goes', () => {
    const test = file.testAt(4);
    expect(test).toBeDefined();
    expect([...test!.fixtures]).toEqual([
      ['app', 'app'],
      ['agent', 'robot'],
    ]);
    expect(SOURCE.slice(test!.fixtureInsert, test!.fixtureInsert! + 3)).toBe(' })');
  });

  it('reads each call: its instruction and digest, its unique() params, and whether it is a bare statement', () => {
    const sites = file.testAt(4)!.sites;
    expect(sites.map((site) => [site.line, site.instruction, site.nested === undefined])).toEqual([
      [6, 'add {label} at {line}', true],
      [7, 'dismiss the banner', false],
      [8, undefined, true],
      [9, 'wait for it', false],
    ]);
    const [first] = sites;
    expect(first!.digest).toBe(instructionDigest('add {label} at {line}'));
    expect(first!.params).toEqual({
      type: 'object',
      entries: [
        ['label', { type: 'unique' }],
        ['nested', { type: 'object', entries: [['id', { type: 'unique' }]] }],
        ['line', { type: 'json', value: 'Pine Way' }],
      ],
    });
    expect(sites[1]!.params).toBeNull();
    expect([...first!.uniques]).toEqual([
      ['/label', 'name'],
      ['/nested/id', '`n-${id}`'],
    ]);
    expect(SOURCE.slice(first!.start, first!.end)).toMatch(/^await robot\.act\(.*\);$/su);
    expect(first!.indent).toBe('  ');
  });

  it('takes a template without substitutions as a literal, at UTF-16 offsets past non-ASCII text', () => {
    const [site] = file.testAt(12)!.sites;
    expect(site!.instruction).toBe('plain template');
    expect(SOURCE.slice(site!.start, site!.end)).toBe('await agent.act(`plain template`);');
  });

  it('finds the loop body declaration, whose callback has no fixture pattern', () => {
    const test = file.testAt(17);
    expect(test!.sites).toEqual([]);
    expect(test!.fixtureInsert).toBeUndefined();
  });

  it('finds the imported names, the e2e import, and where its next name goes', () => {
    expect([...file.importedNames()]).toEqual([
      ['test', '@e2e-dev/web'],
      ['expect', 'e2e'],
      ['unique', 'e2e'],
    ]);
    const imported = file.e2eImport();
    expect(SOURCE.slice(imported!.insert, imported!.insert + 7)).toBe(" } from");
    expect(file.afterImports()).toBe(SOURCE.indexOf("'e2e';") + "'e2e';".length);
  });
});

describe('SourceFile: params the source spells out', () => {
  const paramsOf = (call: string, preamble = ''): unknown =>
    new SourceFile('t.e2e.ts', `${preamble}test('x', async ({ agent }) => {\n  await ${call};\n});\n`).testAt(preamble.split('\n').length)!.sites[0]!.params;

  it('reads secrets and usernames named through credentials and secrets, directly or through a const', () => {
    expect(paramsOf("agent.act('a', { params: { pin: secrets.get('pin'), email: credentials.user('admin').username } })")).toEqual({
      type: 'object',
      entries: [
        ['pin', { type: 'secret', name: 'pin' }],
        ['email', { type: 'username', credential: 'admin' }],
      ],
    });
    expect(paramsOf("agent.act('a', { params: { password: account.password, n: -2, ok: true, none: null } })", "const account = credentials.user('admin');\n")).toEqual({
      type: 'object',
      entries: [
        ['password', { type: 'secret', name: 'admin.password' }],
        ['n', { type: 'json', value: -2 }],
        ['ok', { type: 'json', value: true }],
        ['none', { type: 'json', value: null }],
      ],
    });
  });

  it('gives up on params a variable, a spread, or a computed value holds', () => {
    expect(paramsOf("agent.act('a', { params: { id: orderId } })")).toBeUndefined();
    expect(paramsOf("agent.act('a', { params: { ...base } })")).toBeUndefined();
    expect(paramsOf("agent.act('a', options)")).toBeUndefined();
    expect(paramsOf("agent.act('a', { maxSteps: 5 })")).toBeNull();
  });

  it('reads a fixture pattern that gathers the rest', () => {
    const test = new SourceFile('t.e2e.ts', "test('x', async ({ agent, ...rest }) => {\n  await agent.act('a');\n});\n").testAt(1)!;
    expect(test.fixtureRest).toBe(true);
  });
});

describe('SourceFile.compiledBlocks', () => {
  const block = (from: string, eol = '\n') =>
    [
      '  /**',
      '   * @compiled agent.act("log in")',
      `   * @from ${JSON.stringify(from).replaceAll('*/', '*\\/')}`,
      '   * @recording d9508413f2a1',
      '   * @step c878aa968fdb.44136fa355b3',
      '   * @recordedAt 2026-10-04',
      '   * @compiledAt 2026-11-11',
      '   */',
      '  await screen.getByTestId("login").tap();',
      '  /** @end compiled */',
    ].join(eol);

  it('reads a block from its @compiled comment to its end comment, with the statement it came from exactly', () => {
    const from = "await agent.act('log in', {\n    params: { note: 'a */ b' }, // the account\n  });";
    const text = `test('x', async ({ agent, screen }) => {\n${block(from)} // trailing\n});\n`;
    const [found] = new SourceFile('t.e2e.ts', text).compiledBlocks();
    expect(found).toMatchObject({ line: 2, from, recording: 'd9508413f2a1', step: 'c878aa968fdb.44136fa355b3', recordedAt: '2026-10-04', compiledAt: '2026-11-11', verifiedAt: undefined });
    expect(text.slice(found!.start, found!.end)).toBe(block(from).trimStart());
    expect(text.slice(found!.end)).toBe(' // trailing\n});\n');
  });

  it('reads a block in a file with CRLF line ends', () => {
    const text = `test('x', async ({ agent, screen }) => {\r\n${block("await agent.act('log in');", '\r\n')}\r\n});\r\n`;
    expect(new SourceFile('t.e2e.ts', text).compiledBlocks().map((found) => found.from)).toEqual(["await agent.act('log in');"]);
  });

  it('refuses a block with no end, an end with no block, and a @from that is not JSON', () => {
    const open = block("await agent.act('a');").replace('/** @end compiled */', '');
    expect(() => new SourceFile('t.e2e.ts', `${open}\n${open}\n/** @end compiled */\n`).compiledBlocks()).toThrow(/no \/\*\* @end compiled \*\/ before the next one/u);
    expect(() => new SourceFile('t.e2e.ts', '/** @end compiled */\n').compiledBlocks()).toThrow(/with no @compiled block before it/u);
    expect(() => new SourceFile('t.e2e.ts', block("await agent.act('a');").replace(/@from .*/u, '@from not-json')).compiledBlocks()).toThrow(/@from is not a JSON string/u);
  });
});

describe('SourceFile: instructions built from literals', () => {
  it('reads string literals joined with + as one literal instruction', () => {
    const text = "test('x', async ({ agent }) => {\n  await agent.act(\n    'reset all expenses, ' +\n      ('then file ' + `one`),\n  );\n});\n";
    expect(new SourceFile('t.e2e.ts', text).testAt(1)!.sites[0]!.instruction).toBe('reset all expenses, then file one');
  });
});
