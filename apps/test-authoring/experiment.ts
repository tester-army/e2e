import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseSync } from 'oxc-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { controlTest, fixtures, projectFiles, task, treatment, type Fixture } from './corpus.ts';
import { bundle, command, copy, encode, freeze, hash, json, repo, tree } from './files.ts';

const text = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = z.string().regex(/^[a-f0-9]{24}$/);
const budget = z.object({ maxTurns: z.number().int().positive(), maxTokens: z.number().int().positive(), wallTimeSeconds: z.number().int().positive() }).strict();
const author = z.object({ model: text, launcher: z.object({ name: text, version: text }).strict(), settings: z.record(z.string(), z.json()), tools: z.array(text).min(1), budget, unsupportedSamplingControls: z.array(text), isolation: z.enum(['externally-enforced', 'cooperative-only']) }).strict();
const settings = z.object({ purpose: z.enum(['pilot', 'synthetic-controls']), allocationSeed: z.number().int().min(1).max(0xffffffff), author }).strict();
const usage = z.object({ turns: z.number().int().nonnegative().nullable(), tokens: z.number().int().nonnegative().nullable(), wallTimeSeconds: z.number().nonnegative().nullable() }).strict();
const usageMetrics = ['turns', 'tokens', 'wallTimeSeconds'] as const;
const budgetStatus = z.discriminatedUnion('kind', [z.object({ kind: z.literal('within') }).strict(), z.object({ kind: z.literal('exceeded'), metrics: z.array(z.enum(usageMetrics)).min(1) }).strict(), z.object({ kind: z.literal('unknown'), metrics: z.array(z.enum(usageMetrics)).min(1) }).strict()]);
const authoringResult = z.discriminatedUnion('kind', [z.object({ kind: z.literal('session'), usage, budget: budgetStatus }).strict(), z.object({ kind: z.literal('synthetic-control') }).strict()]);
const record = z.object({ settingsHash: digest, sessionId: text, attested: z.object({ freshSession: z.literal(true), projectOnly: z.literal(true), author }).strict(), observed: z.object({ model: text.optional(), settings: z.record(z.string(), z.json()).optional(), tools: z.array(text).optional(), budget: budget.optional(), usage: usage.optional() }).strict(), transcript: z.literal('transcript.jsonl').optional() }).strict();
const run = z.object({ id: opaque, fixture: text, arm: z.enum(['current', 'inspect-lower-tests']), pair: z.number().int(), order: z.number().int(), project: text, commonHash: digest, projectHash: digest }).strict();
const planSchema = z.object({ version: z.literal(1), fingerprint: digest, settings, settingsHash: digest, pins: z.record(z.string(), z.json()), runtimeHash: digest, runs: z.array(run).length(40), snapshots: z.record(z.string(), digest) }).strict();
type Plan = z.infer<typeof planSchema>;
type PlannedRun = z.infer<typeof run>;
const execution = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('passed'), report: text, selected: z.number().int().positive(), selectionHash: digest }).strict(),
  z.object({ kind: z.literal('failed'), report: text, selected: z.number().int().positive(), selectionHash: digest }).strict(),
  z.object({ kind: z.literal('unusable'), reason: text, evidence: text }).strict(),
]);
type Execution = z.infer<typeof execution>;
const gradeSchema = z.object({ run: opaque, submissionHash: digest, correct: execution, mutant: execution, packetId: opaque, evidenceHash: digest, synthetic: z.boolean(), authoring: authoringResult }).strict();
type Grade = z.infer<typeof gradeSchema>;
const judgment = z.object({ packetId: opaque, evidenceHash: digest, reviewer: text, verdict: z.enum(['intended-bug', 'unrelated-failure', 'uncertain']), reason: text, synthetic: z.boolean() }).strict();
type Judgment = z.infer<typeof judgment>;
type Outcome = { kind: 'pending'; stage: 'authoring' | 'execution' | 'review' | 'budget' } | { kind: 'invalid'; reason: string } | { kind: 'missed' } | { kind: 'detected'; judgment: Judgment };
const id = () => randomBytes(12).toString('hex');
const decisionFields = ['packetId', 'evidenceHash', 'reviewer', 'verdict', 'reason', 'synthetic'];

