import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { exampleFiles, unmappedExamples } from './docs-examples.ts';
import { REPO_ROOT } from './public-packages.ts';

describe('exampleFiles', () => {
  it('reads every example from the filesystem, project-relative and sorted', () => {
    const files = exampleFiles();
    assert.ok(files.length > 0, 'expected at least one example under docs/examples');
    for (const file of files) {
      assert.ok(file.startsWith('docs/examples/'), `not an example path: ${file}`);
      assert.ok(file.endsWith('.ts'), `not a .ts file: ${file}`);
      assert.ok(existsSync(join(REPO_ROOT, file)), `example does not exist: ${file}`);
    }
    assert.deepEqual(files, [...files].toSorted());
  });

  it('names the example files the docs and skill show, so the check has files to cover', () => {
    const files = exampleFiles();
    // Regression: these are the files a page shows; the map in
    // check-docs-examples.ts must cover them.
    assert.ok(files.includes('docs/examples/web/browser-provider.ts'), files.join(', '));
    assert.ok(files.includes('docs/examples/skill/e2e.setup.config.ts'), files.join(', '));
  });
});

describe('unmappedExamples', () => {
  it('reports every example a page map does not carry', () => {
    // A map that covers nothing: every example is unmapped.
    assert.deepEqual(unmappedExamples([]), exampleFiles());
  });

  it('is empty when the map covers every example', () => {
    assert.deepEqual(unmappedExamples(exampleFiles()), []);
  });

  it('reports a new example the map was not updated for', () => {
    // The failure the hand-kept map let slip: an example added without a page.
    const map = exampleFiles().filter((file) => file !== 'docs/examples/web/browser-provider.ts');
    assert.deepEqual(unmappedExamples(map), ['docs/examples/web/browser-provider.ts']);
  });
});
