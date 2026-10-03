import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetTsconfigs } from '../../src/config/tsconfig.ts';
import { compileTypeScript } from '../../src/config/typescript.ts';

let dir: string;

/** Compiles `source` as `name` in a project whose tsconfig.json has `compilerOptions`. */
function compile(source: string, compilerOptions?: Record<string, unknown>, name = 'file.ts'): string {
  if (compilerOptions !== undefined) writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions }));
  forgetTsconfigs();
  return compileTypeScript(path.join(dir, name), source, name.endsWith('.cts') ? 'commonjs' : 'module');
}

/** The compiled code without its inline source map. */
const code = (compiled: string): string => compiled.slice(0, compiled.lastIndexOf('\n//# sourceMappingURL='));

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-typescript-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('compileTypeScript', () => {
  it('compiles enums, namespaces, and parameter properties, and drops type-only imports', () => {
    const compiled = code(compile(
      "import type { T } from './t.ts';\nimport { u } from './u.ts';\nexport enum E { A }\nexport namespace N { export const x = 1; }\nexport class P { constructor(private readonly v: T) {} }\n",
    ));
    expect(compiled).not.toContain('./t.ts');
    expect(compiled).not.toContain('./u.ts');
    expect(compiled).toContain('E[E["A"] = 0] = "A"');
    expect(compiled).toContain('this.v = v');
  });

  it('keeps every value import under verbatimModuleSyntax', () => {
    expect(code(compile("import { u } from './u.ts';\nexport {};\n", { verbatimModuleSyntax: true }))).toContain("import { u } from './u.ts'".replaceAll("'", '"'));
  });

  it('compiles JSX classically unless the tsconfig names the automatic runtime', () => {
    expect(code(compile('export const a = <b />;\n', undefined, 'view.tsx'))).toContain('React.createElement("b"');
    expect(code(compile('export const a = <b />;\n', { jsx: 'react', jsxFactory: 'h' }, 'view.tsx'))).toContain('h("b"');
    expect(code(compile('export const a = <b />;\n', { jsx: 'react-jsx', jsxImportSource: 'preact' }, 'view.tsx'))).toContain('from "preact/jsx-runtime"');
  });

  it('compiles legacy decorators with metadata when the tsconfig enables them', () => {
    const compiled = code(compile('const d = (t: unknown) => t;\n@d export class A { m(x: string): void {} }\n', { experimentalDecorators: true, emitDecoratorMetadata: true }));
    expect(compiled).toMatch(/from "file:\/\/\/[^"]*\/@oxc-project\/runtime\/src\/helpers\/decorate\.js"/);
    expect(compiled).not.toContain('@d');
  });

  it('assigns rather than defines class fields for a target before ES2022', () => {
    const source = 'export class A { declared: number; set = 1; }\n';
    expect(code(compile(source, { target: 'ES2020' }))).not.toContain('declared');
    expect(code(compile(source, { target: 'ES2022' }))).toContain('declared');
    expect(code(compile(source, { target: 'ES2022', useDefineForClassFields: false }))).not.toContain('declared');
  });

  it('lowers syntax the running Node.js lacks with helpers from e2e', () => {
    const compiled = code(compile('export {};\n{ using x = { [Symbol.dispose]() {} }; }\n'));
    expect(compiled.includes('/@oxc-project/runtime/src/helpers/usingCtx.js')).toBe(process.versions.node.startsWith('22.'));
  });

  it('requires the helpers .cts needs from the copy e2e installs, by path', () => {
    const compiled = code(compile('const d = (t: unknown) => t;\n@d class A {}\nmodule.exports = A;\n', { experimentalDecorators: true }, 'decorated.cts'));
    expect(compiled).toMatch(/require\("\/[^"]*\/@oxc-project\/runtime\/src\/helpers\/decorate\.js"\)/);
  });

  it('compiles .cts to CommonJS, with no module marker for its type-only imports', () => {
    const compiled = code(compile("import type { Stats } from 'node:fs';\nimport path = require('node:path');\nexport = { ext: path.extname('a.cts') as string, stats: null as Stats | null };\n", {}, 'helper.cts'));
    expect(compiled).toBe(
      'require = require("node:module").createRequire(__filename);\nconst path = require("node:path");\nmodule.exports = {\n\text: path.extname("a.cts"),\n\tstats: null\n};\n',
    );
  });

  it('requires through module hooks from the first statement of .cts, after a hashbang and the directive prologue', () => {
    const compiled = compile("#!/usr/bin/env node\n'use strict';\nconst a: number = require('./b');\nthrow new Error(String(a));\n", {}, 'bin.cts');
    expect(code(compiled)).toBe(
      '#!/usr/bin/env node\n"use strict";\nrequire = require("node:module").createRequire(__filename);\nconst a = require("./b");\nthrow new Error(String(a));\n',
    );
    const map = JSON.parse(Buffer.from(compiled.slice(compiled.lastIndexOf('base64,') + 7), 'base64').toString('utf8')) as { mappings: string };
    // Generated lines 3 (the added require) and 1 (the hashbang) map nowhere; line 4 maps to source line 3.
    expect(map.mappings.split(';').map((line) => line === '')).toEqual([true, false, true, false, false]);
  });

  it('compiles JSX in a .jsx file', () => {
    expect(code(compile('export const a = <b />;\n', { jsx: 'react', jsxFactory: 'h' }, 'view.jsx'))).toContain('h("b"');
  });

  it('maps the output to the file by its URL, so a frame names the file without the loader query', () => {
    const compiled = compile('export const a: number = 1;\n', undefined, '50% off #1.ts');
    const map = JSON.parse(Buffer.from(compiled.slice(compiled.lastIndexOf('base64,') + 7), 'base64').toString('utf8')) as { sources: string[]; sourcesContent?: unknown };
    expect(map.sources).toEqual([pathToFileURL(path.join(dir, '50% off #1.ts')).href]);
    expect(map).not.toHaveProperty('sourcesContent');
  });

  it('names the file, line, and character column of a syntax error', () => {
    mkdirSync(path.join(dir, 'tests'));
    expect(() => compile('const s = "żółć";\nconst a: = 1;\n', undefined, 'tests/broken.e2e.ts')).toThrow(
      new SyntaxError(`${path.join(dir, 'tests', 'broken.e2e.ts')}:2:10: Unexpected token`),
    );
  });
});
