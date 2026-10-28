/** Held dependency-free failure injection: real POSIX processes, no browsers/network/model. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeAnchoredGroup, groupAbsent } from './mask-owned-group.mjs';

const env = Object.fromEntries(['PATH', 'HOME', 'NODE_EXTRA_CA_CERTS'].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const limit = (promise) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('lifecycle control deadline')), 1_500); })]).finally(() => clearTimeout(timer));
};
const start = (mode) => fork(fileURLToPath(new URL('./mask-owned-group-fixture.mjs', import.meta.url)), [mode], {
  execPath: process.execPath, execArgv: [], env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});

test('an exited CLI cannot release the persistent group anchor while its worker lingers', { timeout: 5_000, skip: process.platform === 'win32' }, async () => {
  const anchor = start('cli-exit-worker-lingers');
  const exited = once(anchor, 'exit');
  try {
    const [message] = await limit(once(anchor, 'message'));
    assert.equal(message.type, 'cli-terminal');
    assert.equal(message.code, 0);
    assert.equal(Number.isInteger(message.workerPid), true);
    assert.equal(process.kill(message.workerPid, 0), true);
    assert.equal(anchor.exitCode, null);
    assert.equal(anchor.signalCode, null);
    assert.equal(groupAbsent(anchor.pid), false);
    const result = await closeAnchoredGroup(anchor);
    assert.deepEqual(result, { anchorWasAlive: true, killedWhileAnchored: true, groupAbsent: true });
    await limit(exited);
    assert.equal(groupAbsent(anchor.pid), true);
    assert.throws(() => process.kill(message.workerPid, 0), { code: 'ESRCH' });
  } finally {
    // If setup/assertion failed, terminate only while this exact anchor lives.
    // Once exited, closeAnchoredGroup only probes absence and fails if unclear.
    await closeAnchoredGroup(anchor);
  }
});

test('an already exited empty anchor is only probed, never signalled by a cached PGID', { timeout: 5_000, skip: process.platform === 'win32' }, async () => {
  const anchor = start('anchor-exits-empty');
  try {
    await limit(once(anchor, 'exit'));
    assert.deepEqual(await closeAnchoredGroup(anchor), { anchorWasAlive: false, killedWhileAnchored: false, groupAbsent: true });
  } finally { await closeAnchoredGroup(anchor); }
});
