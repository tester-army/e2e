import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { controlTest, fixtures, task, treatment } from './corpus.ts';
import { encode, hash, json, repo, tree } from './files.ts';

/** Invokes the user-facing experiment CLI. A nonzero status is the failure signal. */
function cli(args: string[], expected = 0) {
  const result = spawnSync(process.execPath, [join(repo, 'apps/test-authoring/cli.ts'), ...args], { encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  return result;
}

test('offline authoring experiment through the real CLI and browser', { timeout: 300000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'test-authoring-'));
  const directory = join(root, 'experiment');
  const declared = { purpose: 'synthetic-controls', allocationSeed: 42, author: { model: 'synthetic-no-model', launcher: { name: 'offline-control', version: '1' }, settings: { temperature: null, seed: null }, tools: ['read', 'shell'], budget: { maxTurns: 10, maxTokens: 10000, wallTimeSeconds: 600 }, unsupportedSamplingControls: ['temperature', 'seed'], isolation: 'cooperative-only' } };
  const settingsFile = join(root, 'settings.json');
  writeFileSync(settingsFile, encode(declared));
  try {
    await t.test('prepare fixes forty opaque runs, balanced order, and public input equality', () => {
      assert.match(cli(['prepare', '--out', directory, '--settings', settingsFile]).stdout, /Prepared 40 fresh sessions/);
      const plan = json(join(directory, 'plan.json')) as { runs: { id: string; fixture: string; arm: string; pair: number; order: number; commonHash: string; project: string }[]; pins: Record<string, unknown> };
      assert.equal(plan.runs.length, 40);
      assert.equal(new Set(plan.runs.map(value => value.id)).size, 40);
      assert.deepEqual(plan.runs.map(value => value.order), Array.from({ length: 40 }, (_, index) => index));
      assert.equal(plan.runs.filter(value => value.order % 2 === 0 && value.arm === 'current').length, 10);
      assert.match(String(plan.pins.browserVersion), /^\d+\./);
      assert.equal(plan.pins.node, process.version);
      assert.equal(plan.pins.commonTaskHash, hash(task));
      assert.deepEqual(plan.pins.expectedLowerTestExit, { cart: 0, wiring: 0, 'stale-test': 1, 'no-relevant-test': 0 });
      for (const fixture of fixtures) {
        for (const arm of ['current', 'inspect-lower-tests']) assert.equal(plan.runs.filter(value => value.fixture === fixture.id && value.arm === arm).length, 5);
      }
      for (let pair = 0; pair < 20; pair++) {
        const entries = plan.runs.filter(value => value.pair === pair);
        assert.equal(entries.length, 2);
        assert.equal(entries[0]!.commonHash, entries[1]!.commonHash);
        const current = entries.find(value => value.arm === 'current')!;
        const changed = entries.find(value => value.arm !== 'current')!;
        const project = (entry: typeof current) => join(directory, 'author', entry.id, entry.project);
        const currentFiles = tree(project(current));
        const changedFiles = tree(project(changed));
        const changedPaths = Object.keys(currentFiles).filter(path => currentFiles[path] !== changedFiles[path]);
        assert.deepEqual(changedPaths, ['.agents/skills/e2e/SKILL.md']);
        assert.equal(readFileSync(join(project(changed), changedPaths[0]!), 'utf8'), readFileSync(join(project(current), changedPaths[0]!), 'utf8') + treatment);
        assert.equal(readFileSync(join(project(current), 'TASK.md'), 'utf8'), task);
        assert.equal(Object.keys(currentFiles).some(path => /experiment\.ts|corpus\.ts|plan\.json|settings\.json/.test(path)), false);
      }
      const bytes = readFileSync(join(directory, 'plan.json'));
      cli(['prepare', '--out', directory, '--settings', settingsFile]);
      assert.deepEqual(readFileSync(join(directory, 'plan.json')), bytes);
      writeFileSync(settingsFile, encode({ ...declared, allocationSeed: 7 }));
      assert.match(cli(['prepare', '--out', directory, '--settings', settingsFile], 1).stderr, /Conflicting preparation/);
      writeFileSync(settingsFile, encode(declared));
    });

    await t.test('pending report keeps all twenty runs per arm visible', () => {
      assert.match(cli(['summarize', '--experiment', directory]).stdout, /pending/);
      const summary = json(join(directory, 'reports/summary.json')) as { complete: boolean; proposedPromotion: null; rows: { fixture: string; scheduled: number; pending: number; detected: number }[] };
      assert.equal(summary.complete, false);
      assert.equal(summary.proposedPromotion, null);
      assert.deepEqual(summary.rows.filter(value => value.fixture === 'all').map(value => [value.scheduled, value.pending, value.detected]), [[20, 20, 0], [20, 20, 0]]);
    });

    await t.test('strong controls catch every intended UI regression and negative controls receive no credit', () => {
      const results = JSON.parse(cli(['grade', '--experiment', directory, '--controls']).stdout) as { fixture: string; control: string; correct: { kind: string }; mutant: { kind: string }; beforeReview: { kind: string }; outcome: { kind: string } }[];
      assert.equal(results.length, 27);
      for (const fixture of fixtures) {
        const strong = results.find(value => value.fixture === fixture.id && value.control === 'strong')!;
        assert.deepEqual([strong.correct.kind, strong.mutant.kind, strong.beforeReview.kind, strong.outcome.kind], ['passed', 'failed', 'pending', 'detected']);
      }
      assert.equal(results.filter(value => value.control !== 'strong' && value.outcome.kind === 'detected').length, 0);
      assert.equal(results.filter(value => value.control === 'empty').every(value => value.correct.kind === 'unusable'), true);
      assert.equal(results.filter(value => value.control === 'broken-server').every(value => value.correct.kind === 'unusable'), true);
      for (const control of ['skip', 'setup', 'timeout']) assert.equal(results.find(value => value.control === control)!.correct.kind, 'unusable');
      cli(['summarize', '--experiment', directory]);
      const summary = json(join(directory, 'reports/summary.json')) as { rows: { detected: number; submitted: number }[] };
      assert.equal(summary.rows.every(value => value.detected === 0 && value.submitted === 0), true);
      assert.match(cli(['grade', '--experiment', directory, '--controls', '--fixture', 'unknown'], 1).stderr, /Unknown fixture/);
    });

    await t.test('imports immutable bytes, blinds packets, and binds separate synthetic decisions to evidence', () => {
      const plan = json(join(directory, 'plan.json')) as { settingsHash: string; runs: { id: string; project: string; fixture: string }[] };
      const entry = plan.runs.find(value => value.fixture === 'cart')!;
      const submission = join(root, 'returned');
      mkdirSync(join(submission, 'tests'), { recursive: true });
      const source = controlTest(fixtures[0].strong);
      writeFileSync(join(submission, 'tests/requirement.e2e.ts'), source);
      writeFileSync(join(submission, 'authoring.json'), encode({ settingsHash: plan.settingsHash, sessionId: 'synthetic-session-one', attested: { freshSession: true, projectOnly: true, author: declared.author }, observed: {} }));
      const args = ['grade', '--experiment', directory, '--run', entry.id, '--submission', submission];
      const graded = JSON.parse(cli(args).stdout) as { packetId: string; evidenceHash: string; correct: { kind: string }; mutant: { kind: string } };
      assert.deepEqual([graded.correct.kind, graded.mutant.kind], ['passed', 'failed']);
      assert.equal(readFileSync(join(directory, 'submissions', entry.id, 'tests/requirement.e2e.ts'), 'utf8'), source);
      assert.deepEqual(JSON.parse(cli(args).stdout), graded);
      const packet = join(directory, 'packets', graded.packetId);
      assert.equal(readFileSync(join(packet, 'requirement.e2e.ts'), 'utf8'), source);
      const packetFiles = Object.keys(tree(packet));
      assert.equal(packetFiles.some(path => /authoring\.json|transcript|SKILL|plan\.json/.test(path)), false);
      for (const path of packetFiles.filter(value => /\.(json|md|txt|log)$/.test(value))) {
        const content = readFileSync(join(packet, path), 'utf8');
        assert.equal(content.includes('synthetic-no-model') || content.includes('inspect-lower-tests') || content.includes('settingsHash'), false, path);
      }
      cli(['summarize', '--experiment', directory]);
      const pending = json(join(directory, 'reports/summary.json')) as { rows: { fixture: string; pending: number; reviewed: number }[] };
      assert.equal(pending.rows.find(value => value.fixture === 'all')!.reviewed, 0);
      const reviewFile = join(root, 'reviews.json');
      const review = { packetId: graded.packetId, evidenceHash: graded.evidenceHash, reviewer: 'synthetic-control-review', verdict: 'intended-bug', reason: 'Synthetic decision checks plumbing only. The visible total remains $12 after quantity becomes 3.', synthetic: true };
      writeFileSync(reviewFile, encode([{ ...review, evidenceHash: '0'.repeat(64) }]));
      assert.match(cli(['summarize', '--experiment', directory, '--reviews', reviewFile], 1).stderr, /match pilot evidence/);
      writeFileSync(reviewFile, encode([{ ...review, packetId: '0'.repeat(24) }]));
      assert.match(cli(['summarize', '--experiment', directory, '--reviews', reviewFile], 1).stderr, /match pilot evidence/);
      writeFileSync(reviewFile, encode([review, review]));
      assert.match(cli(['summarize', '--experiment', directory, '--reviews', reviewFile], 1).stderr, /Duplicate packet judgment/);
      writeFileSync(reviewFile, encode([review]));
      cli(['summarize', '--experiment', directory, '--reviews', reviewFile]);
      const reviewed = json(join(directory, 'reports/summary.json')) as { complete: boolean; rows: { detected: number; reviewed: number }[] };
      assert.equal(reviewed.complete, false);
      assert.equal(reviewed.rows.every(value => value.detected === 0), true);
      assert.equal(reviewed.rows.some(value => value.reviewed === 1), true);
      writeFileSync(join(submission, 'tests/requirement.e2e.ts'), source + '\n');
      assert.match(cli(args, 1).stderr, /Conflicting submission/);
      writeFileSync(join(submission, 'tests/requirement.e2e.ts'), source);
      const frozenSource = join(directory, 'submissions', entry.id, 'tests/requirement.e2e.ts');
      writeFileSync(frozenSource, source + '\n');
      assert.match(cli(['summarize', '--experiment', directory], 1).stderr, /Frozen submission bytes changed/);
      writeFileSync(frozenSource, source);
      writeFileSync(join(packet, 'requirement.txt'), 'changed evidence');
      assert.match(cli(['summarize', '--experiment', directory], 1).stderr, /packet bytes changed/);
      writeFileSync(join(packet, 'requirement.txt'), fixtures[0].requirement + '\n');
      const second = plan.runs.find(value => value.id !== entry.id)!;
      assert.match(cli(['grade', '--experiment', directory, '--run', second.id, '--submission', submission], 1).stderr, /session ID already used/);
      const protectedPath = join(directory, 'author', second.id, second.project, 'rules.mjs');
      const before = readFileSync(protectedPath);
      writeFileSync(protectedPath, 'changed app');
      assert.match(cli(['grade', '--experiment', directory, '--run', second.id, '--submission', submission], 1).stderr, /Protected author project/);
      writeFileSync(protectedPath, before);
    });

    await t.test('app imports and runtime AI are rejected without detection credit', () => {
      const plan = json(join(directory, 'plan.json')) as { settingsHash: string; runs: { id: string }[] };
      const available = plan.runs.filter(entry => !existsSync(join(directory, 'submissions', entry.id)));
      for (const [index, source] of ["import './rules.mjs';", "import { test } from '@e2e-dev/web';\ntest('AI excluded', async ({ agent }) => { await agent.act('click'); });"].entries()) {
        const submission = join(root, `rejected-${index}`);
        mkdirSync(join(submission, 'tests'), { recursive: true });
        writeFileSync(join(submission, 'tests/requirement.e2e.ts'), source);
        writeFileSync(join(submission, 'authoring.json'), encode({ settingsHash: plan.settingsHash, sessionId: `synthetic-rejected-${index}`, attested: { freshSession: true, projectOnly: true, author: declared.author }, observed: {} }));
        const result = JSON.parse(cli(['grade', '--experiment', directory, '--run', available[index]!.id, '--submission', submission]).stdout) as { correct: { kind: string; reason: string } };
        assert.equal(result.correct.kind, 'unusable');
        assert.match(result.correct.reason, /^submission-contract/);
      }
      cli(['summarize', '--experiment', directory]);
      const report = json(join(directory, 'reports/summary.json')) as { rows: { fixture: string; invalid: number; detected: number }[] };
      assert.equal(report.rows.filter(value => value.fixture === 'all').reduce((sum, value) => sum + value.invalid, 0), 2);
      assert.equal(report.rows.every(value => value.detected === 0), true);
    });
  } finally {
    if (process.env.AUTHORING_KEEP_CONTROLS) process.stdout.write(`Synthetic evidence retained at ${root}\n`);
    else rmSync(root, { recursive: true, force: true });
  }
});