/** Reads sealed grading results and checks the evidence the reviewer receives. */
function readGrade(directory: string, runId: string): Grade {
  const bytes = readFileSync(join(directory, 'grades', `${runId}.json`));
  if (hash(bytes) !== readFileSync(join(directory, 'grades', `${runId}.sha256`), 'utf8').trim()) throw new Error('Grade bytes changed');
  const result = gradeSchema.parse(JSON.parse(bytes.toString()));
  const packetDirectory = join(directory, 'packets', result.packetId);
  if (readFileSync(join(packetDirectory, 'packet.json'), 'utf8') !== encode({ packetId: result.packetId, evidenceHash: result.evidenceHash, decisionFields })) throw new Error('Review packet index changed');
  const files = tree(packetDirectory);
  delete files['packet.json'];
  if (hash(encode(files)) !== result.evidenceHash) throw new Error('Review packet bytes changed');
  if (hash(encode(tree(join(directory, 'submissions', runId)))) !== result.submissionHash) throw new Error('Frozen submission bytes changed');
  return result;
}

/** Pins repository content, including untracked implementation files, without relying on a dirty flag. */
function repositoryPins() {
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  const paths = git(['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean).toSorted();
  return { revision: git(['rev-parse', 'HEAD']).trim(), worktreeHash: hash(encode(paths.map(path => [path, hash(lstatSync(join(repo, path)).isSymbolicLink() ? readlinkSync(join(repo, path)) : readFileSync(join(repo, path)))]))), lockHash: hash(readFileSync(join(repo, 'pnpm-lock.yaml'))) };
}

/** Loads the frozen plan and rejects changed plan bytes or runtime dependencies. */
function load(directory: string): Plan {
  const bytes = readFileSync(join(directory, 'plan.json'));
  if (hash(bytes) !== readFileSync(join(directory, 'plan.sha256'), 'utf8').trim()) throw new Error('Plan bytes changed');
  const plan = planSchema.parse(JSON.parse(bytes.toString()));
  if (plan.pins.node !== process.version) throw new Error('Node version differs from preparation');
  if (hash(encode(tree(join(directory, 'runtime')))) !== plan.runtimeHash) throw new Error('Runtime bundle changed');
  if (plan.pins.corpusHash !== hash(encode(fixtures))) throw new Error('Fixture registry changed since preparation');
  return plan;
}

/** Freezes forty fresh authoring projects. No model or paid service is started. */
export async function prepare(directory: string, settingsFile: string): Promise<Plan> {
  directory = resolve(directory);
  if (!relative(repo, directory).startsWith('..')) throw new Error('Prepare outside the repository');
  const declared = settings.parse(json(settingsFile));
  const skill = tree(join(repo, 'skills/e2e'));
  const pins = { ...repositoryPins(), declaredSettingsFileHash: hash(readFileSync(settingsFile)), node: process.version, platform: process.platform, architecture: process.arch, fullSkillHash: hash(encode(skill)), commonTaskHash: hash(task), treatmentHash: hash(treatment), corpusHash: hash(encode(fixtures)), builtE2EHash: hash(encode(tree(join(repo, 'packages/e2e/dist')))), builtWebHash: hash(encode(tree(join(repo, 'packages/web/dist')))) };
  const fingerprint = hash(encode({ declared, pins }));
  if (existsSync(join(directory, 'plan.json'))) {
    const previous = load(directory);
    if (previous.fingerprint !== fingerprint) throw new Error('Conflicting preparation inputs. Use a new directory');
    for (const entry of previous.runs) if (hash(encode(tree(join(directory, 'author', entry.id, entry.project)))) !== entry.projectHash) throw new Error('Prepared project changed');
    return previous;
  }
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('Output directory must be empty');
  mkdirSync(directory, { recursive: true });
  bundle(join(directory, 'runtime'));
  const playwright = await import(pathToFileURL(join(repo, 'packages/web/node_modules/playwright-core/index.mjs')).href);
  const browser = await playwright.chromium.launch({ headless: true });
  const browserVersion: string = browser.version();
  await browser.close();
  const runtimeHash = hash(encode(tree(join(directory, 'runtime'))));
  const snapshots: Record<string, string> = {};
  for (const fixture of fixtures) {
    const project = join(directory, 'snapshots', fixture.id);
    const files = projectFiles(fixture);
    const manifest = JSON.parse(files['package.json']!) as Record<string, unknown>;
    manifest.devDependencies = Object.fromEntries(['e2e', 'web'].map(name => {
      const installed = json(join(repo, 'packages', name, 'package.json')) as { name: string; version: string };
      return [installed.name, installed.version];
    }));
    files['package.json'] = encode(manifest);
    for (const [path, content] of Object.entries(files)) freeze(join(project, path), content);
    copy(join(repo, 'skills/e2e'), join(project, '.agents/skills/e2e'));
    const lower = command(project, process.execPath, ['--test', 'lower/rules.test.mjs']);
    freeze(join(directory, 'lower-checks', `${fixture.id}.txt`), `${lower.stdout}${lower.stderr}`);
    if (lower.status !== fixture.lowerExit || !/tests 1\b/.test(lower.stdout)) throw new Error(`Unexpected lower-test status for ${fixture.id}`);
    snapshots[fixture.id] = hash(encode(tree(project)));
  }
  let state = declared.allocationSeed;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
  const pairs = fixtures.flatMap((fixture, fixtureIndex) => Array.from({ length: 5 }, (_, repetition) => ({ fixture, reverse: (fixtureIndex + repetition) % 2 === 1, pair: fixtureIndex * 5 + repetition })));
  for (let index = pairs.length - 1; index > 0; index--) { const swap = Math.floor(random() * (index + 1)); [pairs[index], pairs[swap]] = [pairs[swap]!, pairs[index]!]; }
  const runs: PlannedRun[] = [];
  for (const pair of pairs) {
    const arms = pair.reverse ? ['inspect-lower-tests', 'current'] as const : ['current', 'inspect-lower-tests'] as const;
    for (const arm of arms) {
      const runId = id();
      const project = join(directory, 'author', runId, pair.fixture.name);
      copy(join(directory, 'snapshots', pair.fixture.id), project);
      if (arm === 'inspect-lower-tests') writeFileSync(join(project, '.agents/skills/e2e/SKILL.md'), readFileSync(join(project, '.agents/skills/e2e/SKILL.md'), 'utf8') + treatment);
      copy(join(directory, 'runtime'), join(project, 'node_modules'));
      const manifest = tree(project);
      const common = Object.fromEntries(Object.entries(manifest).filter(([path]) => path !== '.agents/skills/e2e/SKILL.md'));
      runs.push({ id: runId, fixture: pair.fixture.id, arm, pair: pair.pair, order: runs.length, project: pair.fixture.name, commonHash: hash(encode(common)), projectHash: hash(encode(manifest)) });
    }
  }
  const plan = planSchema.parse({ version: 1, fingerprint, settings: declared, settingsHash: hash(encode(declared)), pins: { ...pins, browserVersion, expectedLowerTestExit: Object.fromEntries(fixtures.map(f => [f.id, f.lowerExit])) }, runtimeHash, runs, snapshots });
  freeze(join(directory, 'plan.json'), encode(plan));
  freeze(join(directory, 'plan.sha256'), hash(encode(plan)) + '\n');
  return plan;
}

/** Applies a bounded syntactic contract. This check is not a security boundary. */
function guard(source: string): void {
  if (Buffer.byteLength(source) > 64000) throw new Error('Submission exceeds 64 KB');
  const parsed = parseSync('requirement.e2e.ts', source);
  if (parsed.errors.length) throw new Error('Submission is not valid TypeScript');
  const forbidden = new Set(['process', 'globalThis', 'global', 'require', 'module', 'exports', 'eval', 'Function', 'fetch', 'WebSocket', 'XMLHttpRequest', 'Bun', 'Deno', 'agent', 'window', 'document', 'navigator']);
  const properties = new Set(['constructor', '__proto__', 'prototype', 'skip', 'only', 'todo', 'fixme', 'extend', 'use', 'setup', 'configure', 'evaluate', 'route', 'request', 'initScripts']);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, unknown>;
    if (node.type === 'ImportDeclaration') {
      const imported = (node.source as { value: string }).value;
      if (!['e2e', '@e2e-dev/web'].includes(imported)) throw new Error('Only public E2E imports are allowed');
      for (const specifier of node.specifiers as { type: string; imported?: { name: string }; local: { name: string } }[]) {
        if (specifier.type !== 'ImportSpecifier' || specifier.imported?.name !== (imported === 'e2e' ? 'expect' : 'test') || specifier.local.name !== specifier.imported?.name) throw new Error('Only unaliased test from web and expect from e2e are allowed');
      }
    }
    if (['ImportExpression', 'MetaProperty', 'WithStatement'].includes(String(node.type))) throw new Error('Dynamic loading is excluded');
    if (node.type === 'Identifier' && forbidden.has(String(node.name))) throw new Error(`Excluded identifier ${node.name}`);
    if (node.type === 'MemberExpression') {
      const property = node.property as { name?: string; value?: string };
      if (node.computed || properties.has(property.name ?? property.value ?? '')) throw new Error('Excluded member access');
    }
    Object.values(node).forEach(visit);
  };
  visit(parsed.program);
}

const errorSchema = z.object({ category: text, code: text, phase: text.optional() }).passthrough();
const reportSchema = z.object({ schemaVersion: z.literal('report-1'), run: z.object({ status: text, exitCode: z.number().int(), errors: z.array(errorSchema), summary: z.object({ selected: z.number().int(), executed: z.number().int(), skipped: z.number().int() }).passthrough(), usage: z.object({ modelTokens: z.number(), maxModelCallsInStep: z.number() }).passthrough(), results: z.array(z.object({ id: digest, kind: text, status: text, selected: z.boolean().optional(), attempts: z.array(z.object({ status: text, cleanup: text, secondaryErrors: z.array(errorSchema), error: errorSchema.optional() }).passthrough()) }).passthrough()) }).passthrough() }).passthrough();

/** Runs exact submitted bytes through the copied built CLI on one fresh project. */
function execute(directory: string, fixture: Fixture, source: string, mutant: boolean, brokenServer = false): Execution {
  const project = join(directory, 'work', id());
  copy(join(directory, 'snapshots', fixture.id), project);
  copy(join(directory, 'runtime'), join(project, 'node_modules'));
  freeze(join(project, 'tests/requirement.e2e.ts'), source);
  if (brokenServer) writeFileSync(join(project, 'server.mjs'), "throw new Error('synthetic broken server');\n");
  if (mutant) {
    const path = join(project, 'mutationFile' in fixture ? fixture.mutationFile : 'app.js');
    const original = readFileSync(path, 'utf8');
    if (original.split(fixture.mutation[0]).length !== 2) throw new Error('Mutation must have exactly one target');
    writeFileSync(path, original.replace(fixture.mutation[0], fixture.mutation[1]));
  }
  const result = command(project, process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'run', '--workers', '1', '--retries', '0', '--no-cache', '--output', '.e2e', '--reporter', 'json'], 45000);
  freeze(join(project, 'stdout.txt'), result.stdout ?? '');
  freeze(join(project, 'stderr.txt'), result.stderr ?? '');
  const evidence = relative(directory, project);
  if (result.error) return { kind: 'unusable', reason: result.error.message, evidence };
  const report = join(project, '.e2e/report.json');
  if (!existsSync(report)) return { kind: 'unusable', reason: 'no-report', evidence };
  let raw: unknown;
  try { raw = json(report); } catch { return { kind: 'unusable', reason: 'bad-report', evidence }; }
  const validateReport = new Ajv2020({ strict: false, validateFormats: false }).compile(json(join(project, 'node_modules/e2e/schema/report-v1.schema.json')) as Record<string, unknown>);
  if (!validateReport(raw)) return { kind: 'unusable', reason: 'bad-report', evidence };
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'unusable', reason: 'bad-report', evidence };
  const value = parsed.data.run;
  const selected = value.results.filter(entry => entry.selected !== false);
  if (!selected.length || value.summary.selected !== selected.length || value.summary.executed !== selected.length) return { kind: 'unusable', reason: 'no-tests', evidence };
  if (new Set(selected.map(entry => entry.id)).size !== selected.length || value.usage.modelTokens || value.usage.maxModelCallsInStep) return { kind: 'unusable', reason: 'duplicate-tests-or-runtime-model', evidence };
  if (value.errors.length || value.summary.skipped || selected.some(entry => entry.kind !== 'test' || !['passed', 'failed'].includes(entry.status) || entry.attempts.length !== 1 || entry.attempts.some(attempt => attempt.cleanup !== 'complete' || attempt.secondaryErrors.length || !['passed', 'failed'].includes(attempt.status) || (attempt.error && (attempt.error.category !== 'test' || attempt.error.phase !== 'body'))))) return { kind: 'unusable', reason: 'run-error-setup-skip-or-timeout', evidence };
  const selectionHash = hash(encode(selected.map(entry => entry.id).toSorted()));
  if (value.status === 'passed' && result.status === 0 && value.exitCode === 0 && selected.every(entry => entry.status === 'passed')) return { kind: 'passed', report: relative(directory, report), selected: selected.length, selectionHash };
  if (value.status === 'failed' && result.status === 1 && value.exitCode === 1 && selected.some(entry => entry.status === 'failed')) return { kind: 'failed', report: relative(directory, report), selected: selected.length, selectionHash };
  return { kind: 'unusable', reason: 'inconsistent-report', evidence };
}

