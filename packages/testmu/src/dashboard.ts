/**
 * How `testmu()` and `testmuBrowsers()` group and name their sessions on the
 * TestMu AI dashboard, so a run's device and browser sessions read alike.
 */

/** The dashboard project sessions are grouped under when none is set. */
export const DEFAULT_PROJECT = 'e2e';

/** A worker slot's session name when none is set: `e2e-<run id>-<target>-<slot>`, slots counting from 1. */
export function defaultSessionName({ runId, targetName, slot }: { readonly runId: string; readonly targetName: string; readonly slot: number }): string {
  return `e2e-${runId}-${targetName}-${slot + 1}`;
}
