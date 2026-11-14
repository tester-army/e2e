import { createRequire } from 'node:module';

/**
 * Reads a package.json version through require resolution relative to the
 * caller's module URL, falling back when the package cannot be resolved.
 */
export function packageVersion(fromUrl: string, specifier: string, fallback: string): string {
  try {
    return (createRequire(fromUrl)(specifier) as { version: string }).version;
  } catch {
    return fallback;
  }
}

/** Reads a JSON file through require resolution relative to the caller's module URL, or undefined when absent. */
export function readJson(fromUrl: string, specifier: string): unknown {
  try {
    return createRequire(fromUrl)(specifier) as unknown;
  } catch {
    return undefined;
  }
}