/** Compares launcher observations to the declared limits without filling in missing measurements. */
function authoringUsage(observed: z.infer<typeof usage> | undefined, limits: z.infer<typeof budget>): Extract<z.infer<typeof authoringResult>, { kind: 'session' }> {
  const measured = observed ?? { turns: null, tokens: null, wallTimeSeconds: null };
  const maxima = { turns: limits.maxTurns, tokens: limits.maxTokens, wallTimeSeconds: limits.wallTimeSeconds };
  const exceeded = usageMetrics.filter(metric => measured[metric] !== null && measured[metric]! > maxima[metric]);
  const missing = usageMetrics.filter(metric => measured[metric] === null);
  return { kind: 'session', usage: measured, budget: exceeded.length ? { kind: 'exceeded', metrics: exceeded } : missing.length ? { kind: 'unknown', metrics: missing } : { kind: 'within' } };
}

/** Joins execution with a separate human decision. An error code never earns credit. */
function classify(graded?: Grade, review?: Judgment): Outcome {
  if (!graded) return { kind: 'pending', stage: 'authoring' };
  if (graded.authoring.kind === 'session' && graded.authoring.budget.kind === 'exceeded') return { kind: 'invalid', reason: 'authoring-budget-exceeded' };
  if (graded.correct.kind === 'unusable' && graded.correct.reason.startsWith('submission-contract')) return { kind: 'invalid', reason: graded.correct.reason };
  if (graded.correct.kind === 'unusable' || graded.mutant.kind === 'unusable') return { kind: 'pending', stage: 'execution' };
  if (graded.correct.kind !== 'passed') return { kind: 'invalid', reason: 'correct-app-failed' };
  if (graded.correct.selectionHash !== graded.mutant.selectionHash) return { kind: 'invalid', reason: 'selected-tests-changed' };
  if (graded.mutant.kind === 'passed') return { kind: 'missed' };
  if (!review) return { kind: 'pending', stage: 'review' };
  if (review.packetId !== graded.packetId || review.evidenceHash !== graded.evidenceHash || review.synthetic !== graded.synthetic) throw new Error('Judgment does not match frozen evidence');
  if (review.verdict !== 'intended-bug') return { kind: 'missed' };
  if (graded.authoring.kind === 'session' && graded.authoring.budget.kind === 'unknown') return { kind: 'pending', stage: 'budget' };
  return { kind: 'detected', judgment: review };
}

