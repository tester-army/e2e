/**
 * The runtimes e2e runs on: Node.js, as a set of release ranges, and Bun
 * from a floor. The CLI checks before it loads anything else: package
 * managers only warn about `engines`, so an unsupported runtime would
 * otherwise surface as an unrelated TypeError deep inside a run.
 */

type Version = readonly [major: number, minor: number, patch: number];

/**
 * Releases from `since` on: within one release line when `line` is set,
 * else that release and every later line.
 */
type ReleaseRange = { readonly line: number; readonly since: Version } | { readonly since: Version };

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
 * unsupported`.
 */
const BUN_FLOOR: Version = [1, 4, 3];

/** The Bun releases e2e runs on. */
export const SUPPORTED_BUN_RANGE = `>=${BUN_FLOOR.join('.')}`;

/** Whether this process runs on Bun, which reports a Node.js version it emulates beside its own. */
export const onBun: boolean = process.versions['bun'] !== undefined;

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

/** Explains a Bun or Node.js e2e cannot run on, or undefined for one it can. */
export function unsupportedRuntimeMessage(versions: Pick<NodeJS.ProcessVersions, 'node'> & { readonly bun?: string | undefined } = process.versions): string | undefined {
  return versions.bun === undefined ? unsupportedNodeMessage(versions.node) : unsupportedBunMessage(versions.bun);
}
