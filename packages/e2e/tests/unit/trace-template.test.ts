/** Parameter templating: run-unique string params become placeholders in a recording and are filled at replay. */

import { describe, expect, it } from 'vitest';
import { paramsDigest } from '../../src/cache/identity.ts';
import {
  expandText,
  expandTrace,
  paramTemplates,
  paramsShape,
  templateText,
  templateTrace,
} from '../../src/cache/template.ts';
import type { ActionTrace } from '../../src/cache/trace.ts';

const secret = { kind: 'secret', name: 'admin', purpose: 'password' } as const;

function trace(name: string): ActionTrace {
  return {
    actions: [
      { name: 'navigate', summary: 'navigate to "/companies/create"', url: '/companies/create' },
      { name: 'type', summary: `type "${name}" into textbox "Name"`, target: { role: 'textbox', name: 'Name' }, value: name },
      { name: 'typeSecret', summary: 'fill secret "admin" into textbox "Password"', target: { role: 'textbox', name: 'Password' }, secret: 'admin' },
      { name: 'tap', summary: `tap option "${name}" in row "${name}"`, target: { role: 'option', name, within: name } },
      { name: 'press', summary: 'press "Enter" on textbox "Name"', target: { role: 'textbox', name: 'Name' }, key: 'Enter' },
    ],
    executor: { name: 'test' },
    summary: `created ${name}`,
    startPath: '/companies',
    endPath: '/companies/123',
    endAnchors: [{ role: 'heading', name }],
  };
}

describe('paramTemplates', () => {
  it('collects templatable strings at any depth, longest first, and skips secrets, numbers, and short strings', () => {
    const templates = paramTemplates({
      name: 'Ada Lovelace',
      first: 'Ada',
      qty: 2,
      ok: 'ok',
      password: secret,
      address: { city: 'London', tags: ['vip', 'new-customer'] },
    });
    // Equal lengths fall back to the path, so the order is stable across runs.
    expect(templates).toEqual([
      { path: 'address.tags[1]', value: 'new-customer' },
      { path: 'name', value: 'Ada Lovelace' },
      { path: 'address.city', value: 'London' },
      { path: 'address.tags[0]', value: 'vip' },
      { path: 'first', value: 'Ada' },
    ]);
  });
});

describe('paramsShape and the key', () => {
  it('keys on the shape: templatable strings are one marker, everything else stays', () => {
    expect(paramsDigest({ name: 'E2E abc Company', website: 'https://a.example' })).toBe(
      paramsDigest({ name: 'E2E xyz Company', website: 'https://b.example' }),
    );
    expect(paramsDigest({ quantity: 2 })).not.toBe(paramsDigest({ quantity: 3 }));
    expect(paramsDigest({ code: 'ab' })).not.toBe(paramsDigest({ code: 'cd' }));
    expect(paramsDigest({ password: secret })).not.toBe(paramsDigest({ password: { ...secret, name: 'member' } }));
    expect(paramsDigest({ name: 'Ada Lovelace' })).not.toBe(paramsDigest({ title: 'Ada Lovelace' }));
    expect(paramsShape({ a: 'long enough', b: 1, c: null, d: [true, 'xyz'] })).toEqual({
      a: `${String.fromCharCode(0)}param`,
      b: 1,
      c: null,
      d: [true, `${String.fromCharCode(0)}param`],
    });
  });
});

describe('templateText and expandText', () => {
  it('round-trips, claims the longer value first, and never templates inside a placeholder', () => {
    const params = { name: 'name', full: 'Ada name' };
    const templates = paramTemplates(params);
    const templated = templateText('tap "Ada name" then "name" in the name column', templates);
    expect(templated).toBe('tap "{{param:full}}" then "{{param:name}}" in the {{param:name}} column');
    expect(expandText(templated, params)).toBe('tap "Ada name" then "name" in the name column');
    expect(expandText(templated, { name: 'Grace', full: 'Grace Hopper' })).toBe('tap "Grace Hopper" then "Grace" in the Grace column');
  });

  it('refuses to expand a placeholder the current params cannot fill', () => {
    expect(expandText('tap "{{param:name}}"', {})).toBeUndefined();
    expect(expandText('tap "{{param:name}}"', { name: 'ab' })).toBeUndefined();
    expect(expandText('tap "{{param:name}}"', { name: 7 })).toBeUndefined();
    expect(expandText('no placeholders', undefined)).toBe('no placeholders');
  });
});

describe('templateTrace and expandTrace', () => {
  it('templates inputs, descriptors, anchors, and summaries, and expands them with another run\'s value', () => {
    const recorded = templateTrace(trace('E2E abc Company'), { name: 'E2E abc Company' });
    expect(recorded.actions[1]).toMatchObject({ value: '{{param:name}}', summary: 'type "{{param:name}}" into textbox "Name"' });
    expect(recorded.actions[3]).toMatchObject({ target: { role: 'option', name: '{{param:name}}', within: '{{param:name}}' } });
    expect(recorded.endAnchors).toEqual([{ role: 'heading', name: '{{param:name}}' }]);
    expect(recorded.summary).toBe('created {{param:name}}');
    // Secrets and keys are never text a parameter produced.
    expect(recorded.actions[2]).toEqual(trace('E2E abc Company').actions[2]);
    expect(recorded.actions[4]).toEqual(trace('E2E abc Company').actions[4]);
    expect(recorded.truncated).toBeUndefined();

    expect(expandTrace(recorded, { name: 'E2E xyz Company' })).toEqual(trace('E2E xyz Company'));
    expect(expandTrace(recorded, { title: 'E2E xyz Company' })).toBeUndefined();
  });

  it('pins a templatable param the recording never spelled out, so a different value misses', () => {
    // The plan name steered the flow (a tap on "Pro") without appearing in it.
    const recorded = templateTrace(trace('Pro'), { plan: 'business', name: 'Pro' });
    expect(recorded.literalParams).toEqual({ plan: 'business' });
    expect(recorded.actions[3]).toMatchObject({ target: { name: '{{param:name}}' } });
    // Expansion fills the placeholders and keeps the pin, so a re-stage carries it forward.
    expect(expandTrace(recorded, { plan: 'business', name: 'Pro' })).toEqual({ ...trace('Pro'), literalParams: { plan: 'business' } });
    expect(expandTrace(recorded, { plan: 'starter', name: 'Pro' })).toBeUndefined();
    expect(expandTrace(recorded, { name: 'Pro' })).toBeUndefined();
  });

  it('leaves a trace without templatable params untouched and expands it as a no-op', () => {
    const plain = trace('Acme');
    expect(templateTrace(plain, { qty: 2 })).toEqual(plain);
    expect(templateTrace(plain, undefined)).toEqual(plain);
    expect(expandTrace(plain, undefined)).toEqual(plain);
  });

  it('poisons a recording whose text already spells a placeholder', () => {
    const odd: ActionTrace = { ...trace('Acme Corp'), summary: 'typed {{param:name}} literally' };
    expect(templateTrace(odd, { name: 'Acme Corp' }).truncated).toBe(true);
  });
});
