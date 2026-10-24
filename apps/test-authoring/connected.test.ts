import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { connectedFixtures } from './connected-fixtures.ts';
import { encode, hash, json, repo, tree } from './files.ts';

type Slot = { id: string; fixture: string; order: number };

/** Matches portable path keys without changing the synthetic evidence bytes. */
function files(root: string): Record<string, string> {
  return Object.fromEntries(Object.entries(tree(root)).map(([path, value]) => [path.split(sep).join('/'), value]).toSorted(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0));
}

/** Writes synthetic sealed records to exercise policy without representing browser or author results. */
function record(path: string, value: unknown): string {
  mkdirSync(join(path, '..'), { recursive: true });
  const bytes = encode(value);
  writeFileSync(path, bytes);
  writeFileSync(path.replace(/\.json$/, '.sha256'), hash(bytes) + '\n');
  return hash(bytes);
}

/** Invokes the private connected command as its operator does. */
function cli(args: string[], expected = 0) {
  const result = spawnSync(process.execPath, [join(repo, 'apps/test-authoring/connected-cli.ts'), ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  return result;
}

/** Builds explicit synthetic policy inputs, never a prepared executable bank or real admission. */
function policyBank(root: string) {
  const directory = join(root, 'synthetic-policy-only');
  mkdirSync(join(directory, 'runtime'), { recursive: true });
  writeFileSync(join(directory, 'runtime/SYNTHETIC.txt'), 'No installed packages, author sessions or browser evidence exist in this policy fixture.\n');
  const runtimeHash = hash(encode(files(join(directory, 'runtime'))));
  const sourceBytes = 'Synthetic report-policy source only.\n';
  const sourceFiles = { 'SYNTHETIC.txt': { kind: 'file', hash: hash(sourceBytes) } };
  record(join(directory, 'source/files.json'), sourceFiles);
  mkdirSync(join(directory, 'source/blobs'), { recursive: true });
  writeFileSync(join(directory, 'source/blobs', hash(sourceBytes)), sourceBytes);
  const source = { repository: repo, revision: 'a'.repeat(40), cleanWorktree: true, contentHash: hash(encode(sourceFiles)), lockHash: hash('synthetic lock'), node: process.version, chromium: 'synthetic-no-browser' };
  const settings = { schemaVersion: 1, purpose: 'connected-baseline-feasibility', allocationSeed: 42, author: { model: 'synthetic-policy-no-model', effort: 'max', settings: {}, tools: ['shell', 'e2e'], unsupportedSamplingControls: [], isolation: 'externally-enforced' }, operator: { name: 'synthetic-policy-no-operator', version: '1', sourceHash: hash('synthetic operator') }, calibrationRule: '/synthetic/predeclared-rule.json' };
  writeFileSync(join(directory, 'settings.json'), encode(settings));
  writeFileSync(join(directory, 'corpus.json'), encode(connectedFixtures));
  for (const fixture of connectedFixtures) for (const [path, bytes] of Object.entries(fixture.files)) {
    const target = join(directory, 'snapshots', fixture.id, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, bytes);
  }
  const rule = { schemaVersion: 1, kind: 'connected-usage-only-budget-rule', calibrationAttempts: 6, baselineAttempts: 12, authorConcurrency: 1, calibrationCeiling: { maxTurns: 64, maxTokens: 2000000, wallTimeSeconds: 1200 }, eligibility: 'Synthetic policy fixture uses all six sources.', inputs: { T: 'total tokens', P: 'largest response', R: 'responses', W: 'seconds' }, formula: { maxTokens: '100000 * ceil((2*T + P)/100000)', maxTurns: 'max(32, 2*R + 2)', wallTimeSeconds: '60 * ceil(max(600, 2*W + 60)/60)' }, allowedEvidence: ['resource usage', 'correct-app validity', 'tool friction'], forbiddenEvidence: ['calibration mutation outcomes', 'baseline outcomes', 'selective removal of calibration attempts'], calibrationMutationGrading: false, comparisonAuthorized: false, interpretation: 'Synthetic policy check only.', onUnusableCalibration: 'Stop, never select a subset.' };
  writeFileSync(join(directory, 'calibration-rule.json'), encode(rule));
  const calibration: Slot[] = connectedFixtures.map((fixture, order) => ({ id: (order + 1).toString(16).padStart(24, '0'), fixture: fixture.id, order }));
  const prospectiveBaseline: Slot[] = connectedFixtures.flatMap(fixture => [fixture, fixture]).map((fixture, order) => ({ id: (order + 101).toString(16).padStart(24, '0'), fixture: fixture.id, order }));
  const projects: Record<string, string> = {};
  for (const [slots, phase] of [[calibration, 'calibration'], [prospectiveBaseline, 'baseline']] as const) for (const slot of slots) {
    const project = `author/${slot.id}/ordinary-demo`;
    mkdirSync(join(directory, project), { recursive: true });
    writeFileSync(join(directory, project, 'SYNTHETIC.txt'), 'Policy-only protected input.\n');
    const protectedFiles = files(join(directory, project));
    const file = `projects/${slot.id}.json`;
    record(join(directory, file), { schemaVersion: 1, kind: 'connected-public-project', id: slot.id, phase, project, projectHash: hash(encode(protectedFiles)), protectedFiles, runtimeHash, settingsHash: hash(encode(settings)), sourceHash: source.contentHash });
    projects[slot.id] = file;
  }
  const evidencePath = 'work/synthetic-policy-only';
  mkdirSync(join(directory, evidencePath), { recursive: true });
  writeFileSync(join(directory, evidencePath, 'report.json'), encode({ synthetic: true, representsBrowserExecution: false }));
  const evidenceHash = hash(encode(files(join(directory, evidencePath))));
  const cell = (kind: 'passed' | 'failed') => ({ kind, evidence: evidencePath, evidenceHash, report: `${evidencePath}/report.json`, selected: 1, selectionHash: hash('synthetic selection') });
  const controls = connectedFixtures.flatMap(fixture => ['strong', 'weak', 'wrong', 'unrelated', 'startup'].flatMap(control => (control === 'strong' || control === 'weak' ? ['correct', ...fixture.variants.map(variant => variant.id)] : ['correct']).flatMap(target => [1, 2].map(repeat => ({ fixture: fixture.id, control, target, repeat, execution: cell('passed'), expected: 'synthetic-policy-only', valid: true })))));
  const lower = connectedFixtures.flatMap(fixture => ['correct', ...fixture.variants.map(variant => variant.id)].flatMap(target => [1, 2].map(repeat => ({ fixture: fixture.id, target, repeat, files: fixture.lowerTests, count: fixture.lowerCount, evidence: evidencePath, evidenceHash, valid: true }))));
  record(join(directory, 'controls/results.json'), controls);
  record(join(directory, 'lower/results.json'), lower);
  const bank = { version: 3, study: 'connected-baseline-feasibility', comparisonAuthorized: false, settingsHash: hash(encode(settings)), corpusHash: hash(encode(connectedFixtures)), calibrationRuleHash: hash(encode(rule)), runtimeHash, controlsHash: hash(encode(controls)), lowerHash: hash(encode(lower)), source, operator: settings.operator, calibration, prospectiveBaseline, projects, repeats: 2, authorConcurrency: 1, controlLaunches: 108 };
  const bankHash = record(join(directory, 'bank.json'), bank);
  const evidence = { [`${evidencePath}/report.json`]: hash(readFileSync(join(directory, evidencePath, 'report.json'))) };
  const cleanup = { natural: 'failed', finalizer: 'passed', evidence };
  const admissionHash = record(join(directory, 'operator/admission.json'), { schemaVersion: 1, kind: 'connected-operator-admission', bankHash, operatorHash: bank.operator.sourceHash, sourceHash: source.contentHash, runtimeHash, projectManifestHash: hash(readFileSync(join(directory, projects[calibration[0]!.id]!))), status: 'pass', checks: { nativeMcp: true, attachedShell: 'pending-calibration', privateReadDenied: true, outsideWriteDenied: true, wanDenied: true, ptyAndTemp: true, receiptFailureRetained: true, copyIsolation: true, diskCapacity: true }, evidence, evidenceHash: hash(encode(evidence)), cleanup });
  const terminal = (slot: Slot, phase: 'calibration' | 'baseline', options: { status?: string; tokens?: number; seconds?: number; complete?: boolean; planHash?: string | null; budget?: { maxTurns: number; maxTokens: number; wallTimeSeconds: number }; reuseThread?: string } = {}) => {
    const manifest = json(join(directory, projects[slot.id]!)) as { project: string; projectHash: string };
    const budget = options.budget ?? { maxTurns: 64, maxTokens: 2000000, wallTimeSeconds: 1200 };
    const provenance = { phase, id: slot.id, bankHash, planHash: options.planHash ?? null, settingsHash: bank.settingsHash, projectManifestHash: hash(readFileSync(join(directory, projects[slot.id]!))), operatorHash: bank.operator.sourceHash, admissionHash, sourceHash: source.contentHash, runtimeHash };
    const startedAt = '2026-10-18T12:00:00.000Z';
    const startedHash = record(join(directory, 'attempts', phase, slot.id, 'started.json'), { schemaVersion: 1, kind: 'connected-attempt-started', ...provenance, budget, author: settings.author, startedAt });
    const fixture = connectedFixtures.find(item => item.id === slot.fixture)!;
    const testBytes = Buffer.from(fixture.controls.weak);
    const output = `exports/${phase}/${slot.id}`;
    mkdirSync(join(directory, output, 'tests'), { recursive: true });
    writeFileSync(join(directory, output, 'tests/requirement.e2e.ts'), testBytes);
    const tokens = options.tokens ?? 100000 + slot.order * 10000;
    const value = { schemaVersion: 1, kind: 'connected-attempt-terminal', ...provenance, startedHash, threadId: options.reuseThread ?? `${phase}-${slot.id}`, sessionId: options.reuseThread ?? `${phase}-${slot.id}`, model: settings.author.model, effort: settings.author.effort, status: options.status ?? 'completed', stopReason: options.status === 'cutoff' ? 'budget-cutoff' : 'completed', failure: null, startedAt, finishedAt: '2026-10-18T12:10:00.000Z', usage: { turns: 2, tokens, wallTimeSeconds: options.seconds ?? 240 + slot.order * 30 }, usageComplete: options.complete ?? true, maxResponseTokens: tokens - 1000, rawReportedUsage: { synthetic: true, totalTokens: tokens, cachedInputTokens: 500 }, responses: [{ responseId: `${phase}-${slot.id}-1`, totalTokens: tokens - 1000 }, { responseId: `${phase}-${slot.id}-2`, totalTokens: 1000 }], rawEvents: evidence, outputs: evidence, protectedInputs: { beforeHash: manifest.projectHash, afterHash: manifest.projectHash, unchanged: true }, export: { path: output, testHash: hash(testBytes), filesHash: hash(encode(files(join(directory, output)))) }, cleanup };
    const terminalHash = record(join(directory, 'attempts', phase, slot.id, 'terminal.json'), value);
    return { value, terminalHash, testBytes, exportPath: join(directory, output) };
  };
  const calibrationResults = () => {
    for (const slot of calibration) {
      const returned = terminal(slot, 'calibration');
      mkdirSync(join(directory, 'submissions', slot.id, 'tests'), { recursive: true });
      writeFileSync(join(directory, 'submissions', slot.id, 'tests/requirement.e2e.ts'), returned.testBytes);
      record(join(directory, 'calibration', `${slot.id}.json`), { version: 3, kind: 'connected-calibration-result', id: slot.id, bankHash, terminalHash: returned.terminalHash, submissionHash: hash(encode(files(join(directory, 'submissions', slot.id)))), testHash: hash(returned.testBytes), usage: returned.value.usage, maxResponseTokens: returned.value.maxResponseTokens, correct: [cell('passed'), cell('passed')], valid: true });
    }
    const chosen = calibration[0]!;
    record(join(directory, 'operator/workflow-proof.json'), { schemaVersion: 1, kind: 'connected-attached-workflow-proof', bankHash, admissionHash, operatorHash: bank.operator.sourceHash, sourceHash: source.contentHash, runtimeHash, calibrationId: chosen.id, terminalHash: hash(readFileSync(join(directory, 'attempts/calibration', chosen.id, 'terminal.json'))), attachedShell: true, evidence, evidenceHash: hash(encode(evidence)) });
  };
  return { directory, bank, bankHash, calibration, baseline: prospectiveBaseline, cell, terminal, calibrationResults };
}

/** Builds synthetic sealed grades and opaque packets solely for ordered-gate policy checks. */
function policyGrades(fixture: ReturnType<typeof policyBank>, misses: string[] = [], count = 12) {
  const { directory } = fixture;
  const plan = json(join(directory, 'plan.json')) as { budget: { maxTurns: number; maxTokens: number; wallTimeSeconds: number } };
  const planHash = hash(readFileSync(join(directory, 'plan.json')));
  const reviews: { version: number; kind: string; packetId: string; evidenceHash: string; reviewer: string; verdict: string; reason: string }[] = [];
  for (const slot of fixture.baseline.slice(0, count)) {
    const returned = fixture.terminal(slot, 'baseline', { planHash, budget: plan.budget, tokens: 10000, seconds: 10 });
    mkdirSync(join(directory, 'submissions', slot.id, 'tests'), { recursive: true });
    writeFileSync(join(directory, 'submissions', slot.id, 'tests/requirement.e2e.ts'), returned.testBytes);
    const submissionHash = hash(encode(files(join(directory, 'submissions', slot.id))));
    const members = connectedFixtures.find(item => item.id === slot.fixture)!.variants.map((variant, index) => {
      const packetId = (1000 + slot.order * 2 + index).toString(16).padStart(24, '0');
      const packetPath = join(directory, 'packets', packetId);
      mkdirSync(packetPath, { recursive: true });
      writeFileSync(join(packetPath, 'SYNTHETIC.txt'), 'Synthetic policy packet, no author or browser run.\n');
      const evidenceHash = hash(encode(files(packetPath)));
      writeFileSync(join(packetPath, 'packet.json'), encode({ version: 1, packetId, evidenceHash, humanVerdicts: ['intended-bug', 'qualifying-miss'] }));
      record(join(directory, 'private-joins', `${packetId}.json`), { version: 1, packetId, evidenceHash, id: slot.id, variant: variant.id, bankHash: fixture.bankHash, planHash, terminalHash: returned.terminalHash, submissionHash });
      reviews.push({ version: 1, kind: 'human', packetId, evidenceHash, reviewer: 'Synthetic policy fixture, not a real human judgment', verdict: misses.includes(slot.fixture) ? 'qualifying-miss' : 'intended-bug', reason: 'Exercises policy with synthetic records only.' });
      return { id: variant.id, changed: [fixture.cell(misses.includes(slot.fixture) ? 'passed' : 'failed'), fixture.cell(misses.includes(slot.fixture) ? 'passed' : 'failed')], packet: { packetId, evidenceHash } };
    });
    record(join(directory, 'grades', `${slot.id}.json`), { version: 3, kind: 'connected-baseline-grade', id: slot.id, bankHash: fixture.bankHash, planHash, terminalHash: returned.terminalHash, submissionHash, testHash: hash(returned.testBytes), admission: 'admitted', reason: null, correct: [fixture.cell('passed'), fixture.cell('passed')], members });
  }
  return { reviews, plan, planHash };
}

test('connected CLI isolates historical dispatch and reports all prospective slots', () => {
  const root = mkdtempSync(join(tmpdir(), 'connected-policy-'));
  try {
    const fixture = policyBank(root);
    cli(['prepare', '--study', 'harder-baseline-feasibility'], 1);
    cli(['summarize', '--experiment', fixture.directory]);
    const report = json(join(fixture.directory, 'reports/summary.json')) as { comparisonAuthorized: boolean; scheduledBaseline: number; gate: { order: number }; slots: { state: string }[]; calibration: unknown[] };
    assert.equal(report.comparisonAuthorized, false);
    assert.equal(report.scheduledBaseline, 12);
    assert.equal(report.gate.order, 2);
    assert.deepEqual(report.slots.map(slot => slot.state), Array(12).fill('unstarted'));
    assert.equal(report.calibration.length, 6);
    assert.equal(existsSync(join(fixture.directory, 'plan.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('owned lsof partial rows survive status one while diagnostics and malformed rows fail', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'connected-port-census-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const mode of ['partial', 'diagnostic', 'malformed']) {
      const project = join(root, mode);
      mkdirSync(join(project, 'node_modules/e2e/dist/cli'), { recursive: true });
      writeFileSync(join(project, 'node_modules/e2e/dist/cli/bin.js'), 'setTimeout(() => {}, 1500);\n');
      const output = mode === 'malformed' ? "'qmalformed\\n'" : "'p' + process.argv[process.argv.indexOf('-p') + 1].split(',')[0] + '\\nf3\\nn127.0.0.1:50123\\n'";
      writeFileSync(join(bin, 'lsof'), `#!${process.execPath}\nprocess.stdout.write(${output});\n${mode === 'diagnostic' ? "process.stderr.write('synthetic metadata failure\\n');" : ''}\nprocess.exit(1);\n`);
      chmodSync(join(bin, 'lsof'), 0o755);
      const result = spawnSync(process.execPath, [join(repo, 'apps/test-authoring/connected-cli.ts'), 'supervise-cell', '--project', project, '--deadline-ms', '10000'], { env: { ...process.env, PATH: bin + ':' + process.env.PATH }, encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, mode === 'partial' ? 0 : 2, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
      const receipt = json(join(project, 'process.json')) as { error: string | null; timedOut: boolean; owned: { pid: number; start: string }[]; cleanup: { natural: string; finalizer: string; remaining: unknown[]; portsObserved: { pid: number; start: string; address: string }[] } };
      assert.equal(receipt.timedOut, false);
      assert.equal(receipt.cleanup.finalizer, 'passed');
      assert.deepEqual(receipt.cleanup.remaining, []);
      if (mode === 'partial') {
        assert.equal(receipt.error, null);
        assert.equal(receipt.cleanup.natural, 'passed');
        assert.ok(receipt.cleanup.portsObserved.length > 0);
        assert.ok(receipt.cleanup.portsObserved.every(port => port.address === '127.0.0.1:50123' && receipt.owned.some(identity => identity.pid === port.pid && identity.start === port.start)));
      } else assert.match(receipt.error!, mode === 'diagnostic' ? /Owned port census failed/ : /Malformed owned port census/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('calibration requires all six reconciled sources and seals the exact fixed reserve', () => {
  const root = mkdtempSync(join(tmpdir(), 'connected-calibration-policy-'));
  try {
    const fixture = policyBank(root);
    fixture.calibrationResults();
    const last = fixture.calibration.at(-1)!;
    const terminalPath = join(fixture.directory, 'attempts/calibration', last.id, 'terminal.json');
    const original = json(terminalPath) as Record<string, unknown>;
    record(terminalPath, { ...original, status: 'cutoff', stopReason: 'budget-cutoff', usageComplete: true });
    assert.match(cli(['seal-baseline', '--experiment', fixture.directory], 1).stderr, /No subset calculation/);
    assert.equal(existsSync(join(fixture.directory, 'plan.json')), false);
    record(terminalPath, original);
    const result = cli(['seal-baseline', '--experiment', fixture.directory]);
    const plan = JSON.parse(result.stdout) as { budget: unknown; calibration: unknown[]; runs: unknown[]; comparisonAuthorized: boolean };
    assert.deepEqual(plan.budget, { maxTurns: 32, maxTokens: 500000, wallTimeSeconds: 840 });
    assert.equal(plan.calibration.length, 6);
    assert.equal(plan.runs.length, 12);
    assert.equal(plan.comparisonAuthorized, false);
    const bytes = readFileSync(join(fixture.directory, 'plan.json'));
    cli(['seal-baseline', '--experiment', fixture.directory]);
    assert.deepEqual(readFileSync(join(fixture.directory, 'plan.json')), bytes);
    assert.match(cli(['grade', '--experiment', fixture.directory, '--run', fixture.calibration[0]!.id], 1).stderr, /never calibration/);
    const cal = fixture.calibration[0]!;
    const validation = JSON.parse(cli(['validate-calibration', '--experiment', fixture.directory, '--run', cal.id, '--submission', join(fixture.directory, 'exports/calibration', cal.id)]).stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(validation), ['version', 'kind', 'id', 'bankHash', 'terminalHash', 'submissionHash', 'testHash', 'usage', 'maxResponseTokens', 'correct', 'valid']);
    assert.equal('members' in validation, false);
    record(join(fixture.directory, 'calibration', `${cal.id}.json`), { ...validation, members: [] });
    cli(['seal-baseline', '--experiment', fixture.directory], 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ordered gate keeps human judgments pending and distinguishes ceiling and distributed headroom', () => {
  for (const [misses, order] of [[[], 3], [['addresses'], 5], [['orders', 'wishlist'], 5], [['addresses', 'expenses'], 4]] as [string[], number][]) {
    const root = mkdtempSync(join(tmpdir(), 'connected-gate-policy-'));
    try {
      const fixture = policyBank(root);
      fixture.calibrationResults();
      cli(['seal-baseline', '--experiment', fixture.directory]);
      const { reviews } = policyGrades(fixture, misses);
      cli(['summarize', '--experiment', fixture.directory]);
      let report = json(join(fixture.directory, 'reports/summary.json')) as { gate: { order: number }; usableSlots: number; humanAttributionPending: number; comparisonAuthorized: boolean };
      assert.equal(report.gate.order, 2);
      assert.equal(report.humanAttributionPending, 24);
      const aiPath = join(root, 'ai.json');
      writeFileSync(aiPath, encode(reviews.map(review => ({ version: 1, kind: 'exploratory-ai', packetId: review.packetId, evidenceHash: review.evidenceHash, model: 'synthetic-policy-model', verdict: review.verdict, reason: review.reason }))));
      cli(['summarize', '--experiment', fixture.directory, '--ai-reviews', aiPath]);
      report = json(join(fixture.directory, 'reports/summary.json')) as typeof report;
      assert.equal(report.humanAttributionPending, 24);
      const reviewPath = join(root, 'human.json');
      writeFileSync(reviewPath, encode(reviews));
      cli(['summarize', '--experiment', fixture.directory, '--reviews', reviewPath]);
      report = json(join(fixture.directory, 'reports/summary.json')) as typeof report;
      assert.equal(report.gate.order, order);
      assert.equal(report.usableSlots, 12);
      assert.equal(report.humanAttributionPending, 0);
      assert.equal(report.comparisonAuthorized, false);
      const designPath = join(root, 'design.json');
      writeFileSync(designPath, encode({ version: 1, kind: 'independent-design-review', bankHash: fixture.bankHash, reviewer: 'synthetic-policy-reviewer', verdict: 'rejected', reason: 'Synthetic rejection tests gate precedence.' }));
      cli(['summarize', '--experiment', fixture.directory, '--design-review', designPath]);
      assert.equal((json(join(fixture.directory, 'reports/summary.json')) as typeof report).gate.order, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('cutoff retains six explicit nonexecution cells despite late complete usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'connected-cutoff-policy-'));
  try {
    const fixture = policyBank(root);
    fixture.calibrationResults();
    cli(['seal-baseline', '--experiment', fixture.directory]);
    const plan = json(join(fixture.directory, 'plan.json')) as { budget: { maxTurns: number; maxTokens: number; wallTimeSeconds: number } };
    const slot = fixture.baseline[0]!;
    fixture.terminal(slot, 'baseline', { status: 'cutoff', complete: true, planHash: hash(readFileSync(join(fixture.directory, 'plan.json'))), budget: plan.budget, tokens: 500001, seconds: 10 });
    const grade = JSON.parse(cli(['grade', '--experiment', fixture.directory, '--run', slot.id]).stdout) as { admission: string; correct: { kind: string }[]; members: { changed: { kind: string }[] }[] };
    assert.equal(grade.admission, 'cutoff');
    assert.deepEqual([...grade.correct, ...grade.members.flatMap(member => member.changed)].map(cell => cell.kind), Array(6).fill('not-executed'));
    cli(['summarize', '--experiment', fixture.directory]);
    const report = json(join(fixture.directory, 'reports/summary.json')) as { gate: { order: number }; slots: { state: string; stopReason: string; usage: { tokens: number }; cleanup: { natural: string; finalizer: string } }[] };
    assert.equal(report.gate.order, 2);
    assert.equal(report.slots[0]!.state, 'cutoff');
    assert.equal(report.slots[0]!.stopReason, 'budget-cutoff');
    assert.equal(report.slots[0]!.usage.tokens, 500001);
    assert.deepEqual({ natural: report.slots[0]!.cleanup.natural, finalizer: report.slots[0]!.cleanup.finalizer }, { natural: 'failed', finalizer: 'passed' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('all-slot reporting distinguishes interruptions, incomplete usage, equality and known overrun', () => {
  const root = mkdtempSync(join(tmpdir(), 'connected-slot-policy-'));
  try {
    const fixture = policyBank(root);
    fixture.calibrationResults();
    cli(['seal-baseline', '--experiment', fixture.directory]);
    const plan = json(join(fixture.directory, 'plan.json')) as { budget: { maxTurns: number; maxTokens: number; wallTimeSeconds: number } };
    const planHash = hash(readFileSync(join(fixture.directory, 'plan.json')));
    const interrupted = fixture.baseline[0]!;
    fixture.terminal(interrupted, 'baseline', { planHash, budget: plan.budget, tokens: 10000, seconds: 10 });
    rmSync(join(fixture.directory, 'attempts/baseline', interrupted.id, 'terminal.json'));
    fixture.terminal(fixture.baseline[1]!, 'baseline', { planHash, budget: plan.budget, complete: false, tokens: 10000, seconds: 10 });
    fixture.terminal(fixture.baseline[2]!, 'baseline', { planHash, budget: plan.budget, tokens: 500000, seconds: 10 });
    fixture.terminal(fixture.baseline[3]!, 'baseline', { planHash, budget: plan.budget, tokens: 500001, seconds: 10 });
    fixture.terminal(fixture.baseline[4]!, 'baseline', { planHash, budget: plan.budget, tokens: 10000, seconds: 10, reuseThread: `calibration-${fixture.calibration[0]!.id}` });
    cli(['summarize', '--experiment', fixture.directory]);
    const report = json(join(fixture.directory, 'reports/summary.json')) as { gate: { order: number }; slots: { state: string }[]; scheduledBaseline: number };
    assert.equal(report.gate.order, 2);
    assert.equal(report.scheduledBaseline, 12);
    assert.deepEqual(report.slots.slice(0, 5).map(slot => slot.state), ['started-without-terminal', 'usage-unknown', 'awaiting-grade', 'budget-exceeded', 'terminal-invalid']);
    assert.deepEqual(report.slots.slice(5).map(slot => slot.state), Array(7).fill('unstarted'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pre-model failure preserves its typed cause when the final protected hash is unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'connected-pre-model-failure-'));
  try {
    for (const phase of ['calibration', 'baseline'] as const) {
      const fixture = policyBank(join(root, phase));
      if (phase === 'baseline') {
        fixture.calibrationResults();
        cli(['seal-baseline', '--experiment', fixture.directory]);
      }
      const budget = phase === 'baseline' ? (json(join(fixture.directory, 'plan.json')) as { budget: { maxTurns: number; maxTokens: number; wallTimeSeconds: number } }).budget : { maxTurns: 64, maxTokens: 2000000, wallTimeSeconds: 1200 };
      const planHash = phase === 'baseline' ? hash(readFileSync(join(fixture.directory, 'plan.json'))) : null;
      const slots = phase === 'baseline' ? fixture.baseline : fixture.calibration;
      const slot = slots[0]!;
      const returned = fixture.terminal(slot, phase, { budget, planHash });
      const attempt = join(fixture.directory, 'attempts', phase, slot.id);
      const stdout = `attempts/${phase}/${slot.id}/stdout.jsonl`;
      const cleanup = `attempts/${phase}/${slot.id}/cleanup.json`;
      writeFileSync(join(fixture.directory, stdout), '');
      writeFileSync(join(fixture.directory, cleanup), encode({ synthetic: true, natural: 'unknown', finalizer: 'not-run' }));
      const failure = 'OSError: [Errno 22] Synthetic prepare failure before any model launch';
      record(join(attempt, 'terminal.json'), { ...returned.value, threadId: null, sessionId: null, status: 'launch-failed', stopReason: 'launch-error', failure, usage: { turns: null, tokens: null, wallTimeSeconds: null }, usageComplete: false, maxResponseTokens: null, rawReportedUsage: {}, responses: [], rawEvents: {}, outputs: { [stdout]: hash('') }, protectedInputs: { beforeHash: returned.value.protectedInputs.beforeHash, afterHash: null, unchanged: false }, export: null, cleanup: { natural: 'unknown', finalizer: 'not-run', evidence: { [cleanup]: hash(readFileSync(join(fixture.directory, cleanup))) } } });
      cli(['summarize', '--experiment', fixture.directory]);
      const report = json(join(fixture.directory, 'reports/summary.json')) as { gate: { order: number }; comparisonAuthorized: boolean; calibration: { state: string; stopReason: string; reason: string; valid: boolean }[]; slots: { state: string; stopReason: string; reason: string }[] };
      const observed = phase === 'calibration' ? report.calibration[0]! : report.slots[0]!;
      assert.equal(observed.state, 'launch-failed');
      assert.equal(observed.stopReason, 'launch-error');
      assert.equal(observed.reason, failure);
      assert.equal(report.gate.order, 2);
      assert.equal(report.comparisonAuthorized, false);
      assert.equal(report.calibration.length, 6);
      assert.equal(report.slots.length, 12);
      assert.equal(report.slots.filter(item => item.state === 'unstarted').length, phase === 'calibration' ? 12 : 11);
      if (phase === 'calibration') {
        const validation = JSON.parse(cli(['validate-calibration', '--experiment', fixture.directory, '--run', slot.id, '--submission', returned.exportPath], 1).stdout) as { valid: boolean; testHash: string | null; correct: { kind: string }[] };
        assert.equal(validation.valid, false);
        assert.equal(validation.testHash, null);
        assert.deepEqual(validation.correct.map(cell => cell.kind), Array(2).fill('not-executed'));
        cli(['seal-baseline', '--experiment', fixture.directory], 1);
        assert.equal(existsSync(join(fixture.directory, 'plan.json')), false);
      } else {
        const grade = JSON.parse(cli(['grade', '--experiment', fixture.directory, '--run', slot.id]).stdout) as { admission: string; testHash: string | null; correct: { kind: string }[]; members: { changed: { kind: string }[] }[] };
        assert.equal(grade.admission, 'rejected');
        assert.equal(grade.testHash, null);
        assert.deepEqual([...grade.correct, ...grade.members.flatMap(member => member.changed)].map(cell => cell.kind), Array(6).fill('not-executed'));
      }
      const incomplete = slots[1]!;
      const completed = fixture.terminal(incomplete, phase, { budget, planHash });
      record(join(fixture.directory, 'attempts', phase, incomplete.id, 'terminal.json'), { ...completed.value, protectedInputs: { ...completed.value.protectedInputs, afterHash: null, unchanged: true } });
      cli(['summarize', '--experiment', fixture.directory]);
      const rejected = json(join(fixture.directory, 'reports/summary.json')) as { calibration: { state: string; reason: string }[]; slots: { state: string; reason: string }[] };
      assert.equal((phase === 'calibration' ? rejected.calibration[1]! : rejected.slots[1]!).state, phase === 'calibration' ? 'record-invalid' : 'terminal-invalid');
      assert.match((phase === 'calibration' ? rejected.calibration[1]! : rejected.slots[1]!).reason, /Incomplete successful terminal/);
      assert.equal(existsSync(join(fixture.directory, 'submissions', incomplete.id)), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('repeat disagreement and changed exact bytes cannot receive usable suite credit', () => {
  const root = mkdtempSync(join(tmpdir(), 'connected-immutable-policy-'));
  try {
    const fixture = policyBank(root);
    fixture.calibrationResults();
    cli(['seal-baseline', '--experiment', fixture.directory]);
    const { reviews } = policyGrades(fixture);
    const reviewFile = join(root, 'human.json');
    writeFileSync(reviewFile, encode(reviews));
    const slot = fixture.baseline[0]!;
    const gradeFile = join(fixture.directory, 'grades', `${slot.id}.json`);
    const grade = json(gradeFile) as { members: { changed: unknown[] }[] };
    grade.members[0]!.changed[1] = fixture.cell('passed');
    record(gradeFile, grade);
    cli(['summarize', '--experiment', fixture.directory, '--reviews', reviewFile]);
    const report = json(join(fixture.directory, 'reports/summary.json')) as { gate: { order: number }; slots: { state: string; fractionDetected: number | null; detected: number }[] };
    assert.equal(report.gate.order, 2);
    assert.equal(report.slots[0]!.state, 'inconsistent');
    assert.equal(report.slots[0]!.fractionDetected, null);
    assert.equal(report.slots[0]!.detected, 0);
    const returned = join(fixture.directory, 'exports/baseline', slot.id);
    writeFileSync(join(returned, 'tests/requirement.e2e.ts'), '// Changed exact bytes after initial import.\n');
    assert.match(cli(['grade', '--experiment', fixture.directory, '--run', slot.id, '--submission', returned], 1).stderr, /submitted bytes changed/);
    const packet = reviews[0]!;
    writeFileSync(join(fixture.directory, 'packets', packet.packetId, 'SYNTHETIC.txt'), 'Changed packet evidence.\n');
    assert.match(cli(['summarize', '--experiment', fixture.directory], 1).stderr, /packet bytes changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a post-write receipt failure vetoes completed calibration and baseline bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'connected-receipt-policy-'));
  try {
    const calibrationFixture = policyBank(join(root, 'calibration'));
    calibrationFixture.calibrationResults();
    const last = calibrationFixture.calibration.at(-1)!;
    writeFileSync(join(calibrationFixture.directory, 'attempts/calibration', last.id, 'receipt-failure.json'), '');
    assert.match(cli(['seal-baseline', '--experiment', calibrationFixture.directory], 1).stderr, /receipt-failure/);
    assert.equal(existsSync(join(calibrationFixture.directory, 'plan.json')), false);
    cli(['validate-calibration', '--experiment', calibrationFixture.directory, '--run', last.id, '--submission', join(calibrationFixture.directory, 'exports/calibration', last.id)], 1);
    cli(['summarize', '--experiment', calibrationFixture.directory]);
    const calibrationReport = json(join(calibrationFixture.directory, 'reports/summary.json')) as { calibration: { state: string }[]; gate: { order: number } };
    assert.equal(calibrationReport.calibration.at(-1)!.state, 'receipt-failed');
    assert.equal(calibrationReport.gate.order, 2);
    const baselineFixture = policyBank(join(root, 'baseline'));
    baselineFixture.calibrationResults();
    cli(['seal-baseline', '--experiment', baselineFixture.directory]);
    const plan = json(join(baselineFixture.directory, 'plan.json')) as { budget: { maxTurns: number; maxTokens: number; wallTimeSeconds: number } };
    const slot = baselineFixture.baseline[0]!;
    baselineFixture.terminal(slot, 'baseline', { budget: plan.budget, planHash: hash(readFileSync(join(baselineFixture.directory, 'plan.json'))), tokens: 10000, seconds: 10 });
    writeFileSync(join(baselineFixture.directory, 'attempts/baseline', slot.id, 'receipt-failure.json'), '{"synthetic":"post-write failure"}\n');
    const grade = JSON.parse(cli(['grade', '--experiment', baselineFixture.directory, '--run', slot.id]).stdout) as { admission: string; correct: { kind: string }[]; members: { changed: { kind: string }[] }[] };
    assert.equal(grade.admission, 'rejected');
    assert.deepEqual([...grade.correct, ...grade.members.flatMap(member => member.changed)].map(cell => cell.kind), Array(6).fill('not-executed'));
    cli(['summarize', '--experiment', baselineFixture.directory]);
    const baselineReport = json(join(baselineFixture.directory, 'reports/summary.json')) as { slots: { state: string }[]; gate: { order: number } };
    assert.equal(baselineReport.slots[0]!.state, 'receipt-failed');
    assert.equal(baselineReport.gate.order, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('admission and phase publication failures veto canonical passes and retain the complete schedule', () => {
  for (const marker of ['operator/admission-failure.json', 'attempts/calibration/evidence-failure.json', 'attempts/baseline/evidence-failure.json']) {
    const root = mkdtempSync(join(tmpdir(), 'connected-publication-policy-'));
    try {
      const fixture = policyBank(root);
      fixture.calibrationResults();
      if (marker.includes('baseline')) {
        cli(['seal-baseline', '--experiment', fixture.directory]);
        policyGrades(fixture);
      }
      mkdirSync(join(fixture.directory, marker, '..'), { recursive: true });
      writeFileSync(join(fixture.directory, marker), 'malformed synthetic failure marker');
      cli(['seal-baseline', '--experiment', fixture.directory], 1);
      cli(['summarize', '--experiment', fixture.directory]);
      const report = json(join(fixture.directory, 'reports/summary.json')) as { gate: { order: number }; operatorFailures: { path: string; hash: string }[]; slots: { state: string }[]; calibration: { state: string; valid: boolean }[] };
      assert.equal(report.gate.order, 2);
      assert.deepEqual(report.operatorFailures, [{ path: marker, hash: hash('malformed synthetic failure marker') }]);
      assert.equal(report.slots.length, 12);
      assert.equal(report.calibration.length, 6);
      if (marker.includes('baseline')) {
        assert.deepEqual(report.slots.map(slot => slot.state), Array(12).fill('phase-evidence-failed'));
        cli(['grade', '--experiment', fixture.directory, '--run', fixture.baseline[0]!.id], 1);
      } else {
        assert.deepEqual(report.slots.map(slot => slot.state), Array(12).fill('unstarted'));
        assert.deepEqual(report.calibration.map(slot => slot.state), Array(6).fill(marker.startsWith('operator') ? 'admission-failed' : 'phase-evidence-failed'));
        assert.deepEqual(report.calibration.map(slot => slot.valid), Array(6).fill(false));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