/** Builds an arm-blind packet from exact test bytes and execution evidence. */
function packet(directory: string, source: string, fixture: Fixture, correct: Execution, mutant: Execution) {
  const packetId = id();
  const destination = join(directory, 'packets', packetId);
  freeze(join(destination, 'requirement.txt'), fixture.requirement + '\n');
  freeze(join(destination, 'requirement.e2e.ts'), source);
  for (const [label, outcome] of [['correct', correct], ['changed', mutant]] as const) {
    const project = join(directory, outcome.kind === 'unusable' ? outcome.evidence : join(outcome.report, '../..'));
    for (const path of ['.e2e', 'stdout.txt', 'stderr.txt']) if (existsSync(join(project, path))) copy(join(project, path), join(destination, label, path));
  }
  for (const path of Object.keys(tree(destination)).filter(key => /\.(json|txt|md|log)$/.test(key))) {
    const file = join(destination, path);
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll(realpathSync(directory), '[experiment]').replaceAll(resolve(directory), '[experiment]').replaceAll(repo, '[repository]'));
  }
  const evidenceHash = hash(encode(tree(destination)));
  freeze(join(destination, 'packet.json'), encode({ packetId, evidenceHash, decisionFields }));
  return { packetId, evidenceHash };
}

/** Imports a submission once and preserves the author's exact bytes before executing it. */
export function grade(directory: string, runId: string, submission: string): Grade {
  const plan = load(directory);
  const entry = plan.runs.find(value => value.id === runId);
  if (!entry) throw new Error('Unknown run ID');
  const fixture = fixtures.find(value => value.id === entry.fixture)!;
  if (hash(encode(tree(join(directory, 'snapshots', fixture.id)))) !== plan.snapshots[fixture.id]) throw new Error('Fixture snapshot changed');
  const publicFiles = tree(join(directory, 'author', entry.id, entry.project));
  for (const path of Object.keys(publicFiles)) if (path === 'tests/requirement.e2e.ts' || path === 'authoring.json' || path === 'transcript.jsonl' || path.startsWith('.e2e/') || path.startsWith('.home/')) delete publicFiles[path];
  if (hash(encode(publicFiles)) !== entry.projectHash) throw new Error('Protected author project files changed');
  const paths = tree(submission);
  if (Object.keys(paths).some(path => !['tests/requirement.e2e.ts', 'authoring.json', 'transcript.jsonl'].includes(path))) throw new Error('Return only the test, authoring record, and optional transcript');
  const source = readFileSync(join(submission, 'tests/requirement.e2e.ts'), 'utf8');
  if (!readFileSync(join(submission, 'tests/requirement.e2e.ts')).equals(Buffer.from(source))) throw new Error('Submission must be valid UTF-8');
  const authoring = record.parse(json(join(submission, 'authoring.json')));
  if (authoring.settingsHash !== plan.settingsHash || !isDeepStrictEqual(authoring.attested.author, plan.settings.author)) throw new Error('Author declaration differs from the plan');
  if (authoring.observed.model && authoring.observed.model !== plan.settings.author.model) throw new Error('Observed author model differs from the plan');
  for (const field of ['settings', 'tools', 'budget'] as const) if (authoring.observed[field] && !isDeepStrictEqual(authoring.observed[field], plan.settings.author[field])) throw new Error(`Observed author ${field} differs from the plan`);
  if (Boolean(authoring.transcript) !== existsSync(join(submission, 'transcript.jsonl'))) throw new Error('Transcript declaration mismatch');
  const submissionHash = hash(encode(paths));
  const destination = join(directory, 'submissions', runId);
  if (existsSync(destination)) {
    if (hash(encode(tree(destination))) !== submissionHash) throw new Error('Conflicting submission for immutable run');
    if (existsSync(join(directory, 'grades', `${runId}.json`))) return readGrade(directory, runId);
  } else {
    for (const other of plan.runs) {
      const path = join(directory, 'submissions', other.id, 'authoring.json');
      if (existsSync(path) && record.parse(json(path)).sessionId === authoring.sessionId) throw new Error('Fresh session ID already used');
    }
    copy(submission, destination);
  }
  let rejected: string | undefined;
  try { guard(source); } catch (error) { rejected = `submission-contract: ${error instanceof Error ? error.message : error}`; }
  const correct: Execution = rejected ? { kind: 'unusable', reason: rejected, evidence: relative(directory, destination) } : execute(directory, fixture, source, false);
  const mutant: Execution = rejected ? correct : execute(directory, fixture, source, true);
  const result = { run: runId, submissionHash, correct, mutant, ...packet(directory, source, fixture, correct, mutant), synthetic: plan.settings.purpose === 'synthetic-controls', authoring: authoringUsage(authoring.observed.usage, plan.settings.author.budget) };
  freeze(join(directory, 'grades', `${runId}.json`), encode(result));
  freeze(join(directory, 'grades', `${runId}.sha256`), hash(encode(result)) + '\n');
  return result;
}

