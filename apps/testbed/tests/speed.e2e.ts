import { test, expect } from 'e2e';
import type { Locator } from 'e2e';

/**
 * The floor of what a deterministic step costs against a page that has
 * nothing to wait for. A settle wait, a redundant observation, or a retry
 * loop sneaking into the action path shows up here first, long before it
 * shows up as a slow suite.
 */
const TAPS = 40;
const FILLS = 20;
const READS = 20;
/**
 * An action may cost this many times a bare locator read (`count()` on the
 * node it acts on, measured in the same test so a slow machine slows both),
 * and never less than the floor. A tap is a resolve, the actionability
 * checks, the click, and the post-action settle: about ten reads on a
 * laptop (33 ms against 3 to 5 ms), so the ratio is twice that. The floor
 * covers a machine whose reads are so fast the ratio would be tighter than
 * scheduling noise; a settle wait or a redundant observation sneaking into
 * the action path costs more than either bound.
 */
const ACTION_RATIO = 20;
const ACTION_FLOOR_MS = 100;

/** Milliseconds one `count()` on `locator` costs right now, averaged over `READS` reads. */
async function readCost(locator: Locator): Promise<number> {
  const started = Date.now();
  for (let i = 0; i < READS; i += 1) await locator.count();
  return (Date.now() - started) / READS;
}

/** The per-action budget this run allows: the ratio of the measured read cost, never under the floor. */
function budget(readMs: number): number {
  return Math.max(ACTION_FLOOR_MS, ACTION_RATIO * readMs);
}

/** The assertion message, with every number a CI log needs to read the verdict. */
function verdict(action: string, perActionMs: number, readMs: number): string {
  return `${perActionMs.toFixed(1)} ms per ${action} against a ${budget(readMs).toFixed(1)} ms budget (a read costs ${readMs.toFixed(1)} ms)`;
}

test.describe('deterministic speed floor', { tags: ['speed'] }, () => {
  test('forty taps each cost no more than a few locator reads', async ({ app, screen }) => {
    await app.open('/speed');
    const increment = screen.getByRole('button', 'Increment');
    const readMs = await readCost(increment);

    const started = Date.now();
    for (let i = 0; i < TAPS; i += 1) await increment.tap();
    const perTap = (Date.now() - started) / TAPS;

    await expect(screen.getByRole('status', 'Count')).toHaveText(String(TAPS));
    expect(perTap, verdict('tap', perTap, readMs)).toBeLessThanOrEqual(budget(readMs));
  });

  test('twenty fills each cost no more than a few locator reads', async ({ app, screen }) => {
    await app.open('/speed');
    const echo = screen.getByLabel('Echo');
    const readMs = await readCost(echo);

    const started = Date.now();
    for (let i = 0; i < FILLS; i += 1) await echo.fill(`value ${i}`);
    const perFill = (Date.now() - started) / FILLS;

    await expect(screen.getByRole('status', 'Echoed')).toHaveText(`value ${FILLS - 1}`);
    expect(perFill, verdict('fill', perFill, readMs)).toBeLessThanOrEqual(budget(readMs));
  });
});
