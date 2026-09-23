/** `unique()` params: slots in the key and the recording, filled from each call. */

import { describe, expect, it } from 'vitest';
import { validateParams } from '../../src/agent/act-validation.ts';
import { paramsDigest } from '../../src/cache/identity.ts';
import {
  expandText,
  expandTrace,
  paramPointer,
  templateParams,
  templateText,
  templateTrace,
  type ParamTemplate,
} from '../../src/cache/template.ts';
import type { ActionTrace } from '../../src/cache/trace.ts';
import { unique } from '../../src/params.ts';

const admin = { kind: 'secret', name: 'admin', purpose: 'password' } as const;

function values(templates: readonly ParamTemplate[]): ReadonlyMap<string, string> {
  return new Map(templates.map((template) => [template.pointer, template.value]));
}

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

describe('unique() through validateParams', () => {
  it('projects the value for the model and lists the pointer for the cache, at any depth', () => {
    const { projected, templates } = validateParams({
      name: unique('E2E abc Company'),
      plan: 'pro',
      qty: 2,
      owner: { email: unique('a@b.test'), tags: ['vip', unique('new-customer')] },
      'a/b': unique('slash'),
    });
    expect(projected).toEqual({
      name: 'E2E abc Company',
      plan: 'pro',
      qty: 2,
      owner: { email: 'a@b.test', tags: ['vip', 'new-customer'] },
      'a/b': 'slash',
    });
    expect(templates).toEqual([
      { pointer: '/name', value: 'E2E abc Company' },
      { pointer: '/owner/email', value: 'a@b.test' },
      { pointer: '/owner/tags/1', value: 'new-customer' },
      { pointer: '/a~1b', value: 'slash' },
    ]);
  });

  it('refuses a blank value and one that spells a placeholder', () => {
    expect(() => unique('')).toThrow(/non-empty string/);
    expect(() => unique('  ')).toThrow(/non-empty string/);
    expect(() => unique(7 as never)).toThrow(/non-empty string/);
    expect(() => unique('x {{param:/y}}')).toThrow(/placeholder/);
  });

  it('escapes keys the JSON Pointer way, so two shapes never share a pointer', () => {
    expect(paramPointer('', 'a/b')).toBe('/a~1b');
    expect(paramPointer('/x', 'a~b')).toBe('/x/a~0b');
    expect(paramPointer('/tags', 0)).toBe('/tags/0');
  });

  it('round-trips a key that contains a closing brace', () => {
    const templates = [{ pointer: paramPointer('', 'a}b'), value: 'Acme Corp' }];
    const templated = templateText('tap "Acme Corp"', templates);
    expect(templated).toBe('tap "{{param:/a}b}}"');
    expect(expandText(templated, values([{ pointer: '/a}b', value: 'Globex' }]))).toBe('tap "Globex"');
  });
});

describe('templateParams and the key', () => {
  it('puts a placeholder where each unique value was and leaves everything else literal', () => {
    const templates = [{ pointer: '/name', value: 'E2E abc' }, { pointer: '/owner/tags/1', value: 'new' }];
    expect(templateParams({ name: 'E2E abc', qty: 2, s: admin, owner: { tags: ['vip', 'new'] } }, templates)).toEqual({
      name: '{{param:/name}}',
      qty: 2,
      s: admin,
      owner: { tags: ['vip', '{{param:/owner/tags/1}}'] },
    });
    expect(templateParams(undefined, [])).toEqual({});
  });

  it('keys two calls apart only by what they did not mark', () => {
    const key = (name: string, plan: string) =>
      paramsDigest(templateParams({ name, plan }, [{ pointer: '/name', value: name }]));
    expect(key('E2E abc', 'pro')).toBe(key('E2E xyz', 'pro'));
    expect(key('E2E abc', 'pro')).not.toBe(key('E2E abc', 'starter'));
    // Marking is part of the shape: the same values, marked and unmarked, are two entries.
    expect(key('E2E abc', 'pro')).not.toBe(paramsDigest(templateParams({ name: 'E2E abc', plan: 'pro' }, [])));
  });
});

describe('templateText and expandText', () => {
  it('round-trips, claims the longer value first, and never templates inside a placeholder', () => {
    const templates = [{ pointer: '/name', value: 'name' }, { pointer: '/full', value: 'Ada name' }];
    const templated = templateText('tap "Ada name" then "name" in the name column', templates);
    expect(templated).toBe('tap "{{param:/full}}" then "{{param:/name}}" in the {{param:/name}} column');
    expect(expandText(templated, values(templates))).toBe('tap "Ada name" then "name" in the name column');
    expect(expandText(templated, values([{ pointer: '/name', value: 'Grace' }, { pointer: '/full', value: 'Grace Hopper' }]))).toBe(
      'tap "Grace Hopper" then "Grace" in the Grace column',
    );
  });

  it('refuses to expand a placeholder the current call did not mark', () => {
    expect(expandText('tap "{{param:/name}}"', values([]))).toBeUndefined();
    expect(expandText('tap "{{param:/name}}"', values([{ pointer: '/title', value: 'x' }]))).toBeUndefined();
    expect(expandText('no placeholders', values([]))).toBe('no placeholders');
  });
});

