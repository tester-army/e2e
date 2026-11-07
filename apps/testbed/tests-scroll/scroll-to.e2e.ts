import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('scroll_to a text on a windowed list', { requires: ['browser'], tags: ['scroll'] }, () => {
  for (const [depth, row] of [['near', 'Row 12'], ['middle', 'Row 60'], ['deep', 'Row 118']] as const) {
    test(`reaches a ${depth} row and taps it`, async ({ app, agent, screen }) => {
      await app.open('/scroll');
      await agent.act(`scroll to ${row} and tap it`);
      await expect(screen.getByRole('status', 'Picked row')).toHaveText(`picked ${row}`);
    });
  }
});
