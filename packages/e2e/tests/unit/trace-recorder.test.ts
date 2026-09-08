/** Step trace recording: durable descriptors, redaction, verbatim inputs. */

import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { describeTarget } from '../../src/agent/actions.ts';
import { TraceRecorder } from '../../src/cache/recorder.ts';
import { buildTraceEntry, MAX_TRACE_INPUT_CHARS, readTraceEntry } from '../../src/cache/trace.ts';
import { createRedactor } from '../../src/internal/redact.ts';

const upgradeButton: SemanticNode = {
  ref: { id: 'n42', revision: 'r1' },
  role: 'button',
  name: 'Upgrade',
  text: 'Upgrade',
  attributes: { 'data-testid': 'upgrade-cta' },
  selector: '[data-testid="upgrade-cta"]',
};

const passwordField: SemanticNode = {
  ref: { id: 'n7', revision: 'r1' },
  role: 'textbox',
  name: 'Password',
  inputPurpose: 'password',
  states: { secure: true },
};

function makeRecorder(options: { maxActions?: number; secrets?: ReadonlyMap<string, string> } = {}) {
  return new TraceRecorder({
    redact: createRedactor(options.secrets ?? new Map()),
    testIdAttribute: 'data-testid',
    ...(options.maxActions === undefined ? {} : { maxActions: options.maxActions }),
  });
}

const conclusion = {
  executor: { name: 'example-agent', version: '1' },
  recordedFor: { testId: 'tests/billing.e2e.ts::upgrade', targetId: 'web', instructionDigest: 'c'.repeat(64) },
  summary: 'done',
};

describe('TraceRecorder', () => {
  it('records durable descriptors and readable summaries', () => {
    const recorder = makeRecorder();
    recorder.record({ name: 'navigate', url: '/billing' });
    recorder.record({ name: 'tap', node: upgradeButton });
    recorder.record({ name: 'type', node: upgradeButton, value: 'yearly' });
    const trace = recorder.finalize({ ...conclusion, startPath: '/settings' });
    expect(trace?.actions).toHaveLength(3);
    expect(trace?.actions[1]).toMatchObject({
      name: 'tap',
      target: {
        role: 'button',
        name: 'Upgrade',
        testId: 'upgrade-cta',
        selector: '[data-testid="upgrade-cta"]',
      },
    });
    expect(trace?.actions[0]?.summary).toBe('navigate to "/billing"');
    expect(trace?.actions[1]?.summary).toBe('tap button "Upgrade"');
    expect(trace?.actions[2]?.summary).toBe('type "yearly" into button "Upgrade"');
    expect(trace?.startPath).toBe('/settings');
    expect(trace?.truncated).toBeUndefined();
  });

  it('always finalizes into a trace the reader accepts', () => {
    const recorder = makeRecorder();
    recorder.record({ name: 'tap', node: upgradeButton });
    recorder.recordGap('seed_cart');
    const trace = recorder.finalize(conclusion);
    expect(trace).toBeDefined();
    expect(readTraceEntry(JSON.parse(JSON.stringify(buildTraceEntry(trace!))))).toBeDefined();
  });

  it('records a secret fill by name only, with page strings redacted', () => {
    const secrets = new Map([['member-password', 'hunter2']]);
    const recorder = makeRecorder({ secrets });
    recorder.record({ name: 'typeSecret', node: passwordField, secret: 'member-password' });
    recorder.record({ name: 'tap', node: { ...upgradeButton, name: 'Greeting hunter2' } });
    const trace = recorder.finalize(conclusion);
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).toContain('<secret:member-password>');
    expect(serialized).toContain('"secret":"member-password"');
    // Descriptor redaction alone never poisons the trace.
    expect(trace?.truncated).toBeUndefined();
  });

  it('poisons the trace instead of bending a replay input', () => {
    const secrets = new Map([['pw', 'hunter2']]);
    // A typed value carrying a registered secret would be altered by
    // redaction; a value over the cap cannot be stored whole. Both poison.
    const leaking = makeRecorder({ secrets });
    leaking.record({ name: 'type', node: upgradeButton, value: 'say hunter2' });
    const leaked = leaking.finalize(conclusion);
    expect(leaked?.truncated).toBe(true);
    expect(JSON.stringify(leaked)).not.toContain('hunter2');

    const oversized = makeRecorder({});
    oversized.record({
      name: 'navigate',
      url: `/callback?token=${'x'.repeat(MAX_TRACE_INPUT_CHARS)}`,
    });
    expect(oversized.finalize(conclusion)?.truncated).toBe(true);
  });

  it('marks a gap that ends replay for a mutating project tool', () => {
    const recorder = makeRecorder();
    recorder.record({ name: 'tap', node: upgradeButton });
    recorder.recordGap('seed_cart');
    const trace = recorder.finalize(conclusion);
    expect(trace?.actions[1]).toEqual({ name: 'tool', summary: 'tool seed_cart' });
  });

  it('truncates past the action cap instead of dropping the flag', () => {
    const recorder = makeRecorder({ maxActions: 2 });
    recorder.record({ name: 'tap', node: upgradeButton });
    recorder.record({ name: 'tap', node: upgradeButton });
    recorder.record({ name: 'tap', node: upgradeButton });
    const trace = recorder.finalize(conclusion);
    expect(trace?.actions).toHaveLength(2);
    expect(trace?.truncated).toBe(true);
  });

  it('returns no trace for a step that committed nothing', () => {
    expect(makeRecorder().finalize(conclusion)).toBeUndefined();
  });
});

describe('describeTarget', () => {
  it('drops text duplicating the name and never records values', () => {
    const identity = (text: string): string => text;
    expect(describeTarget(upgradeButton, identity, 'data-testid')?.text).toBeUndefined();
    const described = describeTarget(
      { ...passwordField, value: 's3cr3t' },
      identity,
      'data-testid',
    );
    expect(described).toEqual({ role: 'textbox', name: 'Password', inputPurpose: 'password' });
    expect(JSON.stringify(described)).not.toContain('s3cr3t');
  });

  it('returns undefined for a node with nothing durable to say', () => {
    expect(
      describeTarget({ ref: { id: 'n1', revision: 'r1' } }, (text) => text, 'data-testid'),
    ).toBeUndefined();
  });
});
