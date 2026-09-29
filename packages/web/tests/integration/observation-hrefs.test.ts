import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { captureDocument } from '../../src/observation.ts';

let browser: Browser;

beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

it('reports link targets as origin and whole path, marking a dropped query or fragment', async () => {
  const page = await browser.newPage();
  try {
    const project = '/dashboard/e2e-dc3cf837/projects/404b2532-9fab-44dc-b3d0-f0a1b2c3d4e5/runs/7d0c3b52-2f7e-4c55-9a51-6f1e0c9b8a77';
    await page.setContent(`<base href="http://app.test/dashboard/">
      <a href="${project}">Project</a>
      <a href="https://user:pass@docs.example.test/guides/setup">Docs</a>
      <a href="search?q=token&amp;page=2">Search</a>
      <a href="settings#billing">Billing</a>
      <a href="mailto:team@example.test?subject=hi">Mail</a>`);
    const captured = await captureDocument({
      testIdAttribute: 'data-testid', site: undefined, reserveIds: () => 1, commit: () => {},
    }, page, { framePath: [], budget: 100, deadline: Date.now() + 10_000, signal: new AbortController().signal });

    const hrefs = Object.fromEntries((captured.tree.children ?? []).map((node) => [node.name, node.attributes?.['href']]));
    expect(hrefs).toEqual({
      Project: `http://app.test${project}`,
      Docs: 'https://docs.example.test/guides/setup',
      Search: 'http://app.test/dashboard/search?…',
      Billing: 'http://app.test/dashboard/settings#…',
      Mail: 'mailto:team@example.test?…',
    });
  } finally {
    await page.close();
  }
});
