/**
 * A registered secret value the test passes as a plain string, not as a
 * `secrets.get()` handle: spelled into test and describe titles, an
 * `app.open` URL, a locator, a `fill`, an `agent.act` instruction and its
 * params, and the test's agent context, and logged by the test itself.
 * Through the worker path, so the runner's collection and the worker's agree
 * on the redacted ids: it reaches no executor input, no step label, no
 * report, reporter file, trace entry, or file name under `.e2e`, and no
 * output event. A secret handle in the same run still types the real value.
 * Through the built-in agent in process: neither the act loop's prompt nor a
 * judgment's carries it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/run/events.ts';
import type { RunOutcome } from '../../src/run/runner.ts';
import { fakeCalls, installFakeModel, judgment } from '../helpers/fake-model.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { contentsUnder, resultByTitle, runProject, runProjectWithConfigFile, type FixtureProject } from '../helpers/run-project.ts';

const SECRET = 'plain-Zr8Kq2Wm5Tx9';
const MARKER = '<secret:probe>';
/** The value as written and base64 encoded, lowercased: a trace spells it in a URL, a DOM snapshot, and the fill's params. */
const SECRET_FORMS = [SECRET, Buffer.from(SECRET).toString('base64'), Buffer.from(SECRET).toString('base64url')].map((form) => form.toLowerCase());

const CONFIG = `import type { E2EConfig, StepExecutor } from 'e2e';
import { appendFileSync } from 'node:fs';
import { web } from '@e2e-dev/web';

const recording: StepExecutor = {
  name: 'recording',
  version: '1',
  cache: 'off',
  async runStep(context) {
    const { instruction, params } = context.step;
    appendFileSync(new URL('./executor-input.jsonl', import.meta.url), JSON.stringify({ instruction, params, agentContext: context.agentContext }) + '\\n');
    if (context.step.secrets.length > 0) {
      const observation = await context.observe();
      const id = /#(\\S+) textbox "Focus target"/.exec(observation.text)?.[1];
      if (id === undefined) return { status: 'failed', summary: 'no focus target' };
      await context.actions.typeSecret({ id }, context.step.secrets[0]!.name);
    }
    return { status: 'passed', summary: 'done' };
  },
};

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  workers: 1,
  trace: 'on',
  reporters: ['markdown', 'junit'],
  secrets: { probe: ${JSON.stringify(SECRET)} },
  agents: { default: { executor: recording } },
} satisfies E2EConfig;
`;

const SUITE = `import { describe, expect, secrets, test } from 'e2e';
const S = ${JSON.stringify(SECRET)};

describe(\`suite \${S}\`, () => {
  test(\`title holds \${S}\`, { agentContext: \`context \${S}\` }, async ({ app, agent, screen }) => {
    console.log(\`stdout carries \${S}\`);
    console.error(\`stderr carries \${S}\`);
    await app.open(\`/?token=\${S}\`);
    await agent.act(\`inspect \${S} with {note}\`, { params: { note: S, [\`key \${S}\`]: [S] } });
    await expect(screen.getByText(\`missing \${S}\`)).toBeVisible({ timeout: 500 });
  });
});

test('types the secret through its handle', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('paste the key into the focus target', { params: { key: secrets.get('probe') } });
  await expect(screen.getByLabel('Focus target')).toHaveValue(S);
});
`;

/** Every path under `dir`, files and directories, relative to it. */
function pathsUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const entry = path.join(dir, name);
    return statSync(entry).isDirectory() ? [name, ...pathsUnder(entry).map((inner) => path.join(name, inner))] : [name];
  });
}

