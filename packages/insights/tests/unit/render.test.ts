import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.ts';
import { main } from '../../src/cli.ts';
import { renderHtml } from '../../src/render/html.ts';
import { renderMarkdown } from '../../src/render/markdown.ts';
import { renderText } from '../../src/render/text.ts';
import { appendRun } from '../../src/store.ts';
import { history } from './helpers.ts';

function flakyHistory(testId = 'often') {
  return history(
    [...'pppppppppp'].map((_, index) => [
      { testId: 'stable', status: 'passed' as const, cache: ['self-finalized' as const] },
      { testId, status: index % 3 === 1 ? ('failed' as const) : ('passed' as const), cache: ['missed' as const], costUsd: 0.004 },
    ]),
  );
}

/** A history whose flaky test's title is hostile markup. */
function hostile() {
  const runs = flakyHistory();
  for (const run of runs) for (const test of run.tests) if (test.testId === 'often') test.titlePath = ['<script>alert(1)</script> | `x`', 'evil\u001b[2Jtitle'];
  return analyze(runs);
}

describe('renderers', () => {
  it('text names the flaky test, its cache misses, and its cost', () => {
    const text = renderText(analyze(flakyHistory()));
    expect(text).toContain('e2e insights: 10 runs');
    expect(text).toMatch(/flaky\s+suite › often \[web\]\s+30%/);
    expect(text).toContain('Replay cache misses');
    expect(text).toContain('no-entry ×10');
  });

  it('text strips terminal controls from titles and cache reasons', () => {
    const insights = hostile();
    insights.tests[0]!.cache.reasons = { 'no-entry\u001b[2J': 3 };
    expect(renderText(insights)).not.toContain('\u001b');
  });

  it('text cuts a long title without splitting a character', () => {
    const runs = flakyHistory();
    for (const run of runs) for (const test of run.tests) if (test.testId === 'often') test.titlePath = ['😀'.repeat(80)];
    expect(renderText(analyze(runs))).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('markdown escapes markup and keeps table cells on one row', () => {
    const markdown = renderMarkdown(hostile());
    expect(markdown).not.toContain('<script>');
    expect(markdown).toContain('&lt;script&gt;');
    const row = markdown.split('\n').find((line) => line.includes('&lt;script&gt;'))!;
    expect(row.split(/(?<!\\)\|/).length).toBe(9);
  });

  it('html escapes every value and loads nothing', () => {
    const html = renderHtml(hostile());
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/<link|src=|https?:\/\//);
    expect(html).toContain('&lt;script&gt;');
  });

  it('each renderer says when the history is empty', () => {
    const empty = analyze([]);
    expect(renderText(empty)).toContain('No runs');
    expect(renderMarkdown(empty)).toContain('No runs');
    expect(renderHtml(empty)).toContain('No runs');
  });
});

describe('e2e-insights CLI', () => {
  async function run(args: string[], cwd: string) {
    let stdout = '';
    let stderr = '';
    const code = await main(args, { cwd, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
    return { code, stdout, stderr };
  }

  async function withHistory(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'e2e-insights-cli-'));
    for (const entry of flakyHistory()) await appendRun(path.join(root, '.e2e/history/runs.jsonl'), entry, 100);
    return root;
  }

  it('reads the default history and prints text', async () => {
    const { code, stdout } = await run([], await withHistory());
    expect(code).toBe(0);
    expect(stdout).toContain('0 broken · 0 failing · 1 flaky');
  });

  it('exits 1 with --fail-on flaky and 0 with --fail-on broken', async () => {
    const root = await withHistory();
    expect((await run(['--fail-on', 'flaky'], root)).code).toBe(1);
    expect((await run(['--fail-on', 'broken'], root)).code).toBe(0);
  });

  it('writes html to --out', async () => {
    const root = await withHistory();
    const { stdout } = await run(['--format', 'html', '--out', 'report/insights.html'], root);
    expect(stdout).toBe('Wrote report/insights.html\n');
    expect(await readFile(path.join(root, 'report/insights.html'), 'utf8')).toMatch(/^<!doctype html>/);
  });

  it('prints json that parses back', async () => {
    const { stdout } = await run(['--format', 'json', '--min-runs', '2'], await withHistory());
    expect(JSON.parse(stdout)).toMatchObject({ runs: 10, minRuns: 2, counts: { flaky: 1 } });
  });

  it('exits 2, not the --fail-on code, when --out cannot be written', async () => {
    const root = await withHistory();
    const { code, stderr } = await run(['--fail-on', 'broken', '--out', '.e2e/history'], root);
    expect(code).toBe(2);
    expect(stderr).toContain('cannot write .e2e/history');
  });

  it('exits 2 on a usage error', async () => {
    const root = await withHistory();
    expect((await run(['--format', 'pdf'], root)).code).toBe(2);
    expect((await run(['--window', '0'], root)).code).toBe(2);
    expect((await run(['--nope'], root)).code).toBe(2);
  });
});
