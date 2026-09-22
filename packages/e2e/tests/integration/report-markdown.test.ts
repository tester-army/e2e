/** The markdown reporter through the built runner: `summary.md` beside the report, with app text kept from GitHub's autolinks. */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineEngine } from '../../src/engine/index.ts';
import { runProject } from '../helpers/run-project.ts';
import { snapshot } from '../helpers/snapshot.ts';

const HOSTILE_TITLE = 'ping @octocat see https://evil.example';

/** The page with its code spans removed: what GitHub's mention, issue, and URL filters get to read. */
function outsideCodeSpans(markdown: string): string {
  return markdown.replace(/(`+)[^`]*\1/g, '');
}

describe('markdown reporter', () => {
  it('writes summary.md with a mention and a URL from a test title as code, and nothing outside a code span GitHub would link', async () => {
    const { outcome, project } = await runProject(
      { 'tests/hostile.e2e.ts': `import { test } from 'e2e';
        test(${JSON.stringify(HOSTILE_TITLE)}, async () => { throw new Error('boom'); });` },
      {
        appUrl: 'http://127.0.0.1:4599',
        config: {
          targets: [{ name: 'fake', platform: 'custom', engine: defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]) }) }],
          reporters: ['markdown'],
        },
      },
    );
    try {
      expect(outcome.exitCode).toBe(1);
      const summary = readFileSync(path.join(project.dir, '.e2e', 'summary.md'), 'utf8');
      expect(summary).toContain('ping `@octocat` see `https://evil.example`');
      expect(outsideCodeSpans(summary)).not.toContain('@octocat');
      expect(outsideCodeSpans(summary)).not.toMatch(/https:\/\/evil/);
      const failuresDir = path.join(project.dir, '.e2e', 'failures');
      const pages = readdirSync(failuresDir).map((file) => readFileSync(path.join(failuresDir, file), 'utf8'));
      expect(pages).toHaveLength(1);
      expect(pages[0]).toContain('# ✗ ping `@octocat` see `https://evil.example`');
      expect(outsideCodeSpans(pages[0]!)).not.toContain('@octocat');
    } finally {
      project.cleanup();
    }
  });
});
