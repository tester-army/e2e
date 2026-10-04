/**
 * `e2e run` with user code that prints a configured secret outside any test
 * body: the config's top-level code (in the runner and again in each
 * worker), a test file's top level while the runner collects it, and a custom
 * reporter. What each prints reaches the terminal redacted, as a test's
 * output does. A config that prints a secret and then fails to load has no
 * secrets anyone knows, so what it printed is withheld, not passed on raw.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));

const TOKEN = 'run-output-token-42';

const CONFIG = `import { defineEngine } from 'e2e/engine';

const token = '${TOKEN}';
console.log(\`config console.log: \${token}\`);
console.error(\`config console.error: \${token}\`);
process.stdout.write(\`config split: \${token.slice(0, 9)}\`);
process.stdout.write(\`\${token.slice(9)}\\n\`);

export default {
  targets: [{ name: 'headless', platform: 'test', engine: defineEngine({ name: 'noop', version: '1', spiVersion: 1 }) }],
  workers: 1,
  secrets: { apiToken: token },
  reporters: ['list', {
    name: 'chatty',
    onEvent(event) {
      if (event.type === 'plan') console.log(\`reporter onEvent: \${token}\`);
      if (event.type === 'run-finished') process.stdout.write(\`reporter unfinished: \${token}\`);
    },
    onRunFinished() {
      console.error(\`reporter onRunFinished: \${token}\`);
    },
  }],
};
`;

const TEST = `import { test } from 'e2e';

console.log('test file top level: ${TOKEN}');

test('prints', () => {
  console.log('test body: ${TOKEN}');
});
`;

const BROKEN_CONFIG = `console.log('broken config: ${TOKEN}');
throw new Error('config refuses to load');
`;

const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

function runCli(files: Record<string, string>) {
  const project = createProject(files);
  projects.push(project);
  const cli = spawnSync(process.execPath, [CLI, 'run'], {
    cwd: project.dir,
    env: { ...process.env, CI: '', E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(cli.error).toBeUndefined();
  return cli;
}

describe('e2e run redacts what user code prints outside a test', () => {
  it('redacts the config, a collected test file, and a reporter on stdout and stderr', () => {
    const cli = runCli({ 'e2e.config.ts': CONFIG, 'tests/print.e2e.ts': TEST });
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    const output = `${cli.stdout}\n${cli.stderr}`;
    expect(output).not.toContain(TOKEN);
    const lines = output.split('\n');
    for (const line of [
      'config console.log: <secret:apiToken>',
      'config console.error: <secret:apiToken>',
      'config split: <secret:apiToken>',
      'test file top level: <secret:apiToken>',
      'reporter onEvent: <secret:apiToken>',
      'reporter onRunFinished: <secret:apiToken>',
      'reporter unfinished: <secret:apiToken>',
      'test body: <secret:apiToken>',
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('withholds what a config printed before it failed to load', () => {
    const cli = runCli({ 'e2e.config.ts': BROKEN_CONFIG });
    const output = `${cli.stdout}\n${cli.stderr}`;
    expect(cli.status).not.toBe(0);
    expect(output).toContain('config refuses to load');
    expect(output).toContain('withheld');
    expect(output).not.toContain(TOKEN);
  });
});
