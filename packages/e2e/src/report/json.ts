/** The built-in `json` reporter: the report document to stdout, and nothing else there. */

import type { Reporter } from '../types.ts';

export const jsonReporter: Reporter = {
  name: 'json',
  async onRunFinished(run) {
    process.stdout.write(`${JSON.stringify(run.report, null, 2)}\n`);
  },
};
