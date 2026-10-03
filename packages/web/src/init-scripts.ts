/**
 * Init scripts: test code every document of an attempt runs after it is
 * created and before any of its own scripts, in every tab and frame, as
 * Playwright's `addInitScript` runs it. The configured ones apply to every
 * attempt; `browser.addInitScript` adds more for one attempt.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigurationError, TestError, validateJsonValue, type JsonValue } from 'e2e/engine';
import { KEEP_NAMES_HELPER } from './evaluation.ts';
import { message } from './support.ts';

/**
 * One init script: a string of JavaScript source, a `{ path }` to a file of
 * it relative to the project root, or a function serialized into the page,
 * which can close over nothing from the test process.
 */
export type WebInitScript = string | { readonly path: string } | (() => unknown);

/** Refuses, at config load, a `web({ initScripts })` value that is not a list of scripts. */
export function validateInitScripts(scripts: unknown): void {
  if (!Array.isArray(scripts)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ initScripts }) must be an array of scripts');
  }
  scripts.forEach((script: unknown, index) => {
    const problem = scriptProblem(script);
    if (problem !== undefined) throw new ConfigurationError('INVALID_CONFIG', `web({ initScripts })[${index}] ${problem}`);
  });
}

/**
 * Reads the configured scripts into page source, a `path` against the
 * project root; a file that cannot be read is `INVALID_CONFIG`.
 */
export function loadConfiguredInitScripts(scripts: readonly WebInitScript[], projectRoot: string): Promise<string[]> {
  return Promise.all(scripts.map(async (script, index) => {
    try {
      return await initScriptSource(script, undefined, (file) => path.resolve(projectRoot, file));
    } catch (cause) {
      throw new ConfigurationError('INVALID_CONFIG', `web({ initScripts })[${index}] ${message(cause)}`, { cause });
    }
  }));
}

/**
 * Validates one script `browser.addInitScript` was given and reads it into
 * page source, a `path` through `resolvePath`. Only a function takes an
 * argument, as in Playwright.
 */
export async function testInitScriptSource(
  script: unknown,
  argument: { readonly arg: unknown } | undefined,
  resolvePath: (file: string) => string,
): Promise<string> {
  const problem = scriptProblem(script);
  if (problem !== undefined) throw new TestError('INVALID_ARGUMENT', `browser.addInitScript script ${problem}`);
  if (argument !== undefined && typeof script !== 'function') {
    throw new TestError('INVALID_ARGUMENT', 'browser.addInitScript takes an argument only with a function script');
  }
  validateJsonValue(argument?.arg, 'addInitScript argument');
  try {
    return await initScriptSource(script as WebInitScript, argument?.arg as JsonValue | undefined, resolvePath);
  } catch (cause) {
    throw new TestError('INVALID_ARGUMENT', `browser.addInitScript ${message(cause)}`, { cause });
  }
}

/** The step label of a script: the file a `path` names, else its kind, never its source. */
export function initScriptLabel(script: unknown): string {
  if (typeof script === 'function') return 'function';
  if (typeof script === 'string') return 'source';
  const file = typeof script === 'object' && script !== null ? (script as { path?: unknown }).path : undefined;
  return typeof file === 'string' ? file : '';
}

/** What is wrong with a value given as one script, or `undefined` when it is one. */
function scriptProblem(script: unknown): string | undefined {
  if (typeof script === 'string' || typeof script === 'function') return undefined;
  if (typeof script !== 'object' || script === null || Array.isArray(script)) {
    const got = script === null ? 'null' : Array.isArray(script) ? 'an array' : typeof script;
    return `must be a string of source, a { path }, or a function, got ${got}`;
  }
  const unknown = Object.keys(script).filter((key) => key !== 'path');
  if (unknown.length > 0) return `takes only path, got ${unknown.join(', ')}`;
  const file = (script as { path?: unknown }).path;
  if (typeof file !== 'string' || file === '') return 'path must be a non-empty string';
  return undefined;
}

/**
 * The page source of one script. A function is called with its JSON argument
 * as Playwright calls it, beside the `__name` helper tsx's output needs. A
 * file gets a `sourceURL`, so a stack trace in the page names it.
 */
async function initScriptSource(
  script: WebInitScript,
  arg: JsonValue | undefined,
  resolvePath: (file: string) => string,
): Promise<string> {
  if (typeof script === 'string') return script;
  if (typeof script === 'function') {
    return `(() => {\n${KEEP_NAMES_HELPER}\n(${script.toString()}\n)(${arg === undefined ? '' : JSON.stringify(arg)});\n})();`;
  }
  const file = resolvePath(script.path);
  try {
    return `${await readFile(file, 'utf8')}\n//# sourceURL=${file.replace(/[\r\n]/g, '')}`;
  } catch (cause) {
    throw new Error(`path cannot be read: ${file} (${(cause as NodeJS.ErrnoException).code ?? message(cause)})`, { cause });
  }
}