describe('a secret value passed as a plain string', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  const events: RunEvent[] = [];

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProjectWithConfigFile(
      { 'tests/plain.e2e.ts': SUITE },
      { appUrl: app.url, configSource: CONFIG, runOptions: { onEvent: (event: RunEvent) => { events.push(event); } } },
    ));
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('runs the test under its redacted title and id, its error still masked', () => {
    const result = resultByTitle(outcome, `title holds ${MARKER}`);
    expect(result.status).toBe('failed');
    expect(result.test.titlePath).toEqual([`suite ${MARKER}`, `title holds ${MARKER}`]);
    expect(result.test.id).toBe('tests/plain.e2e.ts::suite%20%3Csecret%3Aprobe%3E::title%20holds%20%3Csecret%3Aprobe%3E');
    const attempt = result.attempts.at(-1)!;
    expect(attempt.error?.code).toBe('ASSERTION_FAILED');
    expect(attempt.error?.message).toContain(`getByText("missing ${MARKER}")`);
    expect(attempt.steps.map((step) => step.label)).toContain(`inspect ${MARKER} with {note}`);
  });

  it('hands the executor the instruction, params, and agent context redacted', () => {
    const inputs = readFileSync(path.join(project.dir, 'executor-input.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(inputs).toEqual([
      {
        instruction: `inspect ${MARKER} with {note}`,
        params: { note: MARKER, [`key ${MARKER}`]: [MARKER] },
        agentContext: `context ${MARKER}`,
      },
      { instruction: 'paste the key into the focus target', params: { key: { kind: 'secret', name: 'probe', purpose: 'generic-secret' } } },
    ]);
  });

  it('still types the real value through the secret handle', () => {
    expect(resultByTitle(outcome, 'types the secret through its handle').status).toBe('passed');
  });

  it('keeps the value out of every output event, report, reporter file, and file name under .e2e', () => {
    const output = events.filter((event) => event.type === 'output');
    expect(output.map((event) => event.text).join('')).toContain(`stdout carries ${MARKER}`);
    expect(output.map((event) => event.text).join('')).toContain(`stderr carries ${MARKER}`);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(outcome.report)).not.toContain(SECRET);
    const root = path.join(project.dir, '.e2e');
    const names = pathsUnder(root);
    expect(names).toContain('junit.xml');
    expect(names).toContain('summary.md');
    expect(names.some((name) => name.startsWith('failures'))).toBe(true);
    for (const name of names) expect(name.includes(SECRET), name).toBe(false);
    const contents = contentsUnder(root);
    expect(contents.filter(([file]) => file.includes('.zip!')).length).toBeGreaterThan(0);
    for (const [file, text] of contents) {
      for (const form of SECRET_FORMS) expect(text.toLowerCase().includes(form), file).toBe(false);
    }
    expect(readFileSync(path.join(root, 'junit.xml'), 'utf8')).toContain('title holds &lt;secret:probe&gt;');
  });
});

const BUILT_IN_SUITE = `import { test, expect } from 'e2e';
const S = ${JSON.stringify(SECRET)};

test('built-in agent', { agentContext: \`context \${S}\` }, async ({ app, agent }) => {
  await app.open();
  await agent.act(\`inspect \${S} with {note}\`, { params: { note: S } });
  await agent.assert(\`the page does not show \${S}\`);
});
`;

describe('a secret value passed as a plain string to the built-in agent', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel(() => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'inspected' } }]);
    const judge = installFakeModel(() => judgment(true, 'nothing secret is shown'));
    ({ outcome, project } = await runProject(
      { 'tests/built-in.e2e.ts': BUILT_IN_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model, judge } }, secrets: { probe: SECRET } } },
    ));
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('sends the act loop and the judgment the redacted instruction, params, and context', () => {
    expect(resultByTitle(outcome, 'built-in agent').status).toBe('passed');
    expect(loopCalls.length).toBeGreaterThan(0);
    const [act] = loopCalls;
    expect(act!.prompt).toContain(`Execute this test step: inspect ${MARKER} with {note}`);
    expect(act!.prompt).toContain(`{"note":"${MARKER}"}`);
    expect(act!.system).toContain(`context ${MARKER}`);
    expect(fakeCalls).toHaveLength(1);
    expect(fakeCalls[0]!.instruction).toBe(`the page does not show ${MARKER}`);
    expect(fakeCalls[0]!.system).toContain(`context ${MARKER}`);
    expect(JSON.stringify([loopCalls, fakeCalls])).not.toContain(SECRET);
  });
});
