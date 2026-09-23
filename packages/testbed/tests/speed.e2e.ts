import { test, expect } from 'e2e';

/**
 * The floor of what a deterministic step costs against a page that has
 * nothing to wait for. A settle wait, a redundant observation, or a retry
 * loop sneaking into the action path shows up here first, long before it
 * shows up as a slow suite.
 */
const TAPS = 40;
const FILLS = 20;
/** Milliseconds per action, generous enough for a loaded CI runner. */
const BUDGET_PER_ACTION_MS = 250;

test.describe('deterministic speed floor', { tags: ['speed'] }, () => {
  test('forty taps land well under the per-action budget', async ({ app, screen }) => {
    await app.open('/speed');
    const increment = screen.getByRole('button', { name: 'Increment' });

    const started = Date.now();
    for (let i = 0; i < TAPS; i += 1) await increment.tap();
    const elapsed = Date.now() - started;

    await expect(screen.getByRole('status', { name: 'Count' })).toHaveText(String(TAPS));
    expect(elapsed / TAPS, `${TAPS} taps took ${elapsed} ms`).toBeLessThan(BUDGET_PER_ACTION_MS);
  });

  test('fill and a matching assertion stay under the budget per pair', async ({ app, screen }) => {
    await app.open('/speed');
    const echo = screen.getByLabel('Echo');
    const echoed = screen.getByRole('status', { name: 'Echoed' });

    const started = Date.now();
    for (let i = 0; i < FILLS; i += 1) {
      await echo.fill(`value ${i}`);
      await expect(echoed).toHaveText(`value ${i}`);
    }
    const elapsed = Date.now() - started;

    expect(elapsed / FILLS, `${FILLS} fill+expect pairs took ${elapsed} ms`).toBeLessThan(
      BUDGET_PER_ACTION_MS * 2,
    );
  });
});
