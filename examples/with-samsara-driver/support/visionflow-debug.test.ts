import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DebugSession } from '@samsara-dev/visionflow';
import { visionFlowDebug } from './visionflow-debug.ts';

// Synthetic PNG fixture, not device evidence.
const frame = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

test('model and replay actions reach the real SDK as distinct screenshot steps', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'e2e-visionflow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const screenshot = join(directory, 'frame.png');
  await writeFile(screenshot, frame);
  const artifacts = new Map<string, Buffer>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method === 'POST' && request.url === '/api/sessions') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ sessionId: 'test-actions' }));
      return;
    }
    if (request.method === 'PUT') {
      artifacts.set(
        decodeURIComponent(request.url?.split('/').at(-1) ?? ''),
        Buffer.concat(chunks),
      );
      response.writeHead(200).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const session = new DebugSession({
    remote: { baseUrl: `http://127.0.0.1:${address.port}` },
  });
  const labels: (string | undefined)[] = [];
  const links: string[] = [];
  const debug = visionFlowDebug(
    session,
    {
      async screenshot(label) {
        labels.push(label);
        return screenshot;
      },
    },
    (message) => links.push(message),
  );

  // The action-budget index resets between acts and can skip failed attempts.
  await debug.onAction({
    index: 3,
    action: 'tap',
    source: 'model',
    summary: 'tap Assets',
  });
  await debug.onAction({
    index: 1,
    action: 'tap',
    source: 'replay',
    summary: 'tap Assets',
  });
  await debug.finish(true);

  assert.deepEqual(labels, ['1: model tap', '2: replay tap']);
  assert.deepEqual(
    artifacts.get('step-001-host-after.png'),
    await readFile(screenshot),
  );
  assert.deepEqual(artifacts.get('step-002-host-after.png'), frame);
  const reportBytes = artifacts.get('session.json');
  assert.ok(reportBytes, 'the SDK must publish session.json');
  const report = JSON.parse(reportBytes.toString());
  assert.equal(report.totalRecordedSteps, 3);
  assert.deepEqual(
    report.stepArtifacts
      .slice(0, 2)
      .map((step: { hostPhase: { title: string } }) => step.hostPhase.title),
    labels,
  );
  assert.equal(report.testResult.status, 'passed');
  assert.equal(links.length, 3);
  assert.ok(links.every((link) => link.includes('/session/test-actions/')));
});

test('recording errors reject the hook instead of hiding a missing action', async () => {
  const failure = new Error('screenshot failed');
  let recorded = false;
  const debug = visionFlowDebug(
    {
      async recordHostPhase() {
        recorded = true;
      },
      async recordTestResult() {},
      getViewerUrl() {
        return undefined;
      },
    },
    {
      screenshot() {
        return Promise.reject(failure);
      },
    },
  );
  await assert.rejects(
    async () =>
      debug.onAction({
        index: 1,
        action: 'tap',
        source: 'model',
        summary: 'tap Assets',
      }),
    failure,
  );
  assert.equal(recorded, false);
});

test('finalization records a failed test even when no action completed', async () => {
  const phases: Parameters<DebugSession['recordHostPhase']>[0][] = [];
  const results: Parameters<DebugSession['recordTestResult']>[0][] = [];
  const debug = visionFlowDebug(
    {
      async recordHostPhase(phase) {
        phases.push(phase);
      },
      async recordTestResult(result) {
        results.push(result);
      },
      getViewerUrl() {
        return 'http://localhost/session/failed-test/';
      },
    },
    {
      async screenshot() {
        throw new Error('must not capture');
      },
    },
  );
  await debug.finish(false);
  assert.equal(phases[0]?.success, false);
  assert.equal(results[0]?.status, 'failed');
});
