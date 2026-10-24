import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { harderFixtureIds, harderFixtures, harderProjectFiles, harderStudy, harderTask, parseHarderFixtures } from './harder.ts';
import { command, encode, hash, json, repo, tree } from './files.ts';

function cli(args: string[], expected = 0) {
  const result = spawnSync(process.execPath, [join(repo, 'apps/test-authoring/cli.ts'), ...args], { encoding: 'utf8', timeout: 900000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  return result;
}

test('harder public projects keep passing lower tests and isolated UI mutations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'product-files-'));
  try {
    const corpus = parseHarderFixtures(harderFixtures);
    assert.equal(corpus.length, 6);
    assert.throws(() => parseHarderFixtures([...corpus.slice(1), corpus[1]]));
    assert.throws(() => parseHarderFixtures(corpus.map((entry, index) => index ? entry : { ...entry, files: { ...entry.files, '../private.txt': 'invalid' } })));
    for (const fixture of corpus) {
      const modules = [];
      for (const changed of [false, true]) {
        const project = join(root, fixture.name, changed ? 'changed' : 'correct');
        const files = harderProjectFiles(fixture);
        assert.equal(files['TASK.md'], harderTask);
        assert.equal(files['PRODUCT.md'], fixture.requirement);
        assert.equal(Object.keys(files).some(path => /corpus\.json|admission|plan\.json/.test(path)), false);
        if (changed) files[fixture.mutationFile] = files[fixture.mutationFile]!.replace(fixture.mutation[0], fixture.mutation[1]);
        for (const [path, content] of Object.entries(files)) {
          const destination = join(project, path);
          mkdirSync(join(destination, '..'), { recursive: true });
          writeFileSync(destination, content);
          if (/\.m?js$/.test(path)) {
            const syntax = spawnSync(process.execPath, ['--check', destination], { encoding: 'utf8' });
            assert.equal(syntax.status, 0, syntax.stderr);
          }
        }
        const lower = command(project, process.execPath, ['--test', '--test-reporter=tap', 'lower/rules.test.mjs']);
        assert.equal(lower.status, 0, lower.stdout + lower.stderr);
        assert.match(lower.stdout, /tests 1\b/);
        modules.push(fixture.id === 'persistence' ? null : await import(pathToFileURL(join(project, 'view.mjs')).href));
      }
      const [correct, changed] = modules;
      if (fixture.id === 'checkout') {
        let differences = 0;
        for (let tote = 0; tote <= 4; tote++) for (let book = 0; book <= 4; book++) for (let card = 0; card <= 4; card++) for (const promotion of [null, 'FOREST20']) for (const delivery of ['standard', 'pickup']) {
          const before = correct!.quoteForView([tote, book, card], promotion, delivery);
          const after = changed!.quoteForView([tote, book, card], promotion, delivery);
          const permitted = delivery === 'standard' && before.merchandise >= 5000 && before.discounted < 5000;
          assert.equal(before.delivery !== after.delivery, permitted);
          assert.deepEqual({ ...before, delivery: after.delivery, total: after.total }, after);
          if (permitted) differences++;
        }
        assert.equal(differences, 4);
      } else if (fixture.id === 'adjacency') {
        const endpoints = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00'];
        const booking = { start: '10:00', end: '11:00' };
        for (const start of endpoints) for (const end of endpoints) {
          if (start >= end) continue;
          const before = correct!.conflicts({ start, end }, booking);
          const after = changed!.conflicts({ start, end }, booking);
          assert.equal(before, start < '11:00' && end > '10:00');
          assert.equal(before !== after, !before && (start === '11:00' || end === '10:00'));
        }
      } else if (fixture.id === 'capacity') {
        assert.equal(correct!.formAvailability({ reservations: [{ seats: 2, status: 'Cancelled' }] }, 0), 2);
        assert.equal(changed!.formAvailability({ reservations: [{ seats: 2, status: 'Cancelled' }] }, 0), 0);
        assert.equal(correct!.formAvailability({ reservations: [{ seats: 2, status: 'Active' }] }, 0), 0);
        assert.equal(changed!.formAvailability({ reservations: [{ seats: 2, status: 'Active' }] }, 0), 0);
      } else if (fixture.id === 'address') {
        const previous = { valid: true, error: '', postal: '02139' };
        assert.deepEqual(correct!.validationForForm({ country: 'CA', postal: '02139', validation: previous }), { valid: false, error: 'Use the Canadian letter-digit format', postal: '02139' });
        assert.deepEqual(changed!.validationForForm({ country: 'CA', postal: '02139', validation: previous }), { valid: true, error: 'Use the Canadian letter-digit format', postal: '02139' });
      } else if (fixture.id === 'policy') {
        const project = join(root, fixture.name, 'correct');
        const data = await import(pathToFileURL(join(project, 'data.mjs')).href);
        assert.deepEqual(data.bookings.map(correct!.eligible), [false, true, true, true, false, true]);
        assert.deepEqual(data.bookings.map(changed!.eligible), [false, false, false, true, false, true]);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixed baseline study through the real CLI, controls, and report', { timeout: 1200000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'baseline-policy-'));
  const directory = join(root, 'private');
  const declared = { purpose: 'pilot', allocationSeed: 42, author: { model: 'offline-policy-fixture-no-model', launcher: { name: 'offline-fixture', version: '1' }, settings: {}, tools: ['shell'], budget: { maxTurns: 32, maxTokens: 400000, wallTimeSeconds: 600 }, unsupportedSamplingControls: [], isolation: 'cooperative-only' } };
  const settings = join(root, 'settings.json');
  writeFileSync(settings, encode(declared));
  try {
    assert.match(cli(['prepare', '--study', harderStudy, '--out', directory, '--settings', settings]).stdout, /Prepared 12 fresh sessions/);
    const plan = json(join(directory, 'plan.json')) as { version: number; study: string; runs: { id: string; fixture: string; arm: string; order: number; project: string; projectHash: string }[]; pins: Record<string, string> };
    assert.equal(plan.version, 2);
    assert.equal(plan.study, harderStudy);
    assert.equal(new Set(plan.runs.map(entry => entry.id)).size, 12);
    assert.deepEqual(plan.runs.map(entry => entry.order), Array.from({ length: 12 }, (_, index) => index));
    for (const id of harderFixtureIds) assert.equal(plan.runs.filter(entry => entry.fixture === id && entry.arm === 'current').length, 2);
    const controls = json(join(directory, 'admission-controls.json')) as { control: string; outcome: { kind: string } }[];
    assert.equal(controls.length, 36);
    assert.equal(controls.filter(entry => entry.control === 'strong' && entry.outcome.kind === 'detected').length, 6);
    assert.equal(controls.filter(entry => entry.control !== 'strong' && entry.outcome.kind === 'detected').length, 0);
    assert.equal(hash(readFileSync(join(directory, 'admission-controls.json'))), plan.pins.controlEvidenceHash);
    for (const entry of plan.runs) {
      const project = join(directory, 'author', entry.id, entry.project);
      assert.equal(hash(encode(tree(project))), entry.projectHash);
      assert.equal(readFileSync(join(project, 'TASK.md'), 'utf8'), harderTask);
      assert.equal(readFileSync(join(project, '.agents/skills/e2e/SKILL.md'), 'utf8'), readFileSync(join(repo, 'skills/e2e/SKILL.md'), 'utf8'));
    }
    const bytes = readFileSync(join(directory, 'plan.json'));
    cli(['prepare', '--study', harderStudy, '--out', directory, '--settings', settings]);
    assert.deepEqual(readFileSync(join(directory, 'plan.json')), bytes);
    cli(['prepare', '--study', 'sixty-run-comparison', '--out', directory, '--settings', settings], 1);
    cli(['summarize', '--study', harderStudy, '--experiment', directory], 1);
    const summary = () => {
      cli(['summarize', '--experiment', directory]);
      return json(join(directory, 'reports/summary.json')) as { admission: string; informativeFamiliesWithMiss: string[]; humanAttributionPending: number; rows: { fixture: string; scheduled: number; submitted: number; qualifyingMisses: number }[] };
    };
    assert.equal(summary().admission, 'unresolved');
    assert.deepEqual(summary().rows.map(entry => entry.scheduled), [12, 2, 2, 2, 2, 2, 2]);

    const sealPolicyGrade = (index: number, changed: 'passed' | 'failed', tokens: number | null = 100, selectionHash = hash('selection'), correct: 'passed' | 'failed' = 'passed') => {
      const entry = plan.runs[index]!;
      const packetId = (index + 1).toString(16).padStart(24, '0');
      const packet = join(directory, 'packets', packetId);
      mkdirSync(packet, { recursive: true });
      writeFileSync(join(packet, 'requirement.txt'), 'Synthetic policy fixture. No author session or browser execution is represented by this record.\n');
      const packetFiles = tree(packet);
      delete packetFiles['packet.json'];
      const evidenceHash = hash(encode(packetFiles));
      writeFileSync(join(packet, 'packet.json'), encode({ packetId, evidenceHash, decisionFields: ['packetId', 'evidenceHash', 'reviewer', 'verdict', 'reason', 'synthetic'] }));
      const submission = join(directory, 'submissions', entry.id);
      mkdirSync(submission, { recursive: true });
      writeFileSync(join(submission, 'fixture.txt'), 'Synthetic policy fixture only.\n');
      const graded = { run: entry.id, submissionHash: hash(encode(tree(submission))), correct: { kind: correct, report: 'policy-fixture', selected: 1, selectionHash: hash('selection') }, mutant: { kind: changed, report: 'policy-fixture', selected: 1, selectionHash }, packetId, evidenceHash, synthetic: false, authoring: { kind: 'session', usage: { turns: 1, tokens, wallTimeSeconds: 1 }, budget: tokens === null ? { kind: 'unknown', metrics: ['tokens'] } : { kind: 'within' } } };
      mkdirSync(join(directory, 'grades'), { recursive: true });
      writeFileSync(join(directory, 'grades', entry.id + '.json'), encode(graded));
      writeFileSync(join(directory, 'grades', entry.id + '.sha256'), hash(encode(graded)) + '\n');
    };
    for (let index = 0; index < 12; index++) sealPolicyGrade(index, 'failed');
    assert.equal(summary().admission, 'not-admitted');
    assert.equal(summary().humanAttributionPending, 12);
    const informative = ['checkout', 'adjacency'].map(fixture => plan.runs.findIndex(entry => entry.fixture === fixture));
    for (const index of informative) sealPolicyGrade(index, 'passed');
    assert.equal(summary().admission, 'admitted');
    assert.deepEqual(summary().informativeFamiliesWithMiss.toSorted(), ['adjacency', 'checkout']);
    assert.equal(summary().humanAttributionPending, 10);
    sealPolicyGrade(informative[0]!, 'passed', null);
    assert.equal(summary().admission, 'unresolved');
    sealPolicyGrade(informative[0]!, 'passed', 100, hash('different selection'));
    assert.equal(summary().admission, 'unresolved');
    sealPolicyGrade(informative[0]!, 'passed', 100, hash('selection'), 'failed');
    assert.equal(summary().admission, 'unresolved');
    for (let index = 0; index < 12; index++) sealPolicyGrade(index, ['policy', 'persistence'].includes(plan.runs[index]!.fixture) ? 'passed' : 'failed');
    assert.equal(summary().admission, 'not-admitted');
    assert.deepEqual(summary().informativeFamiliesWithMiss, []);
    const corpus = readFileSync(join(directory, 'corpus.json'));
    writeFileSync(join(directory, 'corpus.json'), '{}\n');
    assert.match(cli(['summarize', '--experiment', directory], 1).stderr, /Frozen harder corpus changed/);
    writeFileSync(join(directory, 'corpus.json'), corpus);
    writeFileSync(join(directory, 'plan.json'), encode({ ...JSON.parse(bytes.toString()), runs: plan.runs.slice(1) }));
    writeFileSync(join(directory, 'plan.sha256'), hash(readFileSync(join(directory, 'plan.json'))) + '\n');
    cli(['summarize', '--experiment', directory], 1);
  } finally {
    if (process.env.AUTHORING_KEEP_CONTROLS) process.stdout.write(`Synthetic evidence retained at ${root}\n`);
    else rmSync(root, { recursive: true, force: true });
  }
});
