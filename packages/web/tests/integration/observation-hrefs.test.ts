import { afterAll, beforeAll, expect, it } from 'vitest';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

let page: WebSession;

beforeAll(async () => { page = await startWebSession(); });
afterAll(async () => { await page.close(); });

it('reports link targets as origin and whole path, marking a dropped query, fragment, or opaque payload', async () => {
  const project = '/dashboard/e2e-dc3cf837/projects/404b2532-9fab-44dc-b3d0-f0a1b2c3d4e5/runs/7d0c3b52-2f7e-4c55-9a51-6f1e0c9b8a77';
  await page.setContent(`<base href="http://app.test/dashboard/">
    <a href="${project}">Project</a>
    <a href="https://user:pass@docs.example.test/guides/setup">Docs</a>
    <a href="search?q=token&amp;page=2">Search</a>
    <a href="settings#billing">Billing</a>
    <a href="mailto:team@example.test?subject=hi">Mail</a>
    <a href="tel:+48123456789">Call</a>
    <a href="data:text/csv,${'id,name%0A1,Ada%0A'.repeat(200)}">Export</a>
    <a href="javascript:void(document.body.dataset.clicked = 'yes')">Script</a>
    <a href="blob:http://app.test/0b7c4c1e-8d9a-4f2e-9c1b-2a3d4e5f6a7b">Download</a>
    <a href="blob:https://user:pass@files.example.test/0b7c4c1e?token=abc">Signed</a>
    <a href="blob:null/0b7c4c1e">Opaque</a>`);
  const { root } = await page.observe();

  const hrefs = Object.fromEntries((root.children ?? []).map((node) => [node.name, node.attributes?.['href']]));
  expect(hrefs).toEqual({
    Project: `http://app.test${project}`,
    Docs: 'https://docs.example.test/guides/setup',
    Search: 'http://app.test/dashboard/search?…',
    Billing: 'http://app.test/dashboard/settings#…',
    Mail: 'mailto:team@example.test?…',
    Call: 'tel:+48123456789',
    Export: 'data:…',
    Script: 'javascript:…',
    Download: 'blob:http://app.test/0b7c4c1e-8d9a-4f2e-9c1b-2a3d4e5f6a7b',
    Signed: 'blob:https://files.example.test/0b7c4c1e?…',
    Opaque: 'blob:…',
  });
});
