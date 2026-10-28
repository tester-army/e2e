// Technical loopback regression only. The clean supervisor supplies its owned
// BrowserServer endpoint over IPC; never put it in an environment variable/log.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.argv.length, 4);
assert(process.connected && process.send, 'the owned-browser supervisor is required');
const root = resolvePath(process.argv[2]);
const browser = process.argv[3];
assert(['chromium', 'firefox', 'webkit'].includes(browser));
const webRoot = join(root, 'packages/web');
const require = createRequire(join(webRoot, 'package.json'));
let timer;
const received = await Promise.race([
  new Promise((resolve) => process.once('message', resolve)),
  new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned browser endpoint deadline')), 5_000); }),
]).finally(() => clearTimeout(timer));
assert.equal(received?.type, 'owned-mask-browser');
const endpoint = new URL(received.endpoint);
assert.equal(endpoint.protocol, 'ws:');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname));
const directory = await mkdtemp(join(tmpdir(), 'e2e-mask-vitest-'));
const configFile = join(directory, 'config.mjs');
// Inline project overrides keep the existing integration policy, worker ceiling,
// and45 exact cases. This private config is the only endpoint-bearing file.
const base = pathToFileURL(join(webRoot, 'vitest.config.ts')).href;
const config = `import base from ${JSON.stringify(base)};
export default {...base,test:{...base.test,projects:base.test.projects.map(project=>({...project,test:{...project.test,provide:{maskCaptureEndpoint:${JSON.stringify(endpoint.href)}},testNamePattern:${JSON.stringify(`^JavaScript-frame masked capture: ${browser}`)},fileParallelism:false,maxWorkers:1,minWorkers:1}}))}};
`;
await writeFile(configFile, config, { mode: 0o600 });
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
let child;
let cancelled = false;
let terminal = false;
let stopRequested = false;
let readySent = false;
const ready = () => {
  if (terminal && stopRequested && !readySent && process.connected) {
    readySent = true;
    process.send({ type: 'mask-anchor-ready' });
  }
};
const stop = () => {
  stopRequested = true;
  if (!terminal) {
    cancelled = true;
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  ready();
};
const deadline = setTimeout(stop, 100_000);
process.on('message', (message) => { if (message?.type === 'stop') stop(); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// The anchor deliberately outlives the CLI and never disconnects/exits after
// terminal results. Parent cleanup kills the group WHILE this identity lives.
// Losing the owning IPC parent is itself a reason to kill our own live group.
process.on('disconnect', () => process.kill(-process.pid, 'SIGKILL'));
const anchor = setInterval(() => undefined, 1_000);
let result;
let cleanupFailed = false;
try {
  child = spawn(process.execPath, [vitest, 'run', 'tests/integration/javascript-frame-masking.test.ts', '--config', configFile, '--project', 'integration'], {
    cwd: webRoot,
    detached: false,
    env: Object.fromEntries(['PATH', 'HOME', 'NODE_EXTRA_CA_CERTS'].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  result = await new Promise((resolve) => {
    child.once('error', () => resolve({ code: null, signal: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
} finally {
  try { await rm(directory, { recursive: true, force: true }); }
  catch { cleanupFailed = true; }
}
terminal = true;
clearTimeout(deadline);
assert(process.connected, 'the owned anchor parent disappeared');
process.send({ type: 'mask-tests-terminal', code: result?.code ?? null, signal: result?.signal ?? null, cancelled, cleanupFailed });
ready();
// Keep both IPC and the interval referenced until the parent's exact group kill.
void anchor;
