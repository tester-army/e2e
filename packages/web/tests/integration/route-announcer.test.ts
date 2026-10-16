/** Next.js App Router's route announcer is never observed; an app's own alert still is. */

import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { captureTagged } from '../crosscheck/crosscheck.ts';

const PAGE = `<!doctype html><html lang="en"><head><title>Acme Notes</title></head><body>
  <div role="alert" data-testid="app-alert">Acme Notes</div>
  <next-route-announcer></next-route-announcer>
  <script>
    document.querySelector('next-route-announcer').attachShadow({ mode: 'open' }).innerHTML =
      '<div id="__next-route-announcer__" role="alert" aria-live="assertive" style="position:absolute;width:1px;height:1px;overflow:hidden"></div>';
  </script>
</body></html>`;

it('omits the announcer empty or populated and keeps the app alert', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    const announcer = page.locator('next-route-announcer').locator('#__next-route-announcer__');
    for (const text of ['', 'Acme Notes']) {
      await announcer.evaluate((el, value) => {
        el.textContent = value;
      }, text);
      const { nodes, elements } = await captureTagged(page);
      try {
        expect(nodes.filter((node) => node.role === 'alert')).toMatchObject([{ name: 'Acme Notes', testId: 'app-alert' }]);
      } finally {
        await Promise.all([...elements.values()].map((element) => element.dispose()));
      }
    }
    expect(await announcer.innerText()).toBe('Acme Notes');
  } finally {
    await browser.close();
  }
});
