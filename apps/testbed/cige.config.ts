import { execFileSync } from 'node:child_process';
import { defineCige } from '@e2e-dev/cige';

/**
 * CIGE cases on the playground, run by the agentic suite
 * (`e2e.agent.config.ts`). Each case's evidence is a deterministic read of
 * the page, so an agentic pass is checked by code, not only by the judge.
 */
export default defineCige({
  cases: 'tests-agent/cige/*.cige.json',
  root: new URL('.', import.meta.url),
  build: process.env.GITHUB_SHA ?? 'local',
  hooks: {
    workspaceCreated: async ({ screen }, testCase) => {
      const summary = await screen.getByRole('status', { name: 'Summary' }).textContent();
      return summary === `Created "${testCase.params?.name}" on the ${testCase.params?.plan} plan`;
    },
    // "0 remaining" alone is also the empty list's state: the todo itself must exist and be checked.
    todoDone: async ({ screen }) =>
      (await screen.getByRole('checkbox', { name: 'Water the plants' }).isChecked()) &&
      (await screen.getByRole('status', { name: 'Remaining' }).textContent()) === '0 remaining',
  },
  environments: {
    // The playground keeps no server state: every page load starts clean, so a reset has nothing to do.
    local: { config: 'e2e.agent.config.ts', reset: () => undefined },
  },
  refs: {
    // The playground has no spec or release notes; its page source and git history stand in for both.
    spec: () => ({ files: ['app/pages/basics.mjs'] }),
    build: () => ({ text: execFileSync('git', ['log', '-5', '--oneline', '--', 'app'], { cwd: import.meta.dirname, encoding: 'utf8' }) }),
  },
});
