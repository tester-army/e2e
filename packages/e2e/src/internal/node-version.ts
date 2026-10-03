/**
 * The Node.js floor, checked before the CLI loads anything else. Package
 * managers only warn about `engines`, so an unsupported runtime would
 * otherwise surface as an unrelated TypeError deep inside a run.
 *
 * e2e's TypeScript loader runs on `module.registerHooks`. Before 22.22.3 on
 * Node.js 22 and 24.8.0 on 24, a CommonJS file a test imports cannot
 * `require()` an ES module those hooks load, such as a project's TypeScript:
 * Node.js throws reading its own cache (nodejs/node#59679 fixed it). So each
 * release line has its own floor, and Node.js 23 has none.
 */

type Version = readonly [number, number, number];

/** The first release of each supported line; any later major counts from the last one. */
const FLOORS: readonly Version[] = [
  [22, 22, 3],
  [24, 8, 0],
];

/** `engines.node` in package.json; a unit test keeps the two in step. */
export const SUPPORTED_NODE_RANGE = FLOORS.map(
  ([major, minor, patch], index) => `${index === FLOORS.length - 1 ? '>=' : '^'}${major}.${minor}.${patch}`,
).join(' || ');

function parse(version: string): Version {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

function atLeast(have: Version, need: Version): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  }
  return true;
}

/** Explains an unsupported runtime, or undefined when `current` is in `SUPPORTED_NODE_RANGE`. */
export function unsupportedNodeMessage(current: string): string | undefined {
  const have = parse(current);
  const supported = FLOORS.some((floor, index) => atLeast(have, floor) && (index === FLOORS.length - 1 || have[0] === floor[0]));
  if (supported) return undefined;
  const lines = FLOORS.slice(0, -1).map((floor) => `${floor.join('.')} or newer on Node.js ${floor[0]}`);
  const required = `${lines.join(', ')}, or ${FLOORS.at(-1)!.join('.')} or newer`;
  return `e2e requires Node.js ${required}; this is Node.js ${current.replace(/^v/, '')}. Upgrade Node.js, or switch versions with your version manager (nvm install 24, fnm install 24, volta install node@24).`;
}
