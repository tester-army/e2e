/** The e2e release the npm registry's `latest` dist-tag points at, and how versions order. */

/** The `latest` dist-tag's manifest; small, and public. */
const LATEST_URL = 'https://registry.npmjs.org/e2e/latest';
const RELEASE = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Whether `version` is a semver release or prerelease. */
export function isRelease(version: string): boolean {
  return RELEASE.test(version);
}

/**
 * The version `latest` points at, or undefined when the registry did not
 * answer within `timeoutMs` or answered with something else.
 */
export async function latestRelease(fetchImpl: typeof fetch, timeoutMs: number): Promise<string | undefined> {
  try {
    const response = await fetchImpl(LATEST_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const version = typeof body === 'object' && body !== null && 'version' in body ? body.version : undefined;
    return typeof version === 'string' && isRelease(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `version` comes before `latest`; a prerelease comes before its release. Unparsable versions never do. */
export function olderThan(version: string, latest: string): boolean {
  const a = RELEASE.exec(version);
  const b = RELEASE.exec(latest);
  if (a === null || b === null) return false;
  for (const index of [1, 2, 3]) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference < 0;
  }
  return a[4] !== undefined && b[4] === undefined;
}
