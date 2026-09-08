/**
 * The Node.js floor, checked before the CLI loads anything else. Package
 * managers only warn about `engines`, so an unsupported runtime would
 * otherwise surface as an unrelated TypeError deep inside a run.
 */

/** Mirrors `engines.node` in package.json; a unit test keeps the two in step. */
export const MINIMUM_NODE_VERSION = '22.12.0';

function parse(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

/** Explains an unsupported runtime, or undefined when `current` meets the floor. */
export function unsupportedNodeMessage(
  current: string,
  minimum: string = MINIMUM_NODE_VERSION,
): string | undefined {
  const have = parse(current);
  const need = parse(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (have[i]! > need[i]!) return undefined;
    if (have[i]! < need[i]!) {
      return `e2e requires Node.js ${minimum} or newer; this is Node.js ${current.replace(/^v/, '')}. Upgrade Node.js, or switch versions with your version manager (nvm use 22, fnm use 22, volta pin node@22).`;
    }
  }
  return undefined;
}
