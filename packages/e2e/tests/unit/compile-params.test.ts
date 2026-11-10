/**
 * The params digest `e2e compile` works out from the source is the one the
 * replay cache keys the call by at run time: the same params through
 * `validateParams` and `templateParams` digest alike, for every kind of value
 * the source can spell, and a different value digests differently.
 */

import { describe, expect, it } from 'vitest';
import { validateParams } from '../../src/agent/act-validation.ts';
import { paramsDigest } from '../../src/cache/identity.ts';
import { templateParams } from '../../src/cache/template.ts';
import { digestParams } from '../../src/compile/params.ts';
import { SourceFile } from '../../src/compile/sites.ts';
import { unique } from '../../src/params.ts';
import { secretHandle } from '../../src/secrets.ts';

const context = {
  secretPurposes: new Map([
    ['admin.password', 'password'],
    ['pin', 'generic-secret'],
  ]),
  usernames: new Map([['admin', 'admin@example.test']]),
};

/** The params of the one call in a test whose body is `call`. */
function sourceParams(call: string, preamble = '') {
  const text = `${preamble}test('x', async ({ agent }) => {\n  await ${call};\n});\n`;
  return new SourceFile('t.e2e.ts', text).testAt(preamble.split('\n').length)!.sites[0]!.params;
}

/** The digest the runtime keys params by. */
function runtimeDigest(params: Parameters<typeof validateParams>[0]): string {
  const { projected, templates } = validateParams(params, 'agent.act');
  return paramsDigest(projected === undefined ? undefined : templateParams(projected, templates));
}

describe('digestParams', () => {
  it('matches the runtime key for literals, arrays, nested objects, unique() values, secrets, and usernames', () => {
    const source = sourceParams(
      "agent.act('a', { params: { email: account.username, password: account.password, pin: secrets.get('pin'), label: unique(name), nested: { id: unique(`n-${id}`), 'a/b~c': [1, -2, true, null, 'x'] } } })",
      "const account = credentials.user('admin');\n",
    );
    const runtime = runtimeDigest({
      email: 'admin@example.test',
      password: secretHandle({ name: 'admin.password', purpose: 'password' }),
      pin: secretHandle({ name: 'pin', purpose: 'generic-secret' }),
      label: unique('Cabin 1'),
      nested: { id: unique('n-7'), 'a/b~c': [1, -2, true, null, 'x'] },
    });
    expect(source).toBeDefined();
    expect(digestParams(source!, context)).toBe(runtime);
  });

  it('matches the runtime key for a call with no params, and tells other values apart', () => {
    expect(digestParams(sourceParams("agent.act('a')")!, context)).toBe(runtimeDigest(undefined));
    expect(digestParams(sourceParams("agent.act('a', { params: { name: 'Grace' } })")!, context)).not.toBe(runtimeDigest({ name: 'Ada' }));
  });

  it('gives no digest for a secret or a credential the config does not name', () => {
    expect(digestParams(sourceParams("agent.act('a', { params: { pin: secrets.get('other') } })")!, context)).toBeUndefined();
    expect(digestParams(sourceParams("agent.act('a', { params: { email: credentials.user('ghost').username } })")!, context)).toBeUndefined();
  });
});