/** Exercises the same built runner with synthetic controls outside the pilot allocation. */
export function controls(directory: string, fixtureFilter?: string): unknown[] {
  load(directory);
  if (fixtureFilter && !fixtures.some(value => value.id === fixtureFilter)) throw new Error('Unknown fixture filter');
  const results: unknown[] = [];
  for (const fixture of fixtures.filter(value => !fixtureFilter || value.id === fixtureFilter)) {
    const cases: [string, string][] = [
      ['strong', controlTest(fixture.strong)],
      ['weak', controlTest("await expect(screen.getByRole('heading')).toBeVisible();")],
      ['throw', controlTest("throw new Error('synthetic unconditional failure');")],
      ['unrelated', controlTest("await expect(screen.getByRole('button', 'Nonexistent action')).toBeVisible();")],
      ['empty', "import { test } from '@e2e-dev/web';\n"],
      ['broken-server', controlTest("await expect(screen.getByRole('heading')).toBeVisible();")],
    ];
    if (fixture.id === 'cart') cases.push(
      ['skip', controlTest("test.skip('synthetic skipped test');")],
      ['setup', controlTest("await expect(screen.getByRole('heading')).toBeVisible();").replace("test('current", "test.beforeEach(() => { throw new Error('synthetic setup failure'); });\ntest('current")],
      ['timeout', controlTest('await new Promise(() => {});').replace("test('current user requirement', async", "test('current user requirement', { timeout: 25 }, async")],
    );
    for (const [name, source] of cases) {
      if (name !== 'skip') guard(source);
      const correct = execute(directory, fixture, source, false, name === 'broken-server');
      const mutant = execute(directory, fixture, source, true, name === 'broken-server');
      const frozen = packet(directory, source, fixture, correct, mutant);
      const graded: Grade = { run: id(), submissionHash: hash(source), correct, mutant, ...frozen, synthetic: true, authoring: { kind: 'synthetic-control' } };
      const decision: Judgment = { ...frozen, reviewer: 'synthetic-control', verdict: 'intended-bug', reason: `Synthetic plumbing only. The strong control checks ${fixture.expected}.`, synthetic: true };
      const beforeReview = classify(graded);
      const outcome = classify(graded, decision);
      const expected = name === 'strong' ? 'detected' : ['empty', 'broken-server', 'skip', 'setup', 'timeout'].includes(name) ? 'pending' : name === 'weak' ? 'missed' : 'invalid';
      if (outcome.kind !== expected || (name === 'strong' && (beforeReview.kind !== 'pending' || correct.kind !== 'passed' || mutant.kind !== 'failed'))) throw new Error(`Control ${fixture.id}/${name} differed. ${encode({ correct, mutant, outcome })}`);
      if (name === 'strong' && mutant.kind === 'failed') {
        const report = reportSchema.parse(json(join(directory, mutant.report)));
        if (!report.run.results.some(value => value.attempts.some(attempt => attempt.error?.code === 'ASSERTION_FAILED')) || !readFileSync(join(directory, mutant.report), 'utf8').includes(fixture.expected)) throw new Error('Strong control did not reach its expected UI assertion');
        for (const verdict of ['unrelated-failure', 'uncertain'] as const) if (classify(graded, { ...decision, verdict }).kind !== 'missed') throw new Error('Non-intended judgment received credit');
      }
      results.push({ fixture: fixture.id, control: name, synthetic: true, correct, mutant, beforeReview, outcome });
    }
  }
  freeze(join(directory, 'controls', `${id()}.json`), encode(results));
  return results;
}

