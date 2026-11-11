/** Pinned steps: the steps-1 file, the per-step plan, and writing pins into a test's calls. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rewriteInlineSteps } from '../../src/cache/inline-steps.ts';
import { createAttemptPins, settleStagedPins } from '../../src/cache/pin-context.ts';
import {
  inlineStepsOf,
  mergePinsFile,
  pinnedStep,
  pinsFileFor,
  readInlineSteps,
  readPinsBook,
  unpinnableReason,
  type PinnedStep,
  type PinnedStepId,
} from '../../src/cache/pins.ts';
import type { ActionTrace, TraceKeyContext } from '../../src/cache/trace.ts';
import { writePins } from '../../src/run/pin-writes.ts';

const FIXTURES = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'schema', 'fixtures');

const context: TraceKeyContext = {
  cacheSchema: 'trace-1',
  policyVersion: 'replay-7',
  project: 'p',
  platform: 'web',
  engineName: 'web',
  engineSpiVersion: 3,
  appIdentity: 'http://127.0.0.1:4173',
  agentContextDigest: 'd',
};

const id: PinnedStepId = { test: ['greets'], target: 'web', agent: 'default', instruction: 'greet {name}', params: { name: 'Grace' }, callIndex: 0 };

const trace: ActionTrace = {
  actions: [
    { name: 'type', summary: 'type into textbox "name"', target: { role: 'textbox', name: 'name' }, value: 'Grace' },
    { name: 'tap', summary: 'tap button "greet"', target: { role: 'button', name: 'greet' } },
  ],
  executor: { name: 'default' },
  summary: 'the app greets Grace',
  startPath: '/',
  endAnchors: [{ role: 'status', text: 'hello, Grace!' }],
  endWaitMs: 10_100,
  keyedBy: context,
  recordedFor: { testId: 't', targetId: 'web', instructionDigest: 'a'.repeat(64) },
};

let directory: string | undefined;
afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function scratch(): string {
  directory = mkdtempSync(path.join(tmpdir(), 'e2e-pins-'));
  return directory;
}

describe('steps-1 file', () => {
  it('sits beside its test', () => {
    expect(pinsFileFor('tests/checkout.e2e.ts')).toBe('tests/checkout.e2e.steps.json');
    expect(pinsFileFor('e2e/app.e2e.mjs')).toBe('e2e/app.e2e.steps.json');
  });

  it('reads the valid schema fixture whole, and refuses the invalid one', () => {
    const valid = readPinsBook(readFileSync(path.join(FIXTURES, 'steps-v1.valid.json'), 'utf8'));
    expect(valid.status).toBe('read');
    const entries = valid.status === 'read' ? [...valid.entries.values()] : [];
    expect(entries.map((entry) => entry.status)).toEqual(['ok', 'ok']);
    expect(readPinsBook(readFileSync(path.join(FIXTURES, 'steps-v1.invalid.json'), 'utf8')).status).toBe('unreadable');
  });

  it('refuses two entries for one step', () => {
    const step = JSON.parse(JSON.stringify(pinnedStep(id, context, trace, false))) as unknown;
    const book = readPinsBook(JSON.stringify({ schemaVersion: 'steps-1', steps: [step, step] }));
    expect(book).toEqual({ status: 'unreadable', reason: 'steps[1] pins a step an earlier entry already pins' });
  });

  it('refuses an entry whose params are missing or null, which would match a call with none', () => {
    const step = JSON.parse(JSON.stringify(pinnedStep(id, context, trace, false))) as Record<string, unknown>;
    for (const params of [undefined, null]) {
      const book = readPinsBook(JSON.stringify({ schemaVersion: 'steps-1', steps: [{ ...step, params }] }));
      expect(book).toMatchObject({ status: 'unreadable', reason: expect.stringContaining('does not say which step it pins') });
    }
  });

  it('keeps an entry whose recording cannot replay as pinned, never as absent', () => {
    const step = { ...JSON.parse(JSON.stringify(pinnedStep(id, context, trace, false))), trace: { executor: { name: 'x' }, summary: 's', actions: [{ name: 'fly' }] } };
    const book = readPinsBook(JSON.stringify({ schemaVersion: 'steps-1', steps: [step] }));
    expect(book.status === 'read' ? [...book.entries.values()][0]?.status : undefined).toBe('unreadable');
  });

  it('merges in place, appends new steps, and leaves a file alone when the flow is the same', async () => {
    const file = path.join(scratch(), 'a.e2e.steps.json');
    expect(await mergePinsFile(file, [pinnedStep(id, context, trace, false)])).toBe(1);
    const written = readFileSync(file, 'utf8');
    // A later recording of the same flow, another summary and wait: nothing to write.
    expect(await mergePinsFile(file, [pinnedStep(id, context, { ...trace, summary: 'again', endWaitMs: 12_000 }, false)])).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(written);
    const other = { ...id, instruction: 'say goodbye' };
    expect(await mergePinsFile(file, [pinnedStep(other, context, trace, false), pinnedStep(id, { ...context, engineSpiVersion: 4 }, trace, false)])).toBe(2);
    const book = readPinsBook(readFileSync(file, 'utf8'));
    const steps = book.status === 'read' ? [...book.entries.values()].map((entry) => (entry.status === 'ok' ? entry.step : undefined)) : [];
    expect(steps.map((step) => [step?.instruction, step?.recordedWith.engineSpiVersion])).toEqual([['greet {name}', 4], ['say goodbye', 3]]);
  });

  it('keeps an inline entry without its actions, and never the recording provenance', async () => {
    const file = path.join(scratch(), 'a.e2e.steps.json');
    await mergePinsFile(file, [pinnedStep(id, context, trace, true)]);
    const document = JSON.parse(readFileSync(file, 'utf8')) as { steps: { inline?: boolean; trace: Record<string, unknown> }[] };
    expect(document.steps[0]?.inline).toBe(true);
    expect(Object.keys(document.steps[0]!.trace)).not.toContain('actions');
    expect(Object.keys(document.steps[0]!.trace)).not.toContain('keyedBy');
    expect(Object.keys(document.steps[0]!.trace)).not.toContain('recordedFor');
  });

  it('never overwrites a file it cannot read', async () => {
    const file = path.join(scratch(), 'a.e2e.steps.json');
    writeFileSync(file, '{ not json');
    await expect(mergePinsFile(file, [pinnedStep(id, context, trace, false)])).rejects.toThrow(/not JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });
});

describe('inline steps', () => {
  it('reads actions without their summaries, and drops them on the way out', () => {
    const actions = readInlineSteps([{ name: 'tap', target: { role: 'button', name: 'greet' } }]);
    expect(actions).toEqual([{ name: 'tap', summary: 'tap button "greet"', target: { role: 'button', name: 'greet' } }]);
    expect(inlineStepsOf(trace)).toEqual([
      { name: 'type', target: { role: 'textbox', name: 'name' }, value: 'Grace' },
      { name: 'tap', target: { role: 'button', name: 'greet' } },
    ]);
  });

  it('refuses an action the closed schema does not know', () => {
    expect(readInlineSteps([{ name: 'tap' }])).toBeUndefined();
    expect(readInlineSteps([{ name: 'eval', code: 'x' }])).toBeUndefined();
    expect(readInlineSteps([])).toBeUndefined();
  });

  it('writes the actions into the call a stack names, one per line, at its indent', () => {
    const source = [
      "test('greets', async ({ agent }) => {",
      "  await agent.act('greet {name}', {",
      "    params: { name: 'Grace' },",
      '    steps: [],',
      '  });',
      "  await agent.act('other', { steps: [] });",
      '});',
      '',
    ].join('\n');
    const { code, missed } = rewriteInlineSteps('a.e2e.ts', source, [{ line: 2, column: 15, steps: inlineStepsOf(trace) }]);
    expect(missed).toEqual([]);
    expect(code).toBe([
      "test('greets', async ({ agent }) => {",
      "  await agent.act('greet {name}', {",
      "    params: { name: 'Grace' },",
      '    steps: [',
      "      { name: 'type', target: { role: 'textbox', name: 'name' }, value: 'Grace' },",
      "      { name: 'tap', target: { role: 'button', name: 'greet' } },",
      '    ],',
      '  });',
      "  await agent.act('other', { steps: [] });",
      '});',
      '',
    ].join('\n'));
  });

  it("quotes what a string holds, and misses a call whose steps are the test's own code", () => {
    const source = "agent.act('x', { steps: [] });\nagent.act('y', { steps: mine });\n";
    const { code, missed } = rewriteInlineSteps('a.e2e.ts', source, [
      { line: 1, column: 7, steps: [{ name: 'type', value: "it's\n{{param:/name}}", 'data-x': true }] },
      { line: 2, column: 7, steps: [{ name: 'back' }] },
    ]);
    expect(code).toBe("agent.act('x', { steps: [\n  { name: 'type', value: 'it\\'s\\n{{param:/name}}', 'data-x': true },\n] });\nagent.act('y', { steps: mine });\n");
    expect(missed.map((edit) => edit.line)).toEqual([2]);
  });
});

describe('a step meets its pin', () => {
  const target = { targetId: 'web', platform: 'web', engineName: 'web', spiVersion: 3, appIdentity: 'http://127.0.0.1:4173' };

  function pins(root: string, update: 'none' | 'new' | 'all', inlineWrites = true, titlePath = ['greets'], required = false) {
    return createAttemptPins({
      projectRoot: root, projectId: 'p', testFile: 'a.e2e.ts', testId: 'a.e2e.ts::greets', titlePath, target, update, inlineWrites, required,
      redact: (text) => text.replaceAll('hunter2', '[secret]'),
    });
  }

  it('masks a secret the title, target, or agent spells, so the file never holds it', () => {
    const attempt = pins(scratch(), 'new', true, ['logs in with hunter2']);
    const claim = attempt.claim('log in', {}, { name: 'agent-hunter2', context: undefined });
    expect(claim.id).toMatchObject({ test: ['logs in with [secret]'], agent: 'agent-[secret]' });
  });

  it('replays a sidecar pin, records one under --pin, and leaves others alone without it', async () => {
    const root = scratch();
    const attempt = pins(root, 'none');
    const claim = attempt.claim('greet {name}', { name: 'Grace' }, { name: 'default', context: undefined });
    expect(await attempt.plan(claim, undefined)).toEqual({ kind: 'none' });
    expect(await pins(root, 'new').plan(claim, undefined)).toEqual({ kind: 'record', inline: false });

    await mergePinsFile(path.join(root, 'a.e2e.steps.json'), [pinnedStep(claim.id, claim.context, trace, false)]);
    const fresh = pins(root, 'none');
    const plan = await fresh.plan(fresh.claim('greet {name}', { name: 'Grace' }, { name: 'default', context: undefined }), undefined);
    expect(plan).toMatchObject({ kind: 'replay', source: 'sidecar', recordedWith: claim.context });
    expect(await pins(root, 'all').plan(claim, undefined)).toEqual({ kind: 'record', inline: false });
  });

  it('fails a step with no pin when pins are required, unless --pin records it', async () => {
    const root = scratch();
    const required = pins(root, 'none', true, ['greets'], true);
    const claim = required.claim('greet', {}, { name: 'default', context: undefined });
    expect(await required.plan(claim, undefined)).toEqual({ kind: 'unpinned' });
    expect(await pins(root, 'new', true, ['greets'], true).plan(claim, undefined)).toEqual({ kind: 'record', inline: false });
    expect(pins(root, 'new', true, ['greets'], true).required).toBe(false);

    await mergePinsFile(path.join(root, 'a.e2e.steps.json'), [pinnedStep(claim.id, claim.context, trace, false)]);
    const fresh = pins(root, 'none', true, ['greets'], true);
    expect(await fresh.plan(fresh.claim('greet', {}, { name: 'default', context: undefined }), undefined)).toMatchObject({ kind: 'replay' });
  });

  it('records an empty steps option only under --pin when pins are required, and still fails it in CI', async () => {
    const root = scratch();
    const plan = (update: 'none' | 'new', inlineWrites: boolean) => {
      const attempt = pins(root, update, inlineWrites, ['greets'], true);
      return attempt.plan(attempt.claim('greet', {}, { name: 'default', context: undefined }), []);
    };
    expect(await plan('none', true)).toEqual({ kind: 'unpinned' });
    expect(await plan('new', true)).toEqual({ kind: 'record', inline: true });
    expect(await plan('none', false)).toMatchObject({ kind: 'stale', reason: expect.stringContaining('its steps option is empty') });
  });

  it('counts repeats of one call, and keeps them apart', () => {
    const attempt = pins(scratch(), 'none');
    const agent = { name: 'default', context: undefined };
    expect([0, 1].map(() => attempt.claim('next', {}, agent).id.callIndex)).toEqual([0, 1]);
    expect(attempt.claim('other', {}, agent).id.callIndex).toBe(0);
  });

  it('records an empty steps option locally, and fails it in CI', async () => {
    const root = scratch();
    const claim = pins(root, 'none').claim('greet', {}, { name: 'default', context: undefined });
    expect(await pins(root, 'none').plan(claim, [])).toEqual({ kind: 'record', inline: true });
    expect(await pins(root, 'none', false).plan(claim, [])).toMatchObject({ kind: 'stale', source: 'inline' });
  });

  it('replays hand-written steps with nothing to check after, and fails ones it cannot read', async () => {
    const root = scratch();
    const attempt = pins(root, 'none');
    const claim = attempt.claim('greet', {}, { name: 'default', context: undefined });
    const plan = await attempt.plan(claim, [{ name: 'tap', target: { role: 'button', name: 'greet' } }]);
    expect(plan).toMatchObject({ kind: 'replay', source: 'inline' });
    expect(plan.kind === 'replay' ? plan.recordedWith : 'set').toBeUndefined();
    expect(await attempt.plan(claim, [{ name: 'tap' }])).toMatchObject({ kind: 'stale' });
  });

  it('fails every step of a test whose steps file is unreadable', async () => {
    const root = scratch();
    writeFileSync(path.join(root, 'a.e2e.steps.json'), '[]');
    const attempt = pins(root, 'new');
    const plan = await attempt.plan(attempt.claim('greet', {}, { name: 'default', context: undefined }), undefined);
    expect(plan).toMatchObject({ kind: 'stale', reason: expect.stringContaining('a.e2e.steps.json cannot be read') });
  });

  it('pins only what a passing check confirmed', () => {
    const attempt = pins(scratch(), 'new');
    const claim = attempt.claim('greet', {}, { name: 'default', context: undefined });
    attempt.staged.push({ stepIndex: 0, claim, inline: false, trace }, { stepIndex: 2, claim, inline: false, trace });
    const settled = settleStagedPins(attempt, { passed: true, lastVerifiedStepIndex: 1, sources: new Map(), testFile: 'a.e2e.ts' });
    expect(settled?.writes.length).toBe(1);
    expect(settled?.skipped.map((skip) => skip.reason)).toEqual(['no check passed after the step, so nothing confirmed its recording']);
  });
});

describe('writing a run\'s pins', () => {
  it('writes inline actions into the call and the rest beside the test, and refuses one call with two lists', async () => {
    const root = scratch();
    const test = "test('greets', async ({ agent }) => {\n  await agent.act('greet {name}', { steps: [] });\n});\n";
    writeFileSync(path.join(root, 'a.e2e.ts'), test);
    const step = pinnedStep(id, context, trace, true);
    const { lines } = await writePins(root, [
      { writes: [{ file: 'a.e2e.ts', step, inline: { file: 'a.e2e.ts', line: 2, column: 15 } }], skipped: [] },
      { writes: [{ file: 'a.e2e.ts', step: pinnedStep({ ...id, test: ['loops'] }, context, { ...trace, actions: trace.actions.slice(1) }, true), inline: { file: 'a.e2e.ts', line: 2, column: 15 } }], skipped: [] },
    ]);
    expect(lines).toEqual(['a.e2e.ts:2:15: not written: the call ran with 2 different lists of actions; take steps out of it, and --pin keeps each run of it in the steps file']);
    expect(readFileSync(path.join(root, 'a.e2e.ts'), 'utf8')).toBe(test);

    const again = await writePins(root, [{ writes: [{ file: 'a.e2e.ts', step, inline: { file: 'a.e2e.ts', line: 2, column: 15 } }], skipped: [] }]);
    expect(again.lines).toEqual(['a.e2e.ts: 1 call pinned inline', 'a.e2e.steps.json: 1 step pinned']);
    expect(readFileSync(path.join(root, 'a.e2e.ts'), 'utf8')).toContain("{ name: 'tap', target: { role: 'button', name: 'greet' } },");
  });

  it('leaves the test file alone when its steps file cannot be written', async () => {
    const root = scratch();
    const test = "test('greets', async ({ agent }) => {\n  await agent.act('greet {name}', { steps: [] });\n});\n";
    writeFileSync(path.join(root, 'a.e2e.ts'), test);
    writeFileSync(path.join(root, 'a.e2e.steps.json'), '[]');
    const { lines } = await writePins(root, [{ writes: [{ file: 'a.e2e.ts', step: pinnedStep(id, context, trace, true), inline: { file: 'a.e2e.ts', line: 2, column: 15 } }], skipped: [] }]);
    expect(lines).toEqual([
      'a.e2e.ts:2: not written: the steps file that keeps the rest of its recording was not written',
      expect.stringMatching(/^a\.e2e\.steps\.json: not written: it is not a steps-1 document/),
    ]);
    expect(readFileSync(path.join(root, 'a.e2e.ts'), 'utf8')).toBe(test);
  });

  it('writes the calls of a file whose steps were written, past one whose were not', async () => {
    const root = scratch();
    const test = "test('greets', async ({ agent }) => {\n  await agent.act('greet {name}', { steps: [] });\n  await agent.act('wave', { steps: [] });\n});\n";
    writeFileSync(path.join(root, 'a.e2e.ts'), test);
    const wave = { ...id, instruction: 'wave', params: {} };
    const at = (line: number) => ({ file: 'a.e2e.ts', line, column: 15 });
    const { lines } = await writePins(root, [
      { writes: [{ file: 'a.e2e.ts', step: pinnedStep(id, context, trace, true), inline: at(2) }], skipped: [] },
      { writes: [{ file: 'a.e2e.ts', step: pinnedStep(wave, context, trace, true), inline: at(3) }], skipped: [] },
      { writes: [{ file: 'a.e2e.ts', step: pinnedStep(wave, context, { ...trace, endPath: '/elsewhere' }, true), inline: at(3) }], skipped: [] },
    ]);
    expect(lines).toEqual([
      'a.e2e.ts:3: not written: the steps file that keeps the rest of its recording was not written',
      'a.e2e.ts: 1 call pinned inline',
      'a.e2e.steps.json: not written for "wave" in greets: its 2 runs recorded different flows; pin it in a run that runs it once',
      'a.e2e.steps.json: 1 step pinned',
    ]);
    const written = readFileSync(path.join(root, 'a.e2e.ts'), 'utf8');
    expect(written).toContain("await agent.act('greet {name}', { steps: [\n");
    expect(written).toContain("await agent.act('wave', { steps: [] });");
  });

  it('writes a step its repeats recorded alike once, and none whose repeats disagree', async () => {
    const root = scratch();
    const write = (step: PinnedStep) => ({ writes: [{ file: 'a.e2e.ts', step }], skipped: [] });
    const other = { ...id, instruction: 'wave' };
    const { lines } = await writePins(root, [
      write(pinnedStep(id, context, trace, false)),
      write(pinnedStep(id, context, trace, false)),
      write(pinnedStep(other, context, trace, false)),
      write(pinnedStep(other, context, { ...trace, actions: trace.actions.slice(1) }, false)),
    ]);
    expect(lines).toEqual([
      'a.e2e.steps.json: not written for "wave" in greets: its 2 runs recorded different flows; pin it in a run that runs it once',
      'a.e2e.steps.json: 1 step pinned',
    ]);
    expect(JSON.parse(readFileSync(path.join(root, 'a.e2e.steps.json'), 'utf8')).steps).toHaveLength(1);
  });
});

describe('what can be pinned', () => {
  it('refuses a recording that would hand off or could never start', () => {
    expect(unpinnableReason(trace)).toBeUndefined();
    expect(unpinnableReason({ ...trace, actions: [...trace.actions, { name: 'tool', summary: 'tool seed' }] })).toBe('the step calls a project tool');
    expect(unpinnableReason({ ...trace, actions: [{ name: 'tool', summary: 'tool type (run-time value)', derived: 'pixels' }] })).toBe('the step types a value it read off the screen');
    const { startPath: _startPath, ...anywhere } = trace;
    expect(unpinnableReason(anywhere)).toBe('the recording does not say which screen it starts on');
  });
});
