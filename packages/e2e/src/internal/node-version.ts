/**
 * The Node.js releases e2e runs on, and the module-hook fixes it depends on,
 * as sets of release ranges. The CLI checks the floor before it loads
 * anything else: package managers only warn about `engines`, so an
 * unsupported runtime would otherwise surface as an unrelated TypeError deep
 * inside a run.
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

/**
 * Where the `require` Node.js hands a CommonJS module an ES module imported
 * runs resolve hooks (nodejs/node#62920, in 24.18.0 and 26.2.0). Before it,
 * the loader gives compiled CommonJS a `require` that does.
 */
const IMPORTED_COMMONJS_REQUIRE_RUNS_HOOKS: readonly ReleaseRange[] = [
  { line: 24, since: [24, 18, 0] },
  { since: [26, 2, 0] },
];

/** `engines.node` in package.json; a unit test keeps the two in step. */
export const SUPPORTED_NODE_RANGE = SUPPORTED.map((range) => `${'line' in range ? '^' : '>='}${range.since.join('.')}`).join(' || ');

/** Explains an unsupported runtime, or undefined when `current` is in `SUPPORTED_NODE_RANGE`. */
export function unsupportedNodeMessage(current: string): string | undefined {
  if (within(current, SUPPORTED)) return undefined;
  const required = SUPPORTED.map((range) => ('line' in range ? `${range.since.join('.')} or newer on Node.js ${range.line}` : `${range.since.join('.')} or newer`)).join(', or ');
  return `e2e requires Node.js ${required}; this is Node.js ${current.replace(/^v/, '')}. Upgrade Node.js, or switch versions with your version manager (nvm install 24, fnm install 24, volta install node@24).`;
}

/** Whether the `require` of a CommonJS module an ES module imported runs resolve hooks on Node.js `version`. */
export function importedCommonJsRequireRunsHooks(version: string = process.versions.node): boolean {
  return within(version, IMPORTED_COMMONJS_REQUIRE_RUNS_HOOKS);
}