describe('templateTrace and expandTrace', () => {
  const name = (value: string): ParamTemplate[] => [{ pointer: '/name', value }];

  it('templates upload paths, so a file named through unique() is re-resolved from each run\'s value', () => {
    const upload = (file: string): ActionTrace => ({
      actions: [
        {
          name: 'upload',
          summary: `upload "${file}", "fixtures/static.txt" to button "Attachment"`,
          target: { role: 'button', name: 'Attachment' },
          paths: [file, 'fixtures/static.txt'],
        },
      ],
      executor: { name: 'test' },
      summary: 'attached',
      startPath: '/',
    });
    const file = (value: string): ParamTemplate[] => [{ pointer: '/file', value }];
    const recorded = templateTrace(upload('fixtures/run-1.json'), file('fixtures/run-1.json'))!;
    expect(recorded.actions[0]).toMatchObject({
      paths: ['{{param:/file}}', 'fixtures/static.txt'],
      summary: 'upload "{{param:/file}}", "fixtures/static.txt" to button "Attachment"',
    });
    expect(expandTrace(recorded, file('fixtures/run-2.json'))).toEqual(upload('fixtures/run-2.json'));
    expect(expandTrace(recorded, [])).toBeUndefined();
  });

  it('templates inputs, descriptors, anchors, and summaries, and expands them with another run\'s value', () => {
    const recorded = templateTrace(trace('E2E abc Company'), name('E2E abc Company'))!;
    expect(recorded.actions[1]).toMatchObject({ value: '{{param:/name}}', summary: 'type "{{param:/name}}" into textbox "Name"' });
    expect(recorded.actions[3]).toMatchObject({ target: { role: 'option', name: '{{param:/name}}', within: '{{param:/name}}' } });
    expect(recorded.endAnchors).toEqual([{ role: 'heading', name: '{{param:/name}}' }]);
    expect(recorded.summary).toBe('created {{param:/name}}');
    // Secrets and keys are never text a parameter produced.
    expect(recorded.actions[2]).toEqual(trace('E2E abc Company').actions[2]);
    expect(recorded.actions[4]).toEqual(trace('E2E abc Company').actions[4]);

    expect(expandTrace(recorded, name('E2E xyz Company'))).toEqual(trace('E2E xyz Company'));
    expect(expandTrace(recorded, [{ pointer: '/title', value: 'E2E xyz Company' }])).toBeUndefined();
    expect(expandTrace(recorded, [])).toBeUndefined();
  });

  it('leaves a trace without templates untouched and expands it as a no-op', () => {
    const plain = trace('Acme');
    expect(templateTrace(plain, [])).toEqual(plain);
    expect(expandTrace(plain, [])).toEqual(plain);
    // A marked value the text never spelled leaves no slot; the recording is literal.
    expect(templateTrace(plain, name('Globex'))).toEqual(plain);
  });

  it('refuses to template a recording whose text already spells a placeholder', () => {
    const odd: ActionTrace = { ...trace('Acme Corp'), summary: 'typed {{param:/name}} literally' };
    expect(templateTrace(odd, name('Acme Corp'))).toBeUndefined();
    expect(templateTrace(odd, [])).toBeUndefined();
  });

  it('refuses to template when two marked params share a spelling, since the text cannot say which one it spelled', () => {
    const shared = [...name('Acme Corp'), { pointer: '/slug', value: 'Acme Corp' }];
    expect(templateTrace(trace('Acme Corp'), shared)).toBeUndefined();
    // One value is the other's encoded form.
    const aliased = [...name('Acme Corp'), { pointer: '/slug', value: 'Acme%20Corp' }];
    expect(templateTrace(trace('Acme Corp'), aliased)).toBeUndefined();
  });

  it('spells the form encoding as a form submission does, and skips the encodings of a value that has none', () => {
    expect(templateText("?q=Ada%27s+%28new%29+shop%7E%21", [{ pointer: '/q', value: "Ada's (new) shop~!" }])).toBe('?q={{param:/q|form}}');
    // An unpaired surrogate cannot be percent-encoded; the value itself still templates and staging does not throw.
    const odd = 'bad \ud800 value';
    expect(templateText(`typed ${odd}`, [{ pointer: '/v', value: odd }])).toBe('typed {{param:/v}}');
    expect(expandText('{{param:/v|uri}}', values([{ pointer: '/v', value: odd }]))).toBeUndefined();
  });

  it('templates the location paths too, in every spelling a URL gives the value, so a value in the URL follows the run', () => {
    const moved: ActionTrace = { ...trace('Acme & Co'), endPath: '/companies/Acme%20%26%20Co?search=Acme+%26+Co&name=Acme & Co' };
    const recorded = templateTrace(moved, name('Acme & Co'))!;
    expect(recorded.endPath).toBe('/companies/{{param:/name|uri}}?search={{param:/name|form}}&name={{param:/name}}');
    expect(expandTrace(recorded, name('Globex Inc'))?.endPath).toBe('/companies/Globex%20Inc?search=Globex+Inc&name=Globex Inc');
    // A value no encoding changes has one spelling and one placeholder.
    expect(templateText('/tags/vip?q=vip', [{ pointer: '/tag', value: 'vip' }])).toBe('/tags/{{param:/tag}}?q={{param:/tag}}');
  });

  it('spells a value as the slug an app derives for a record path, and fills it back the same way', () => {
    const templates = [{ pointer: '/name', value: 'E2E abc Company' }];
    expect(templateText('/companies/e2e-abc-company?q=E2E%20abc%20Company', templates)).toBe('/companies/{{param:/name|slug}}?q={{param:/name|uri}}');
    expect(expandText('/companies/{{param:/name|slug}}', values([{ pointer: '/name', value: "Ada's Shop & Co" }]))).toBe('/companies/ada-s-shop-co');
    // A value whose slug is empty has no slug spelling.
    expect(templateText('x -- y', [{ pointer: '/v', value: '--' }])).toBe('x {{param:/v}} y');
  });

  it('refuses a placeholder whose encoding it does not know', () => {
    expect(expandText('/x/{{param:/name|base64}}', values(name('Acme')))).toBeUndefined();
  });
});
