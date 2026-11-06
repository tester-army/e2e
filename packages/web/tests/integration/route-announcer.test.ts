/** Next.js App Router's route announcer is never observed; an app's own alert still is. */

import { expect, it } from 'vitest';
import { startWebSession } from '../helpers/web-session.ts';

const PAGE = `<!doctype html><html lang="en"><head><title>Acme Notes</title></head><body>
  <div role="alert" data-testid="app-alert">Acme Notes</div>
  <next-route-announcer></next-route-announcer>
  <script>
    document.querySelector('next-route-announcer').attachShadow({ mode: 'open' }).innerHTML =
      '<div id="__next-route-announcer__" role="alert" aria-live="assertive" style="position:absolute;width:1px;height:1px;overflow:hidden"></div>';
  </script>
</body></html>`;

it('omits the announcer empty or populated and keeps the app alert', async () => {
  const page = await startWebSession();
  try {
    await page.setContent(PAGE);
    const announce = (text: string) => page.browser.evaluate((value: string) => {
      document.querySelector('next-route-announcer')!.shadowRoot!.querySelector('#__next-route-announcer__')!.textContent = value;
      return null;
    }, text);
    for (const text of ['', 'Acme Notes']) {
      await announce(text);
      expect((await page.nodes()).filter((node) => node.role === 'alert')).toMatchObject([{ name: 'Acme Notes', testId: 'app-alert' }]);
    }
    expect(await page.browser.evaluate(() =>
      (document.querySelector('next-route-announcer')!.shadowRoot!.querySelector('#__next-route-announcer__') as HTMLElement).innerText)).toBe('Acme Notes');
  } finally {
    await page.close();
  }
});
