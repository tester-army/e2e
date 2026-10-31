/**
 * An engine server process for the protocol tests: a toy engine served over
 * stdio, which reports what it received on stderr so a test can read it off
 * a failure message. `initializationOptions.crashOnObserve` makes `observe`
 * exit the process mid-request.
 */

import { defineEngine, serveEngine } from '../../src/engine/index.ts';

await serveEngine((options) => {
  const crash = (options as { crashOnObserve?: boolean } | undefined)?.crashOnObserve === true;
  return defineEngine({
    name: 'toy-server',
    version: '1.0.0',
    spiVersion: 1,
    platform: 'toy',
    actions: ['tap'],
    async observe() {
      if (crash) {
        process.stderr.write('toy server: crashing on purpose\n');
        process.exit(7);
      }
      return {
        root: { ref: { id: 'root', revision: '' }, role: 'root', children: [{ ref: { id: 'n1', revision: '' }, role: 'button', name: 'Save' }] },
        viewport: { width: 100, height: 100 },
        location: `pid:${String(process.pid)}`,
      };
    },
    async perform() {},
    async init(info) {
      info.log(`init slot ${String(info.workerSlot)}`);
    },
  });
});
