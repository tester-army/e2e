/**
 * Asserts that the error reference documents every code the runner can raise,
 * and names no code the runner cannot.
 *
 * The inventory is read from the source, not from a hand-kept list:
 * `AgentErrorCode` (`src/types.ts`), `ENGINE_ERROR_CODES` (`src/engine/contract.ts`),
 * and every literal handed to the `E2EError` family across the published packages.
 * Runner codes are plain strings by design, so the constructor-argument scan
 * is the closest thing to a union they have.
 *
 * Usage: `node scripts/check-error-codes.ts`. Exits 1 on the first
 * discrepancy, listing every missing and every unknown code.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_ROOTS = [
  'packages/e2e/src',
  'packages/web/src',
  'packages/mobile/src',
  'packages/github/src',
  'packages/decision/src',
  'packages/acp/src',
];
const TYPES_FILE = 'packages/e2e/src/types.ts';
const CONTRACT_FILE = 'packages/e2e/src/engine/contract.ts';
const ERRORS_PAGE = 'docs/reference/errors.mdx';
const ENGINE_PAGE = 'docs/reference/engine.mdx';

const CODE_PATTERN = /'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)'/g;

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function literals(text: string): string[] {
  return [...text.matchAll(CODE_PATTERN)].map((match) => match[1]!);
}

/** Every `.ts` source file under the published packages, tests excluded. */
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
    }
  };
  for (const root of SOURCE_ROOTS) walk(root);
  return files;
}

/** Members of the `AgentErrorCode` union. */
function agentCodes(): Set<string> {
  const match = /export type AgentErrorCode =([^;]+);/.exec(read(TYPES_FILE));
  if (match === null) throw new Error(`AgentErrorCode union not found in ${TYPES_FILE}`);
  return new Set(literals(match[1]!));
}

/** Members of the `ENGINE_ERROR_CODES` tuple. */
function engineCodes(): Set<string> {
  const match = /export const ENGINE_ERROR_CODES = \[([^\]]+)\] as const;/.exec(read(CONTRACT_FILE));
  if (match === null) throw new Error(`ENGINE_ERROR_CODES not found in ${CONTRACT_FILE}`);
  return new Set(literals(match[1]!));
}

/**
 * Codes handed to the runner's error classes: the first argument of
 * `ConfigurationError`, `InfrastructureError`, and `TestError`, the second of
 * `E2EError`, a subclass `super(...)`, and a parameter typed as a union of
 * codes (`code: 'LAUNCH_TIMEOUT' | 'CLEANUP_TIMEOUT'`).
 */
function runnerCodes(): Map<string, string[]> {
  const patterns = [
    /new (?:ConfigurationError|InfrastructureError|TestError)\(\s*'([A-Z_]+)'/g,
    /new E2EError\(\s*'[a-z]+',\s*'([A-Z_]+)'/g,
    /\bsuper\(\s*'([A-Z_]+)'/g,
    /\bcode:\s*('[A-Z_]+'(?:\s*\|\s*'[A-Z_]+')+)/g,
  ];
  const found = new Map<string, string[]>();
  for (const file of sourceFiles()) {
    const text = read(file);
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        for (const code of literals(match[0])) {
          const sites = found.get(code) ?? [];
          if (!sites.includes(file)) sites.push(file);
          found.set(code, sites);
        }
      }
    }
  }
  return found;
}

/** Backticked codes on a docs page: `` `SOME_CODE` ``. */
function documentedCodes(page: string): Set<string> {
  const text = read(page);
  return new Set(
    [...text.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)]
      .map((match) => match[1]!)
      .filter((code) => !code.startsWith('E2E_')),
  );
}

function main(): number {
  const agent = agentCodes();
  const engine = engineCodes();
  const runner = runnerCodes();
  const errorsPage = documentedCodes(ERRORS_PAGE);
  const enginePage = documentedCodes(ENGINE_PAGE);

  const problems: string[] = [];

  for (const code of [...agent].toSorted()) {
    if (!errorsPage.has(code)) problems.push(`${ERRORS_PAGE}: AgentErrorCode ${code} is not documented`);
  }
  for (const [code, sites] of [...runner].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!errorsPage.has(code)) {
      problems.push(`${ERRORS_PAGE}: runner code ${code} is not documented (raised in ${sites.join(', ')})`);
    }
  }
  for (const code of [...engine].toSorted()) {
    if (!enginePage.has(code)) problems.push(`${ENGINE_PAGE}: engine code ${code} is not documented`);
  }

  const known = new Set([...agent, ...engine, ...runner.keys()]);
  for (const code of [...errorsPage].toSorted()) {
    if (!known.has(code)) problems.push(`${ERRORS_PAGE}: ${code} is documented but no source raises it`);
  }

  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    return 1;
  }
  process.stdout.write(
    `error codes: ${known.size} in source (${agent.size} agent, ${runner.size} runner, ${engine.size} engine), all documented in ${ERRORS_PAGE} and ${ENGINE_PAGE}\n`,
  );
  return 0;
}

process.exitCode = main();