/** Reports fixed denominators, unresolved work, and the proposed complete-pilot promotion rule. */
export function summarize(directory: string, reviewFile?: string) {
  const plan = load(directory);
  const reviews = reviewFile ? z.array(judgment).parse(json(reviewFile)) : [];
  if (new Set(reviews.map(value => value.packetId)).size !== reviews.length) throw new Error('Duplicate packet judgment');
  const grades = new Map(plan.runs.filter(entry => existsSync(join(directory, 'grades', `${entry.id}.json`))).map(entry => [entry.id, readGrade(directory, entry.id)]));
  for (const review of reviews) {
    const graded = [...grades.values()].find(value => value.packetId === review.packetId);
    if (!graded || graded.evidenceHash !== review.evidenceHash || graded.synthetic !== review.synthetic) throw new Error('Review does not match pilot evidence');
    const files = tree(join(directory, 'packets', review.packetId));
    delete files['packet.json'];
    if (hash(encode(files)) !== review.evidenceHash) throw new Error('Review packet bytes changed');
    freeze(join(directory, 'judgments', `${review.packetId}.json`), encode(review));
  }
  const runs = plan.runs.map(entry => {
    const result = grades.get(entry.id)?.authoring;
    const session = result?.kind === 'session' ? result : authoringUsage(undefined, plan.settings.author.budget);
    return { run: entry.id, fixture: entry.fixture, arm: entry.arm, synthetic: plan.settings.purpose === 'synthetic-controls', limits: plan.settings.author.budget, usage: session.usage, budget: session.budget };
  });
  const rows = ['all', ...fixtures.map(value => value.id)].flatMap(fixture => (['current', 'inspect-lower-tests'] as const).map(arm => {
    const entries = plan.runs.filter(entry => entry.arm === arm && (fixture === 'all' || fixture === entry.fixture));
    const outcomes = entries.map(entry => {
      const graded = grades.get(entry.id);
      const path = graded && join(directory, 'judgments', `${graded.packetId}.json`);
      const review = path && existsSync(path) ? judgment.parse(json(path)) : undefined;
      return { grade: graded, review, outcome: classify(graded, review) };
    });
    const consumption = runs.filter(value => entries.some(entry => entry.id === value.run));
    const measuredUsage = Object.fromEntries(usageMetrics.map(metric => {
      const known = consumption.flatMap(value => value.usage[metric] === null ? [] : [value.usage[metric]!]);
      return [metric, { known: known.length, missing: consumption.length - known.length, total: known.length ? known.reduce((sum, value) => sum + value, 0) : null }];
    }));
    const budgetCounts = { within: consumption.filter(value => value.budget.kind === 'within').length, exceeded: consumption.filter(value => value.budget.kind === 'exceeded').length, unknown: consumption.filter(value => value.budget.kind === 'unknown').length };
    return { fixture, arm, budget: budgetCounts, usage: measuredUsage, scheduled: entries.length, submitted: outcomes.filter(value => value.grade).length, executionValid: outcomes.filter(value => value.grade?.correct.kind === 'passed' && value.grade.mutant.kind !== 'unusable').length, reviewed: outcomes.filter(value => value.review).length, detected: outcomes.filter(value => value.outcome.kind === 'detected' && !value.grade?.synthetic).length, invalid: outcomes.filter(value => value.outcome.kind === 'invalid').length, pending: outcomes.filter(value => value.outcome.kind === 'pending').length };
  }));
  const complete = plan.settings.purpose === 'pilot' && rows.filter(value => value.fixture === 'all').every(value => value.submitted === 20 && value.reviewed === 20 && value.pending === 0 && value.budget.unknown === 0);
  const counts = (fixture: string, arm: string) => rows.find(value => value.fixture === fixture && value.arm === arm)!.detected;
  const difference = (fixture: string) => counts(fixture, 'inspect-lower-tests') - counts(fixture, 'current');
  const proposedPromotion = complete ? difference('all') > 0 && fixtures.filter(value => difference(value.id) > 0).length >= 2 && difference('stale-test') >= 0 && difference('no-relevant-test') >= 0 : null;
  const report = { purpose: plan.settings.purpose, rows, runs, complete, proposedPromotion, authoringUsage: 'Launcher observations are not independently verified. Totals include known measurements only; null means none measured.', lowerTestReads: 'unmeasured; transcripts are archived but no file-read parser is implemented', limitation: 'No statistical significance or generalization beyond these four fixtures, author model, and declared settings.' };
  const markdown = ['| Fixture | Arm | Scheduled | Submitted | Valid | Reviewed | Detected | Invalid | Pending | Budget within | Exceeded | Unknown |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|', ...rows.map(value => `| ${value.fixture} | ${value.arm} | ${value.scheduled} | ${value.submitted} | ${value.executionValid} | ${value.reviewed} | ${value.detected} | ${value.invalid} | ${value.pending} | ${value.budget.within} | ${value.budget.exceeded} | ${value.budget.unknown} |`), '', '| Run | Turns | Tokens | Wall time seconds | Budget |', '|---|---:|---:|---:|---|', ...runs.map(value => `| ${value.run} | ${value.usage.turns ?? 'unknown'} | ${value.usage.tokens ?? 'unknown'} | ${value.usage.wallTimeSeconds ?? 'unknown'} | ${value.budget.kind}${value.budget.kind === 'within' ? '' : `, ${value.budget.metrics.join(', ')}`} |`), '', '| Fixture | Arm | Measure | Known | Missing | Known total |', '|---|---|---|---:|---:|---:|', ...rows.flatMap(value => Object.entries(value.usage).map(([metric, measured]) => `| ${value.fixture} | ${value.arm} | ${metric} | ${measured.known} | ${measured.missing} | ${measured.total ?? 'unknown'} |`)), '', `Complete reviewed pilot: ${complete}. Proposed promotion: ${proposedPromotion === null ? 'pending' : proposedPromotion}.`, report.authoringUsage, report.limitation, report.lowerTestReads, ''].join('\n');
  mkdirSync(join(directory, 'reports'), { recursive: true });
  writeFileSync(join(directory, 'reports/summary.json'), encode(report));
  writeFileSync(join(directory, 'reports/summary.md'), markdown);
  return { report, markdown };
}
