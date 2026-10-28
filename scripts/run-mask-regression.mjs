// HELD: one browser's15 loopback regression cases, under an owned clean runtime.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeAnchoredGroup, groupAbsent } from './mask-owned-group.mjs';
import { loadMaskBrowserRuntime } from '../packages/web/tests/helpers/mask-browser-runtime.mjs';

assert.equal(process.argv.length, 4);
assert(['darwin', 'linux'].includes(process.platform), 'exact owned process-group fallback requires POSIX');
const root = resolvePath(process.argv[2]);
const browser = process.argv[3];
assert(['chromium', 'firefox', 'webkit'].includes(browser));
const runtime = loadMaskBrowserRuntime(root);
assert.equal(runtime.version, '1.64.1');
const type = runtime.browsers[browser];
const env = Object.fromEntries(['PATH', 'HOME', 'NODE_EXTRA_CA_CERTS'].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const output = await mkdtemp(join(tmpdir(), 'e2e-mask-supervisor-'));
const limit = (promise, milliseconds) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('supervisor deadline')), milliseconds); })]).finally(() => clearTimeout(timer));
};
let server;
let browserProcess;
let child;
let exitPromise;
let stopping;
let deadlineExceeded = false;
let cleanupFailed = false;
let startupFailed = false;
let protocolFailed = false;
let overflow = false;
let unexpectedAnchorExit = false;
let unexpectedBrowserExit = false;
let childTerminationStarted = false;
let browserTerminationStarted = false;
let childGroup;
let browserGroup;
let anchorReady = false;
let terminalResult;
let stdout = '';
let stderr = '';
let resolveTerminal;
let resolveAnchor;
const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
const anchor = new Promise((resolve) => { resolveAnchor = resolve; });

const emergency = () => {
  // Hard failure only. Signal only actual live anchors, never a cached number
  // after exit. Normal success additionally requires full group absence below.
  for (const owned of [browserProcess, child]) {
    if (!owned?.pid) continue;
    try {
      if (owned.exitCode === null && owned.signalCode === null) process.kill(-owned.pid, 'SIGKILL');
      else if (!groupAbsent(owned.pid)) cleanupFailed = true;
    } catch (error) { if (error.code !== 'ESRCH') cleanupFailed = true; }
  }
};
const shutdown = () => stopping ??= (async () => {
  try {
    if (child?.connected) {
      child.send({ type: 'stop' }, () => {});
      await limit(anchor, 3_000).catch(() => { cleanupFailed = true; });
    }
  } finally {
    try {
      if (browserProcess) {
        // Do not let graceful browser-leader exit discard the ownership proof.
        // Kill the exact group while its returned leader is still alive, then
        // confirm absence. An already exited leader is only probed, not killed.
        browserTerminationStarted = true;
        browserGroup = await closeAnchoredGroup(browserProcess);
      }
    } catch { cleanupFailed = true; }
    finally {
      try { if (server) await limit(server.close(), 1_000); }
      catch { cleanupFailed = true; }
      finally {
        try {
          if (child) {
            childTerminationStarted = true;
            childGroup = await closeAnchoredGroup(child);
            if (!childGroup.anchorWasAlive) unexpectedAnchorExit = true;
          }
        } catch { cleanupFailed = true; }
        finally {
          if (exitPromise) await limit(exitPromise, 1_000).catch(() => { cleanupFailed = true; });
        }
      }
    }
  }
})();
const soft = setTimeout(() => { deadlineExceeded = true; void shutdown(); }, 110_000);
const hard = setTimeout(() => { deadlineExceeded = true; emergency(); process.exit(124); }, 120_000);
process.on('SIGTERM', () => { deadlineExceeded = true; void shutdown(); });
process.on('SIGINT', () => { deadlineExceeded = true; void shutdown(); });
let exit;
try {
  server = await type.launchServer({ headless: true, host: '127.0.0.1', timeout: 20_000, env, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  browserProcess = server.process();
  assert(browserProcess?.pid);
  browserProcess.once('exit', () => { if (!browserTerminationStarted) unexpectedBrowserExit = true; });
  if (stopping || deadlineExceeded) {
    browserTerminationStarted = true;
    try { browserGroup = await closeAnchoredGroup(browserProcess); }
    finally { await limit(server.close(), 1_000).catch(() => { cleanupFailed = true; }); }
    throw new Error('late browser launch cancelled');
  }
  child = fork(join(dirname(fileURLToPath(import.meta.url)), 'mask-regression-child.mjs'), [root, browser], {
    execPath: process.execPath, execArgv: [], cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const collect = (stream) => (data) => {
    const text = data.toString();
    if ((stream === 'stdout' ? stdout : stderr).length + text.length > 256_000) { overflow = true; void shutdown(); return; }
    if (stream === 'stdout') stdout += text;
    else stderr += text;
  };
  child.stdout.on('data', collect('stdout'));
  child.stderr.on('data', collect('stderr'));
  exitPromise = new Promise((resolve) => {
    child.once('error', () => resolve({ code: null, signal: null, spawnFailed: true }));
    child.once('exit', (code, signal) => {
      if (!childTerminationStarted) unexpectedAnchorExit = true;
      resolve({ code, signal });
    });
  });
  child.on('message', (message) => {
    if (message?.type === 'mask-tests-terminal' && terminalResult === undefined &&
      (message.code === null || (Number.isInteger(message.code) && message.code >= 0 && message.code <= 255)) &&
      (message.signal === null || (typeof message.signal === 'string' && /^SIG[A-Z0-9]+$/.test(message.signal))) &&
      typeof message.cancelled === 'boolean' && typeof message.cleanupFailed === 'boolean') {
      terminalResult = { code: message.code, signal: message.signal, cancelled: message.cancelled, cleanupFailed: message.cleanupFailed };
      resolveTerminal();
    } else if (message?.type === 'mask-anchor-ready' && terminalResult !== undefined && !anchorReady) {
      anchorReady = true;
      resolveAnchor();
    } else { protocolFailed = true; void shutdown(); }
  });
  child.send({ type: 'owned-mask-browser', endpoint: server.wsEndpoint() });
  await Promise.race([terminal, exitPromise]);
} catch { startupFailed = true; }
finally {
  await shutdown();
  if (exitPromise) exit = await limit(exitPromise, 1_000).catch(() => undefined);
  clearTimeout(soft);
}
await writeFile(join(output, 'stdout.log'), stdout, { mode: 0o600 });
await writeFile(join(output, 'stderr.log'), stderr, { mode: 0o600 });
const receipt = {
  scope: 'LOCAL_MASK_REGRESSION_ONLY', browser, environmentKeys: Object.keys(env),
  deadlineExceeded, startupFailed, protocolFailed, cleanupFailed, overflow,
  tests: terminalResult, anchorReady, unexpectedAnchorExit, unexpectedBrowserExit,
  childGroup, browserGroup, anchorExit: exit,
};
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ output, ...receipt }));
clearTimeout(hard);
if (deadlineExceeded || startupFailed || protocolFailed || cleanupFailed || overflow || unexpectedAnchorExit || unexpectedBrowserExit ||
  !anchorReady || !childGroup?.groupAbsent || !browserGroup?.groupAbsent || !childGroup.killedWhileAnchored ||
  terminalResult?.code !== 0 || terminalResult?.signal !== null || terminalResult?.cancelled || terminalResult?.cleanupFailed) process.exitCode = 1;
