import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitTest } from '../../packages/e2e/scripts/code-cache-emit.ts';

const trace = {
  schemaVersion: 'trace-1', createdAt: '2026-11-10T00:00:00.000Z',
  payload: {
    executor: { name: 'fixture' }, summary: 'saved', startPath: '/', endPath: '/',
    actions: [{ name: 'type', summary: 'fill', target: { role: 'textbox', name: 'Name' }, value: "\"; throw new Error('injected'); //\n" }],
    endAnchors: [{ role: 'status', name: 'Result', text: 'Saved (1)' }],
  },
};

test('escapes source literals and regex metacharacters deterministically', () => {
  const source = emitTest(trace, 'fixture');
  assert.ok(source.includes(JSON.stringify(trace.payload.actions[0]!.value)));
  assert.ok(source.includes(JSON.stringify('^Saved \\(1\\)$')));
  assert.equal(source, emitTest(structuredClone(trace), 'fixture'));
  assert.ok(!source.includes(trace.createdAt));
});

test('rejects unsupported information instead of dropping it', () => {
  for (const extra of [{ within: 'row' }, { position: { index: 0, of: 2 } }, { selector: '#name' }, { states: ['checked'] }, { value: 'Ada' }]) {
    const input = structuredClone(trace);
    Object.assign(input.payload.actions[0]!.target, extra);
    assert.throws(() => emitTest(input, 'fixture'));
  }
  assert.throws(() => emitTest({}, 'fixture'));
  assert.throws(() => emitTest({ ...trace, payload: { ...trace.payload, truncated: true } }, 'fixture'));
  assert.throws(() => emitTest({ ...trace, payload: { ...trace.payload, endAnchors: [] } }, 'fixture'));
  assert.throws(() => emitTest({ ...trace, payload: { ...trace.payload, actions: [{ name: 'tool', summary: 'gap' }] } }, 'fixture'));
});
