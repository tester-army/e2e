/**
 * Turns a module loading failure into a sentence that names the fix. The
 * loader's own messages are accurate but stop at the symptom: a missing
 * package reads the same whether it was never added or just not installed,
 * and a removed export looks like a typo.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { withHint } from '../internal/errors.ts';
import { addDevDependencyCommand, detectPackageManager } from '../internal/package-manager.ts';
import { didYouMean, suggest } from '../internal/suggest.ts';

/** The runtime exports of `e2e`; a unit test keeps this list equal to the real module. */
export const RUNTIME_EXPORTS: readonly string[] = [
  'test',
  'describe',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'expect',
  'credentials',
  'secrets',
  'defineService',
  'unique',
  'AgentError',
  'isAgentError',
  'renderMarkdownReport',
];

/**
 * Exports removed from a public entry, by specifier, each with what stands in
 * for it. Consulted before the spelling and type heuristics, so a removed
 * runtime value never draws `import type` advice that fails the same way.
 */
const REMOVED_EXPORTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  e2e: {
    defineConfig: 'defineConfig was removed in e2e 0.5: default-export the object and end it with satisfies E2EConfig',
    BLOCKABLE_CODES:
      'BLOCKABLE_CODES was removed from e2e: a blocked verdict carries any code the errors reference marks blocked, and the set was never usable outside the runner',
    RUNTIME_CODES:
      "RUNTIME_CODES was removed from e2e: STEP_BUDGET_EXHAUSTED, STEP_TIMEOUT, and CANCELLED are the runtime's own codes, which an executor carries but never assigns",
    buildTraceEntry:
      'buildTraceEntry was removed from e2e: a CacheStore stores the entry it is handed as is, the runner frames and validates it',
    readTraceEntry:
      'readTraceEntry was removed from e2e: a CacheStore returns the entry it stored as is, the runner validates it',
  },
  'e2e/agent': {
    createAgent:
      'createAgent was removed from e2e/agent: write its options as the agents entry itself: agents: { default: { model, system, tools } }',
    isDefinedTool:
      'isDefinedTool was removed from e2e/agent: pass what defineTool returns in the tools of an agents entry, config loading checks each one itself',
    toolAppliesTo:
      'toolAppliesTo was removed from e2e/agent: the built-in agent offers a defined tool only on the platforms its annotations name',
  },
};

/**
 * The hint for TypeScript an installed package ships under a CommonJS scope:
 * the file is there, but it loads through `require`, which the TypeScript
 * loader does not hook, so Node reports it missing under the loader's query.
 */
function commonJsTypeScriptHint(file: string): string {
  let dir = path.dirname(file);
  while (!existsSync(path.join(dir, 'package.json')) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const manifest = path.join(dir, 'package.json');
  return `${file} exists: ${manifest} declares no "type": "module", so the file loads as CommonJS, which e2e's TypeScript loader does not transform; import the package's compiled JavaScript, or have the package declare "type": "module"`;
}

interface Manifest {
  readonly path: string;
  readonly dir: string;
  readonly packageManager: string | undefined;
  readonly dependencies: ReadonlySet<string>;
}

/**
 * The message of a failed import of `importer`, extended with what to do
 * about it when the cause is one the runner recognizes. Any other cause keeps
 * its own message.
 */
export function explainModuleError(cause: unknown, importer: string): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return withHint(message, moduleErrorHint(message, (cause as { code?: unknown } | null)?.code, importer));
}

function moduleErrorHint(message: string, code: unknown, importer: string): string {
  if (code === 'MODULE_NOT_FOUND') {
    const loaded = /Cannot find module '([^']+)\?namespace=[^']*'/.exec(message)?.[1];
    return loaded !== undefined && existsSync(loaded) ? commonJsTypeScriptHint(loaded) : '';
  }
  if (code === 'ERR_MODULE_NOT_FOUND') {
    const missing = /Cannot find (?:package|module) '([^']+)'/.exec(message)?.[1];
    if (missing !== undefined && !missing.startsWith('.') && !path.isAbsolute(missing)) {
      return missingPackageHint(packageNameOf(missing), importer);
    }
    return '';
  }
  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    const match = /Package subpath '([^']+)' is not defined by "exports" in (.+?package\.json)/.exec(message);
    return match === null ? '' : subpathHint(match[1]!, match[2]!);
  }
  const missingExport = /The requested module '([^']+)' does not provide an export named '([^']+)'/.exec(message);
  return missingExport === null ? '' : missingExportHint(missingExport[1]!, missingExport[2]!);
}

/** `@scope/name/subpath` and `name/subpath` reduce to the package that would be installed. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function missingPackageHint(name: string, importer: string): string {
  const manifest = nearestManifest(path.dirname(importer));
  const manager = detectPackageManager(manifest?.dir ?? path.dirname(importer), manifest?.packageManager);
  if (manifest?.dependencies.has(name) === true) {
    return `${name} is declared in ${manifest.path} but is not installed: run ${manager} install`;
  }
  return `add it to the project: ${addDevDependencyCommand(manager, name)}`;
}

function subpathHint(subpath: string, manifestPath: string): string {
  let parsed: { name?: unknown; exports?: unknown };
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof parsed;
  } catch {
    return '';
  }
  const name = typeof parsed.name === 'string' ? parsed.name : path.basename(path.dirname(manifestPath));
  const entries =
    typeof parsed.exports === 'object' && parsed.exports !== null && !Array.isArray(parsed.exports)
      ? Object.keys(parsed.exports).filter((key) => key.startsWith('.'))
      : ['.'];
  const specifiers = entries.map((entry) => (entry === '.' ? name : `${name}/${entry.slice(2)}`));
  const attempted = `${name}/${subpath.replace(/^\.\//, '')}`;
  return `${name} exports ${specifiers.join(', ')}${didYouMean(attempted, specifiers)}`;
}

function missingExportHint(specifier: string, exportName: string): string {
  const removed = REMOVED_EXPORTS[specifier]?.[exportName];
  if (removed !== undefined) return removed;
  if (specifier !== 'e2e') return '';
  const suggestion = suggest(exportName, RUNTIME_EXPORTS);
  if (suggestion !== undefined) return `did you mean "${suggestion}"?`;
  return /^[A-Z]/.test(exportName)
    ? `if ${exportName} is a type, import it with import type { ${exportName} } from 'e2e'`
    : `e2e exports ${RUNTIME_EXPORTS.join(', ')}`;
}

/** The closest package.json above `dir`, read for its declared dependencies. */
function nearestManifest(dir: string): Manifest | undefined {
  let current = dir;
  for (;;) {
    const manifestPath = path.join(current, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        const dependencies = new Set<string>();
        for (const block of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const section = parsed[block];
          if (typeof section === 'object' && section !== null) {
            for (const name of Object.keys(section)) dependencies.add(name);
          }
        }
        return {
          path: manifestPath,
          dir: current,
          packageManager: typeof parsed['packageManager'] === 'string' ? parsed['packageManager'] : undefined,
          dependencies,
        };
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
