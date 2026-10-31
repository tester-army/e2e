/**
 * `doctor()` in process: what the built CLI cannot show without waiting out
 * the engine budget.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctor } from '../../src/cli/doctor.ts';
import { cancelledError } from '../../src/internal/time.ts';
import { withProcessOutput } from '../../src/run/process-output.ts';
import { processSecrets } from '../../src/run/secrecy.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

describe('doctor', () => {
  it("waits for a cancelled engine to close its connection before it reports", async () => {
    const project = createProject({
      'e2e.config.ts': `import { writeFileSync } from 'node:fs';
import { connectEngine, defineEngine, describeEngine, loopbackTransport, type EngineTransport } from '../../../src/engine/index.ts';
import { FAKE_APP } from '../../helpers/fake-engine.ts';

const hanging = defineEngine({
  name: 'slow',
  version: '1.0.0',
  spiVersion: 1,
  platform: 'fake',
  observe: async () => ({ root: { ref: { id: 'root', revision: '' }, role: 'root' }, viewport: { width: 1, height: 1 } }),
  doctor: () => new Promise(() => {}),
});
const inner = loopbackTransport(hanging);
const transport: EngineTransport = {
  label: 'slow to close',
  async open(context) {
    const streams = await inner.open(context);
    return {
      ...streams,
      async close(timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        writeFileSync(\`\${context.cwd}/closed\`, '');
        await streams.close(timeoutMs);
      },
    };
  },
};
const slow = connectEngine({ manifest: describeEngine(hanging), transport });

export default { tests: 'tests/**/*.e2e.ts', targets: [{ name: 'slow', engine: slow, app: FAKE_APP }] };
`,
    });
    projects.push(project);
    const controller = new AbortController();
    setTimeout(() => controller.abort(cancelledError()), 200);
    const report = await withProcessOutput(processSecrets, (output) =>
      doctor({ version: '0.0.0', cwd: project.dir, env: process.env, headed: false, checkModel: false, signal: controller.signal, output, notice: () => {} }),
    );
    expect(existsSync(path.join(project.dir, 'closed'))).toBe(true);
    expect(report.checks.find((check) => check.target === 'slow')).toMatchObject({ id: 'engine', status: 'fail', code: 'CANCELLED' });
  });
});
