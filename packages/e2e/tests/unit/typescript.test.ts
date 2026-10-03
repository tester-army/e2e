/**
 * The compiler, judged by what its output does when Node.js runs it: the
 * exports a compiled file produces, the code that ran, and where a stack
 * frame points. Each case compiles a file, writes the output beside it, and
 * runs it in a child Node.js with source maps on, as e2e's loader would.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompiledExtension } from '../../src/config/compiled-files.ts';
import type { CompilerOptions } from '../../src/config/tsconfig.ts';
import { compileTypeScript } from '../../src/config/typescript.ts';

const KINDS: Record<string, CompiledExtension> = {
  '.ts': { lang: 'ts', format: 'module', written: '.js' },
  '.tsx': { lang: 'tsx', format: 'module', written: '.js' },
  '.jsx': { lang: 'jsx', format: 'module', written: '.js' },
  '.cts': { lang: 'ts', format: 'commonjs', written: '.cjs' },
};

let dir: string;

/**
 * Compiles `source` as `name` with `options`, writes the output as the
 * module Node.js would run, and runs it: an ES module's `result` export, or
 * a CommonJS module's `module.exports`, printed as JSON. A throw prints the
 * error's stack instead.
 */
function run(name: string, source: string, options: CompilerOptions = {}): unknown {
  const file = path.join(dir, name);
  const extension = path.extname(name);
  const kind = KINDS[extension]!;
  writeFileSync(file, source);
  const compiled = path.join(dir, `${name}.${kind.format === 'module' ? 'mjs' : 'cjs'}`);
  writeFileSync(compiled, compileTypeScript(file, source, kind, options));
  const runner = `
    import { createRequire } from 'node:module';
    try {
      const value = ${kind.format === 'module' ? `(await import(${JSON.stringify(pathToFileURL(compiled).href)})).result` : `createRequire(import.meta.url)(${JSON.stringify(compiled)})`};
      console.log(JSON.stringify({ value }));
    } catch (error) {
      console.log(JSON.stringify({ stack: error.stack }));
    }`;
  const output = execFileSync(process.execPath, ['--enable-source-maps', '--input-type=module', '--eval', runner], { encoding: 'utf8' });
  return JSON.parse(output.trim().split('\n').at(-1)!) as unknown;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-typescript-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('compileTypeScript', () => {
  it('runs enums, namespaces, and parameter properties, and drops type-only imports', () => {
    const source = [
      "import type { Missing } from './missing.ts';",
      'enum E { A, B = "b" }',
      'namespace N { export const x = 2; }',
      'class P { constructor(public readonly v: number) {} }',
      'const typed: Missing | undefined = undefined;',
      'export const result = [E.A, E.B, N.x, new P(3).v, typed ?? null];',
    ].join('\n');
    expect(run('file.ts', source)).toEqual({ value: [0, 'b', 2, 3, null] });
  });

  it('keeps an unused value import, and its side effect, under verbatimModuleSyntax only', () => {
    writeFileSync(path.join(dir, 'effect.mjs'), 'globalThis.effect = true;\nexport const unused = 1;\n');
    const source = "import { unused } from './effect.mjs';\nexport const result = globalThis.effect === true;\n";
    expect(run('kept.ts', source, { verbatimModuleSyntax: true })).toEqual({ value: true });
    expect(run('elided.ts', source)).toEqual({ value: false });
  });

  it('compiles JSX classically unless the tsconfig names the automatic runtime', () => {
    const view = 'const h = (tag: string, _p: unknown, ...c: unknown[]) => `<${tag}>${c.join("")}</${tag}>`;\nexport const result = <b>jsx</b>;\n';
    expect(run('view.tsx', view, { jsx: 'react', jsxFactory: 'h' })).toEqual({ value: '<b>jsx</b>' });
    expect(run('view.jsx', view.replace(': string', '').replace(', _p: unknown, ...c: unknown[]', ', _p, ...c'), { jsx: 'react', jsxFactory: 'h' })).toEqual({
      value: '<b>jsx</b>',
    });
    expect(run('classic.tsx', 'export const result = (() => <b />).toString();\n')).toMatchObject({ value: expect.stringContaining('React.createElement') });
  });

  it('runs legacy decorators with metadata when the tsconfig enables them, from helpers the project need not install', () => {
    const source = [
      'const seen: string[] = [];',
      'const track = (target: Function) => { seen.push(target.name); };',
      '@track class A { m(x: string): void {} }',
      'export const result = seen;',
    ].join('\n');
    expect(run('decorated.ts', source, { experimentalDecorators: true, emitDecoratorMetadata: true })).toEqual({ value: ['A'] });
    expect(run('decorated.cts', source.replace('export const result = seen;', 'module.exports = seen;'), { experimentalDecorators: true })).toEqual({
      value: ['A'],
    });
  });

  it('assigns rather than defines class fields for a target before ES2022', () => {
    const source = 'class A { declared: number; }\nexport const result = Object.hasOwn(new A(), "declared");\n';
    expect(run('es2020.ts', source, { target: 'ES2020' })).toEqual({ value: false });
    expect(run('es6.ts', source, { target: 'ES6' })).toEqual({ value: false });
    expect(run('es2022.ts', source, { target: 'ES2022' })).toEqual({ value: true });
    expect(run('esnext.ts', source, { target: 'ESNext' })).toEqual({ value: true });
    expect(run('explicit.ts', source, { target: 'ES2022', useDefineForClassFields: false })).toEqual({ value: false });
  });

  it('runs `using` on every supported Node.js', () => {
    const source = 'const log: string[] = [];\n{ using x = { [Symbol.dispose]() { log.push("disposed"); } }; log.push("body"); }\nexport const result = log;\n';
    expect(run('using.ts', source)).toEqual({ value: ['body', 'disposed'] });
  });

  it('runs .cts as CommonJS, keeping a hashbang, the prologue, and type-only imports out of its way', () => {
    const source = [
      '#!/usr/bin/env node',
      "'use strict';",
      "import type { Stats } from 'node:fs';",
      "import path = require('node:path');",
      'const sloppy = (function (this: unknown) { return this === undefined; })();',
      'export = { ext: path.extname("a.cts"), strict: sloppy, stats: null as Stats | null };',
    ].join('\n');
    expect(run('helper.cts', source)).toEqual({ value: { ext: '.cts', strict: true, stats: null } });
    const licensed = ['/**', ' * License header.', ' */', '// eslint-disable', "'use strict';", 'module.exports = (function (this: unknown) { return this === undefined; })();'].join('\n');
    expect(run('licensed.cts', licensed)).toEqual({ value: true });
  });

  it.each([
    ['an ES module', 'thrower.ts', 'export const result = 1;'],
    ['CommonJS', 'thrower.cts', 'module.exports = 1;'],
    ['CommonJS with a directive', 'strict.cts', "'use strict';\nmodule.exports = 1;"],
  ])('points a stack frame of %s at the source line', (_case, name, tail) => {
    const source = `${tail}\ninterface Shape { readonly n: number }\nconst shape: Shape = { n: 1 };\nthrow new Error(\`at line \${shape.n}\`);\n`;
    const { stack } = run(name, source) as { stack: string };
    const line = source.split('\n').findIndex((text) => text.startsWith('throw')) + 1;
    expect(stack).toContain(`${path.join(dir, name)}:${line}:7`);
  });

  it('names the file, line, and character column of a syntax error', () => {
    const file = path.join(dir, 'broken.e2e.ts');
    expect(() => compileTypeScript(file, 'const s = "żółć";\nconst a: = 1;\n', KINDS['.ts']!, {})).toThrow(new SyntaxError(`${file}:2:10: Unexpected token`));
  });
});
