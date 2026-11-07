/**
 * The runtimes e2e runs on: Node.js, as a set of release ranges, and Bun
 * from a floor. The CLI checks before it loads anything else: package
 * managers only warn about `engines`, so an unsupported runtime would
 * otherwise surface as an unrelated TypeError deep inside a run.
 */

import nodeModule from 'node:module';

type Version = readonly [major: number, minor: number, patch: number];

/**
 * Releases from `since` on: within one release line when `line` is set,
 * else that release and every later line.
 */
type ReleaseRange = { readonly line: number; readonly since: Version } | { readonly since: Version };

/** What a runtime reports in `process.versions`: Bun and Deno name themselves beside the Node.js they emulate. */
type RuntimeVersions = Pick<NodeJS.ProcessVersions, 'node'> & { readonly bun?: string | undefined; readonly deno?: string | undefined };

function parse(version: string): Version {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

function atLeast(have: Version, need: Version): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i]! > need[i]!;
  }
  return true;
}

function within(version: string, ranges: readonly ReleaseRange[]): boolean {
  const have = parse(version);
  return ranges.some((range) => ('line' in range ? have[0] === range.line : true) && atLeast(have, range.since));
}

/**
 * Where e2e's TypeScript loader works. It runs on `module.registerHooks`, and
 * before these releases a CommonJS file an ES module imported cannot
 * `require()` an ES module the hooks load, such as a project's TypeScript:
 * Node.js throws reading its own cache (nodejs/node#59679, in 22.22.3 and
 * 24.8.0). Node.js 23 has no such release.
 */
const SUPPORTED: readonly ReleaseRange[] = [
  { line: 22, since: [22, 22, 3] },
  { since: [24, 8, 0] },
];

/** `engines.node` in package.json; a unit test keeps the two in step. */
export const SUPPORTED_NODE_RANGE = SUPPORTED.map((range) => `${'line' in range ? '^' : '>='}${range.since.join('.')}`).join(' || ');

/**
 * The first Bun e2e runs on. Bun compiles TypeScript itself, so a project's
 * files load through Bun's own module loader there (`config/bun-loader.ts`).
 * Before 1.4.3, a CommonJS file that requires an ES module of a graph still
 * waiting on top-level await throws `require() async module ... is
 * unsupported`, depending on load timing.
 */
const BUN_FLOOR: Version = [1, 4, 3];

/** The Bun releases e2e runs on. */
export const SUPPORTED_BUN_RANGE = `>=${BUN_FLOOR.join('.')}`;

/** Whether this process runs on Bun, whose own module loader compiles TypeScript. */
export const onBun: boolean = process.versions['bun'] !== undefined;

/** The runtime `versions` describes, this process's by default, and its own version. */
export function runtimeOf(versions: RuntimeVersions = process.versions): { readonly name: 'node' | 'bun' | 'deno'; readonly version: string } {
  if (versions.bun !== undefined) return { name: 'bun', version: versions.bun };
  if (versions.deno !== undefined) return { name: 'deno', version: versions.deno };
  return { name: 'node', version: versions.node };
}

/** Explains a Node.js outside `SUPPORTED_NODE_RANGE`, or undefined for one inside it. */
function unsupportedNodeMessage(current: string): string | undefined {
  if (within(current, SUPPORTED)) return undefined;
  const required = SUPPORTED.map((range) => ('line' in range ? `${range.since.join('.')} or newer on Node.js ${range.line}` : `${range.since.join('.')} or newer`)).join(', or ');
  return `e2e requires Node.js ${required}; this is Node.js ${current.replace(/^v/, '')}. Upgrade Node.js, or switch versions with your version manager (nvm install 24, fnm install 24, volta install node@24).`;
}

/** Explains a Bun older than `SUPPORTED_BUN_RANGE`, or undefined for one e2e runs on. */
function unsupportedBunMessage(current: string): string | undefined {
  if (atLeast(parse(current), BUN_FLOOR)) return undefined;
  return `e2e requires Bun ${BUN_FLOOR.join('.')} or newer; this is Bun ${current}. Upgrade Bun (bun upgrade), or run the CLI with Node.js (npx e2e).`;
}

/**
 * Explains a runtime e2e cannot run on, or undefined for one it can: a Bun
 * older than `SUPPORTED_BUN_RANGE`, Deno, a Node.js outside
 * `SUPPORTED_NODE_RANGE`, or a runtime that reports a supported Node.js
 * without the `module.registerHooks` e2e's TypeScript loader runs on there.
 */
export function unsupportedRuntimeMessage(
  versions: RuntimeVersions = process.versions,
  hasRegisterHooks: boolean = typeof nodeModule.registerHooks === 'function',
): string | undefined {
  // Deno implements module.registerHooks, but not the require() of a native addon from inside a hook that oxc needs.
  if (versions.deno !== undefined) return `e2e runs on Node.js and Bun, not Deno ${versions.deno}: run the CLI with Node.js (npx e2e) or Bun (bunx --bun e2e).`;
  // Bun loads TypeScript itself, so the Node.js version it reports does not matter.
  if (versions.bun !== undefined) return unsupportedBunMessage(versions.bun);
  const unsupportedNode = unsupportedNodeMessage(versions.node);
  if (unsupportedNode !== undefined) return unsupportedNode;
  if (!hasRegisterHooks) {
    return `e2e runs on Node.js and Bun: this runtime reports Node.js ${versions.node} but has no module.registerHooks, which e2e's TypeScript loader needs. Run the CLI with Node.js (npx e2e) or Bun (bunx --bun e2e).`;
  }
  return undefined;
}
