import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FinishedRun, Report } from 'e2e';
import { afterEach, describe, expect, it } from 'vitest';
import { PAYLOAD_PLACEHOLDER, embedPayload, type ReportPayload } from '../../src/payload.ts';
import { writeReport } from '../../src/reporter.ts';

const REPORT = JSON.parse(
  await readFile(new URL('../../../e2e/schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8'),
) as Report;

const TEMPLATE = `<!doctype html><script id="e2e-report" type="application/json">${PAYLOAD_PLACEHOLDER}</script>`;

/** The payload the page would parse back out of a filled template. */
function parsePayload(page: string): ReportPayload {
  const match = /<script id="e2e-report" type="application\/json">(.*?)<\/script>/su.exec(page);
  if (match?.[1] === undefined) throw new Error('no payload script in the page');
  return JSON.parse(match[1]) as ReportPayload;
}

describe('embedPayload', () => {
  it('keeps a value that closes the script element inside the JSON', () => {
    const title = '</script><script>alert(1)</script><!--';
    const report = { ...REPORT, run: { ...REPORT.run, project: { ...REPORT.run.project, id: title } } };
    const page = embedPayload(TEMPLATE, { report, media: { mode: 'none' }, resultsDir: '.e2e/results', traces: {}, sources: {} });

    expect(page.match(/<\/script>/gu)).toHaveLength(1);
    expect(parsePayload(page).report.run.project.id).toBe(title);
  });

  it('refuses a template without exactly one placeholder', () => {
    expect(() => embedPayload('<html></html>', { report: REPORT, media: { mode: 'none' }, resultsDir: '.e2e/results', traces: {}, sources: {} })).toThrow(/exactly once/u);
    expect(() => embedPayload(PAYLOAD_PLACEHOLDER.repeat(2), { report: REPORT, media: { mode: 'none' }, resultsDir: '.e2e/results', traces: {}, sources: {} })).toThrow(/exactly once/u);
  });
});

describe('writeReport', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  function finishedRun(projectRoot: string): FinishedRun {
    return {
      report: REPORT,
      status: 'passed',
      exitCode: 0,
      projectRoot,
      reportPath: path.join(projectRoot, '.e2e', 'report.json'),
      artifactsRoot: path.join(projectRoot, '.e2e', 'results'),
      aiTracePath: undefined,
      traces: new Map(),
      redact: (text) => text,
    };
  }

  it('writes the page beside the results directory by default', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'e2e-html-'));
    const trace = path.join('.e2e', 'results', 'checkout-1a2b', 'trace.md');
    const rows = await writeReport({ ...finishedRun(root), traces: new Map([['result-1', trace]]) }, {}, TEMPLATE);
    const page = await readFile(path.join(root, '.e2e', 'report.html'), 'utf8');

    expect(parsePayload(page)).toEqual({
      report: REPORT,
      media: { mode: 'link', base: 'results' },
      resultsDir: '.e2e/results',
      traces: { 'result-1': '.e2e/results/checkout-1a2b/trace.md' },
      sources: {},
    });
    expect(rows).toEqual([{ label: 'HTML report', text: expect.stringMatching(/report\.html$/u) }]);
  });

  it('keeps the test file lines around each source location, redacted, and no file outside the project', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'e2e-html-'));
    const project = path.join(root, 'project');
    await mkdir(path.join(project, 'tests'), { recursive: true });
    await writeFile(path.join(project, 'tests', 'example.e2e.ts'), Array.from({ length: 20 }, (_, index) => `line ${index + 1}${index === 9 ? " fill('hunter2-staging')" : ''}`).join('\n'));
    await writeFile(path.join(root, 'secret.ts'), 'secret');
    const outside = structuredClone(REPORT);
    outside.run.results[2]!.source.file = '../secret.ts';
    const redact = (text: string) => text.replaceAll('hunter2-staging', '[secret]');
    await writeReport({ ...finishedRun(project), report: outside, redact }, {}, TEMPLATE);
    const { sources } = parsePayload(await readFile(path.join(project, '.e2e', 'report.html'), 'utf8'));

    // The fixture points at lines 1, 3, 9, and 16; each frame keeps two lines either side.
    expect(Object.keys(sources)).toEqual(['tests/example.e2e.ts']);
    expect(Object.keys(sources['tests/example.e2e.ts']!).map(Number).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18]);
    expect(sources['tests/example.e2e.ts']?.['9']).toBe('line 9');
    expect(sources['tests/example.e2e.ts']?.['10']).toBe("line 10 fill('[secret]')");
  });

  it('links artifacts from wherever outputFile puts the page', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'e2e-html-'));
    await writeReport(finishedRun(root), { outputFile: 'reports/e2e/index.html' }, TEMPLATE);
    const page = await readFile(path.join(root, 'reports', 'e2e', 'index.html'), 'utf8');

    expect(parsePayload(page).media).toEqual({ mode: 'link', base: '../../.e2e/results' });
  });

  /** The fixture report with these artifacts on its first attempt. */
  function withArtifacts(artifacts: Report['run']['results'][number]['attempts'][number]['artifacts']): Report {
    const [first, ...rest] = REPORT.run.results;
    if (first === undefined) throw new Error('the fixture has no results');
    const [attempt, ...later] = first.attempts;
    if (attempt === undefined) throw new Error('the fixture result has no attempts');
    return { ...REPORT, run: { ...REPORT.run, serialGroups: [], results: [{ ...first, attempts: [{ ...attempt, artifacts }, ...later] }, ...rest] } };
  }

  const artifact = { kind: 'download', redaction: 'complete', producer: { kind: 'attempt' } } as const;

  it('embeds the files the report names under the results directory, except downloads not scanned for secrets', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'e2e-html-'));
    const results = path.join(root, '.e2e', 'results');
    await mkdir(path.join(results, 'a'), { recursive: true });
    await writeFile(path.join(results, 'a', 'shot.png'), 'png bytes');
    await writeFile(path.join(results, 'a', 'page.html'), '<script>alert(1)</script>');
    await writeFile(path.join(results, 'a', 'export.pdf'), 'unscanned bytes');
    await writeFile(path.join(root, 'secret.txt'), 'outside');
    const report = withArtifacts([
      { ...artifact, id: 'shot', kind: 'screenshot', mediaType: 'image/png', path: 'a/shot.png' },
      { ...artifact, id: 'page', mediaType: 'text/html', path: 'a/page.html' },
      { ...artifact, id: 'gone', mediaType: 'video/webm', path: 'a/video.webm' },
      { ...artifact, id: 'escape', mediaType: 'text/plain', path: '../../secret.txt' },
      { ...artifact, id: 'unscanned', mediaType: 'application/pdf', path: 'a/export.pdf', redaction: 'incomplete' },
    ]);

    const rows = await writeReport({ ...finishedRun(root), report }, { media: 'embed' }, TEMPLATE);
    const { media } = parsePayload(await readFile(path.join(root, '.e2e', 'report.html'), 'utf8'));

    expect(media).toEqual({
      mode: 'embed',
      files: {
        'a/shot.png': `data:image/png;base64,${Buffer.from('png bytes').toString('base64')}`,
        'a/page.html': `data:application/octet-stream;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`,
      },
    });
    expect(rows[0]?.text).toMatch(/report\.html \(one file, \d+ KB\)$/u);
  });

  it('leaves media out for text only', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'e2e-html-'));
    const rows = await writeReport(finishedRun(root), { media: 'none' }, TEMPLATE);

    expect(parsePayload(await readFile(path.join(root, '.e2e', 'report.html'), 'utf8')).media).toEqual({ mode: 'none' });
    expect(rows[0]?.text).toMatch(/\(text only\)$/u);
  });
});
