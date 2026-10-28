// Dependency-free lifecycle controls, not browser/feature acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert(process.connected && process.send);
const mode = process.argv[2];
assert(['cli-exit-worker-lingers', 'anchor-exits-empty', 'worker'].includes(mode));
if (mode === 'worker') {
  setInterval(() => undefined, 1_000);
  process.send({ type: 'worker-ready' });
} else if (mode === 'anchor-exits-empty') {
  process.send({ type: 'empty-anchor-terminal' }, () => process.exit(0));
} else {
  // The CLI exits after its child is ready. That child intentionally survives
  // it, but shares THIS persistent anchor's detached group.
  const cliCode = `const {fork}=require('node:child_process');
const worker=fork(${JSON.stringify(fileURLToPath(new URL('./mask-owned-group-fixture.mjs', import.meta.url)))},['worker'],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
worker.once('message',()=>{process.send({workerPid:worker.pid},()=>{worker.disconnect();process.exit(0)})});`;
  const cli = spawn(process.execPath, ['-e', cliCode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: false });
  let workerPid;
  cli.once('message', (message) => { workerPid = message.workerPid; });
  cli.once('exit', (code) => process.send({ type: 'cli-terminal', code, workerPid }));
  // Remain alive after CLI exit until the parent kills this owned group.
  setInterval(() => undefined, 1_000);
  process.on('SIGTERM', () => undefined);
  process.on('disconnect', () => process.kill(-process.pid, 'SIGKILL'));
}
