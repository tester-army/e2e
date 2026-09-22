/**
 * The `e2e` and `e2e/engine` types compile without the optional `ai` peer.
 * `cli-boot.test.ts` is the runtime side of that promise; this is the type
 * side. A project on the AI-SDK-free path (a hand-rolled `StepExecutor`, a
 * deterministic suite) has no `ai` in its node_modules, and `e2e init` writes
 * no tsconfig, so one `.d.ts` under `dist/` that imports from `ai` is a
 * TS2307 in the project's build unless `skipLibCheck` hides it. `e2e/agent`
 * is the AI SDK executor builder and, like each `e2e/oauth/*` constructor,
 * may name the peer's types; `@ai-sdk/provider` is a dependency, but only
 * those constructors use it.
 *
 * The check is the compiler's own file list, not a grep: a consumer-shaped
 * probe (`node_modules/e2e` linked to this package, the entry points resolved
 * through its `exports`) is compiled with `--explainFiles`, and any file of
 * the closure under `node_modules/ai` or `node_modules/@ai-sdk` fails the
 * test with the imports that reached it. `skipLibCheck` skips checking a
 * declaration file, never loading it, so the list is the same either way.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const TSC = path.join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
/** Where the optional AI SDK peers live under any node_modules, pnpm's `.pnpm` store included. */
const PEER_SEGMENTS = ['/node_modules/ai/', '/node_modules/@ai-sdk/'];

/** The documented AI-SDK-free project: a hand-rolled executor and the engine contract, nothing from `e2e/agent`. */
const PROBE = `import { credentials, expect, secrets, test, type E2EConfig, type RunEvent, type StepExecutor } from 'e2e';
import { defineEngine, type EngineHandle } from 'e2e/engine';

declare const engine: EngineHandle;
declare const event: RunEvent;
const own: StepExecutor = {
  name: 'own',
  async runStep() {
    return { status: 'passed', summary: 'done' };
  },
};
export default { targets: [{ engine }], agents: { default: own } } satisfies E2EConfig;
export { credentials, defineEngine, event, expect, secrets, test };
`;

/** A strict NodeNext project, `skipLibCheck` on as in this repo: the probe is checked, the closure is only listed. */
const TSCONFIG = {
  compilerOptions: {
    target: 'ES2023',
    lib: ['ES2023', 'DOM'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
  },
  files: ['probe.ts'],
};

/** One file of the program and the `--explainFiles` reasons it was included. */
interface ClosureEntry {
  readonly file: string;
  readonly reasons: readonly string[];
}

/**
 * Splits `--explainFiles` output into the files of the program, each with its
 * indented reason lines, and the diagnostics printed among them.
 */
function parseExplainFiles(output: string, cwd: string): { closure: ClosureEntry[]; diagnostics: string[] } {
  const closure: ClosureEntry[] = [];
  const diagnostics: string[] = [];
  let current: { file: string; reasons: string[] } | undefined;
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    if (/\berror TS\d+:/.test(line)) {
      diagnostics.push(line.trim());
      current = undefined;
    } else if (/^\s/.test(line)) {
      current?.reasons.push(line.trim());
    } else {
      current = { file: path.resolve(cwd, line.trim()), reasons: [] };
      closure.push(current);
    }
  }
  return { closure, diagnostics };
}

/** A path as the failure message shows it: relative to this package when inside it. */
function describePath(file: string): string {
  const relative = path.relative(PACKAGE_ROOT, file);
  return relative.startsWith('..') ? file : relative;
}

/** One `Imported via` reason with its importer made readable and the package id dropped. */
function describeReason(reason: string, cwd: string): string {
  return reason
    .replace(/ from file '([^']+)'/, (_match, importer: string) => ` from file '${describePath(path.resolve(cwd, importer))}'`)
    .replace(/ with packageId '[^']*'/, '');
}

describe('the e2e and e2e/engine types in a project without the ai package', () => {
  let dir: string;
  let closure: ClosureEntry[];
  let diagnostics: string[];

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'e2e-types-without-ai-')));
    mkdirSync(path.join(dir, 'node_modules', '@types'), { recursive: true });
    symlinkSync(PACKAGE_ROOT, path.join(dir, 'node_modules', 'e2e'), 'junction');
    symlinkSync(path.join(PACKAGE_ROOT, 'node_modules', '@types', 'node'), path.join(dir, 'node_modules', '@types', 'node'), 'junction');
    writeFileSync(path.join(dir, 'probe.ts'), PROBE);
    writeFileSync(path.join(dir, 'tsconfig.json'), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
    const output = await execFileAsync(process.execPath, [TSC, '--project', dir, '--explainFiles'], { cwd: dir, maxBuffer: 64 * 1024 * 1024 })
      .then((result) => result.stdout, (error: Error & { stdout?: string }) => error.stdout ?? '');
    ({ closure, diagnostics } = parseExplainFiles(output, dir));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the entry points through the package exports and compiles', () => {
    expect(diagnostics).toEqual([]);
    const files = closure.map((entry) => entry.file);
    expect(files).toContain(path.join(PACKAGE_ROOT, 'dist', 'index.d.ts'));
    expect(files).toContain(path.join(PACKAGE_ROOT, 'dist', 'engine', 'index.d.ts'));
  });

  it('reaches no file of the ai package or an @ai-sdk package', () => {
    const offenders = closure
      .filter((entry) => PEER_SEGMENTS.some((segment) => entry.file.includes(segment)))
      .map((entry) => {
        const imports = new Set(entry.reasons.filter((reason) => reason.startsWith('Imported via')).map((reason) => describeReason(reason, dir)));
        return [describePath(entry.file), ...[...imports].map((reason) => `  ${reason}`)].join('\n');
      });
    expect(offenders, 'a .d.ts on the e2e or e2e/engine entry imports from the optional AI SDK').toEqual([]);
  });
});
