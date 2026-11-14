import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { REPO_ROOT } from './public-packages.ts';
import { pages } from './docs-pages.ts';

const fixture = mkdtempSync(join(tmpdir(), 'e2e-docs-pages-'));
after(() => rmSync(fixture, { recursive: true, force: true }));

writeFileSync(join(fixture, 'index.mdx'), '# Home\n');
writeFileSync(join(fixture, 'README.md'), 'not a page\n');
mkdirSync(join(fixture, 'reference'));
writeFileSync(join(fixture, 'reference', 'errors.mdx'), '# Errors\n');
mkdirSync(join(fixture, 'reference', 'node_modules'));
writeFileSync(join(fixture, 'reference', 'node_modules', 'hidden.mdx'), '# Skipped\n');

describe('pages', () => {
  it('collects every .mdx under dir, nested folders included, skipping node_modules and other files', () => {
    const found = pages(fixture).toSorted();
    assert.deepEqual(found, [join(fixture, 'index.mdx'), join(fixture, 'reference', 'errors.mdx')]);
  });

  it('answers an empty list for a directory with no pages', () => {
    mkdirSync(join(fixture, 'nowhere'));
    assert.deepEqual(pages(join(fixture, 'nowhere')), []);
  });

  it('finds the real docs tree, so a check over it cannot pass by reading nothing', () => {
    const found = pages(join(REPO_ROOT, 'docs'));
    assert.ok(found.length > 50, `expected the docs tree to hold pages, found ${found.length}`);
    assert.ok(found.some((path) => path.endsWith(join('docs', 'index.mdx'))));
  });
});