test('launcher metadata and budget policy through the public CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-authoring-policy-'));
  const directory = join(root, 'experiment');
  const limits = { maxTurns: 10, maxTokens: 10000, wallTimeSeconds: 600 };
  const author = { model: 'policy-fixture-no-model', launcher: { name: 'policy-fixture', version: '1' }, settings: { nested: { temperature: 0, seed: 42 }, sequence: ['read', 'shell'] }, tools: ['read', 'shell'], budget: limits, unsupportedSamplingControls: [], isolation: 'cooperative-only' };
  const declared = { purpose: 'pilot', allocationSeed: 42, author };
  const usage = { turns: 10, tokens: 10000, wallTimeSeconds: 600 };
  const runs = fixtures.flatMap((fixture, fixtureIndex) => ['current', 'inspect-lower-tests'].flatMap((arm, armIndex) => Array.from({ length: 5 }, (_, repetition) => ({ id: (fixtureIndex * 10 + armIndex * 5 + repetition + 1).toString(16).padStart(24, '0'), fixture: fixture.id, arm, pair: fixtureIndex * 5 + repetition, order: fixtureIndex * 10 + armIndex * 5 + repetition, project: fixture.name, commonHash: hash(encode({})), projectHash: hash(encode({})) }))));
  mkdirSync(join(directory, 'runtime'), { recursive: true });
  for (const fixture of fixtures) mkdirSync(join(directory, 'snapshots', fixture.id), { recursive: true });
  for (const entry of runs) mkdirSync(join(directory, 'author', entry.id, entry.project), { recursive: true });
  const plan = { version: 1, fingerprint: hash('policy fixture'), settings: declared, settingsHash: hash(encode(declared)), pins: { node: process.version, corpusHash: hash(encode(fixtures)) }, runtimeHash: hash(encode({})), runs, snapshots: Object.fromEntries(fixtures.map(fixture => [fixture.id, hash(encode({}))])) };
  writeFileSync(join(directory, 'plan.json'), encode(plan));
  writeFileSync(join(directory, 'plan.sha256'), hash(encode(plan)) + '\n');
  const submission = join(root, 'returned');
  mkdirSync(join(submission, 'tests'), { recursive: true });
  writeFileSync(join(submission, 'tests/requirement.e2e.ts'), "import 'node:fs';\n");
  const entry = runs[0]!;
  const authoring = { settingsHash: plan.settingsHash, sessionId: 'policy-session', attested: { freshSession: true, projectOnly: true, author: { ...author, settings: { sequence: ['read', 'shell'], nested: { seed: 42, temperature: 0 } } } }, observed: { settings: { nested: { seed: 42, temperature: 0 }, sequence: ['read', 'shell'] }, usage } };
  const args = ['grade', '--experiment', directory, '--run', entry.id, '--submission', submission];
  const importRecord = (value: unknown, expected = 0) => {
    writeFileSync(join(submission, 'authoring.json'), encode(value));
    return cli(args, expected);
  };
  const readSummary = () => {
    cli(['summarize', '--experiment', directory]);
    return json(join(directory, 'reports/summary.json')) as { complete: boolean; proposedPromotion: boolean | null; runs: { run: string; usage: typeof usage | { turns: null; tokens: null; wallTimeSeconds: null }; budget: { kind: string; metrics?: string[] } }[]; rows: { fixture: string; arm: string; detected: number; invalid: number; budget: { within: number; exceeded: number; unknown: number }; usage: { turns: { known: number; missing: number; total: number | null }; tokens: { known: number; missing: number; total: number | null }; wallTimeSeconds: { known: number; missing: number; total: number | null } } }[] };
  };
  try {
    assert.match(importRecord({ ...authoring, observed: { ...authoring.observed, settings: { nested: { seed: 41, temperature: 0 }, sequence: ['read', 'shell'] } } }, 1).stderr, /Observed author settings differs/);
    assert.match(importRecord({ ...authoring, observed: { ...authoring.observed, settings: { nested: { seed: 42, temperature: 0 }, sequence: ['shell', 'read'] } } }, 1).stderr, /Observed author settings differs/);
    assert.match(importRecord({ ...authoring, attested: { ...authoring.attested, author: { ...author, settings: { nested: { temperature: 0, seed: 42 }, sequence: ['shell', 'read'] } } } }, 1).stderr, /Author declaration differs/);
    const imported = JSON.parse(importRecord(authoring).stdout) as { authoring: unknown; packetId: string };
    assert.deepEqual(imported.authoring, { kind: 'session', usage, budget: { kind: 'within' } });
    assert.equal(Object.keys(tree(join(directory, 'packets', imported.packetId))).some(path => path.includes('authoring')), false);
    assert.match(importRecord({ ...authoring, observed: { ...authoring.observed, usage: { ...usage, turns: 9 } } }, 1).stderr, /Conflicting submission/);
    assert.match(importRecord({ ...authoring, attested: { ...authoring.attested, author } }, 1).stderr, /Conflicting submission/);

    const observedCases = [
      { observed: { turns: 0, tokens: 0, wallTimeSeconds: 0 }, budget: { kind: 'within' } },
      { observed: undefined, budget: { kind: 'unknown', metrics: ['turns', 'tokens', 'wallTimeSeconds'] } },
      { observed: { turns: 11, tokens: 10000, wallTimeSeconds: 600 }, budget: { kind: 'exceeded', metrics: ['turns'] } },
      { observed: { turns: 10, tokens: 10001, wallTimeSeconds: 600 }, budget: { kind: 'exceeded', metrics: ['tokens'] } },
      { observed: { turns: 10, tokens: 10000, wallTimeSeconds: 601 }, budget: { kind: 'exceeded', metrics: ['wallTimeSeconds'] } },
      { observed: { turns: null, tokens: null, wallTimeSeconds: null }, budget: { kind: 'unknown', metrics: ['turns', 'tokens', 'wallTimeSeconds'] } },
      { observed: { turns: 10, tokens: null, wallTimeSeconds: 600 }, budget: { kind: 'unknown', metrics: ['tokens'] } },
      { observed: { turns: 11, tokens: null, wallTimeSeconds: null }, budget: { kind: 'exceeded', metrics: ['turns'] } },
    ];
    const importedCases = observedCases.map((value, index) => {
      const runId = runs[index + 1]!.id;
      writeFileSync(join(submission, 'authoring.json'), encode({ ...authoring, sessionId: 'policy-' + runId, observed: { usage: value.observed } }));
      const result = JSON.parse(cli(['grade', '--experiment', directory, '--run', runId, '--submission', submission]).stdout) as { authoring: { kind: string; usage: unknown; budget: unknown } };
      assert.deepEqual(result.authoring, { kind: 'session', usage: value.observed ?? { turns: null, tokens: null, wallTimeSeconds: null }, budget: value.budget });
      return result.authoring;
    });
    const reviews = runs.map((run, index) => {
      const packetId = (index + 100).toString(16).padStart(24, '0');
      const packetDirectory = join(directory, 'packets', packetId);
      mkdirSync(packetDirectory, { recursive: true });
      writeFileSync(join(packetDirectory, 'requirement.txt'), 'Policy fixture, no browser execution claimed.\n');
      const evidenceHash = hash(encode(tree(packetDirectory)));
      writeFileSync(join(packetDirectory, 'packet.json'), encode({ packetId, evidenceHash, decisionFields: ['packetId', 'evidenceHash', 'reviewer', 'verdict', 'reason', 'synthetic'] }));
      const returned = join(directory, 'submissions', run.id);
      mkdirSync(returned, { recursive: true });
      writeFileSync(join(returned, 'policy-fixture.txt'), 'Policy fixture, no authoring session claimed.\n');
      const graded = { run: run.id, submissionHash: hash(encode(tree(returned))), correct: { kind: 'passed', report: 'policy-fixture', selected: 1, selectionHash: hash('selection') }, mutant: { kind: 'failed', report: 'policy-fixture', selected: 1, selectionHash: hash('selection') }, packetId, evidenceHash, synthetic: false, authoring: { kind: 'session', usage, budget: { kind: 'within' } } };
      mkdirSync(join(directory, 'grades'), { recursive: true });
      writeFileSync(join(directory, 'grades', run.id + '.json'), encode(graded));
      writeFileSync(join(directory, 'grades', run.id + '.sha256'), hash(encode(graded)) + '\n');
      return { packetId, evidenceHash, reviewer: 'policy fixture', verdict: run.arm === 'current' ? 'unrelated-failure' : 'intended-bug', reason: 'Synthetic policy fixture only, not pilot evidence.', synthetic: false };
    });
    const reviewFile = join(root, 'reviews.json');
    writeFileSync(reviewFile, encode(reviews));
    cli(['summarize', '--experiment', directory, '--reviews', reviewFile]);
    let report = readSummary();
    assert.deepEqual([report.complete, report.proposedPromotion], [true, true]);
    const all = () => report.rows.filter(row => row.fixture === 'all');
    assert.deepEqual(all().map(row => [row.detected, row.budget, row.usage.turns]), [[0, { within: 20, exceeded: 0, unknown: 0 }, { known: 20, missing: 0, total: 200 }], [20, { within: 20, exceeded: 0, unknown: 0 }, { known: 20, missing: 0, total: 200 }]]);
    const targets = runs.filter(run => run.arm === 'inspect-lower-tests').slice(0, 5);
    for (const [index, run] of targets.entries()) {
      const path = join(directory, 'grades', run.id + '.json');
      const fixtureGrade = json(path) as Record<string, unknown>;
      fixtureGrade.authoring = importedCases[index + 2];
      writeFileSync(path, encode(fixtureGrade));
      writeFileSync(join(directory, 'grades', run.id + '.sha256'), hash(encode(fixtureGrade)) + '\n');
    }
    report = readSummary();
    assert.deepEqual([report.complete, report.proposedPromotion], [false, null]);
    assert.deepEqual(all().find(row => row.arm === 'inspect-lower-tests')!.budget, { within: 15, exceeded: 3, unknown: 2 });
    assert.equal(all().find(row => row.arm === 'inspect-lower-tests')!.detected, 15);
    assert.equal(all().find(row => row.arm === 'inspect-lower-tests')!.invalid, 3);
    assert.deepEqual(targets.slice(0, 3).map(run => report.runs.find(row => row.run === run.id)!.budget), [{ kind: 'exceeded', metrics: ['turns'] }, { kind: 'exceeded', metrics: ['tokens'] }, { kind: 'exceeded', metrics: ['wallTimeSeconds'] }]);
    assert.deepEqual(report.runs.find(row => row.run === targets[3]!.id)!.usage, { turns: null, tokens: null, wallTimeSeconds: null });
    assert.deepEqual(report.runs.find(row => row.run === targets[4]!.id)!.budget, { kind: 'unknown', metrics: ['tokens'] });
    assert.deepEqual(all().find(row => row.arm === 'inspect-lower-tests')!.usage.tokens, { known: 18, missing: 2, total: 180001 });
    assert.match(readFileSync(join(directory, 'reports/summary.md'), 'utf8'), /unknown/);
    for (const run of runs) {
      const path = join(directory, 'grades', run.id + '.json');
      const fixtureGrade = json(path) as Record<string, unknown>;
      fixtureGrade.authoring = importedCases[1];
      writeFileSync(path, encode(fixtureGrade));
      writeFileSync(join(directory, 'grades', run.id + '.sha256'), hash(encode(fixtureGrade)) + '\n');
    }
    report = readSummary();
    assert.deepEqual(all().map(row => row.usage.tokens), [{ known: 0, missing: 20, total: null }, { known: 0, missing: 20, total: null }]);
    assert.deepEqual(all().map(row => row.detected), [0, 0]);
    assert.deepEqual([report.complete, report.proposedPromotion], [false, null]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
