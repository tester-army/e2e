import type { E2EConfig, StepExecutor } from 'e2e';
import { web } from '@e2e-dev/web';

/**
 * Scripted `scroll_to({ text })` over the playground's windowed `/scroll`
 * page: the instruction names the row, the executor pages to it and taps it.
 * No model, so wall time is the runner's and the engine's alone.
 *
 *   pnpm --filter @e2e-dev/testbed test:scroll
 */
const scrollToRow: StepExecutor = {
  name: 'scroll-to-row',
  version: '1',
  async runStep(context) {
    const row = /Row \d+/u.exec(context.step.instruction)?.[0];
    if (row === undefined) return { status: 'failed', summary: 'the step names no row', errorCode: 'STEP_NO_CONCLUSION' };
    await context.observe();
    await context.actions.scrollUntil(row, 'down');
    const screen = await context.observe();
    const line = screen.text.split('\n').find((entry) => entry.includes(`button "${row}"`));
    const id = /#(\S+)/u.exec(line ?? '')?.[1];
    if (id === undefined) return { status: 'failed', summary: `${row} is not on the screen`, errorCode: 'STEP_NO_CONCLUSION' };
    await context.actions.tap({ id });
    return { status: 'passed', summary: `tapped ${row}` };
  },
};

export default {
  projectId: 'dev.e2e.testbed-scroll',
  tests: 'tests-scroll/**/*.e2e.ts',
  targets: [
    {
      name: 'web',
      engine: web(),
      app: {
        url: 'http://127.0.0.1:4279',
        command: { executable: 'node', args: ['app/server.mjs'], env: { PORT: '4279' } },
      },
    },
  ],
  cache: 'off',
  agents: { default: { executor: scrollToRow } },
} satisfies E2EConfig;
