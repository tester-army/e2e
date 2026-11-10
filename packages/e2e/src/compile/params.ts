/**
 * The params digest the replay cache keys an `agent.act()` call by, worked
 * out from the params as the source spells them, so `e2e compile` can tell a
 * recording made with these params from one made with others.
 */

import { paramsDigest } from '../cache/identity.ts';
import { paramPointer, templateParams } from '../cache/template.ts';
import type { JsonValue } from '../types.ts';
import type { StaticValue } from './sites.ts';

/** What the config says a source-spelled secret or username projects to. */
export interface ParamsContext {
  /** Each secret's purpose by name: a credential password's and every `config.secrets` entry's. */
  readonly secretPurposes: ReadonlyMap<string, string>;
  /** Each credential's username by credential name. */
  readonly usernames: ReadonlyMap<string, string>;
}

/**
 * The digest, as `validateParams` projects params and `templateParams` slots
 * them before the key digests them: a secret as `{ kind, name, purpose }`, a
 * username as its value, each `unique()` value as its placeholder, and no
 * params as the empty object. Undefined when a secret or a credential is not
 * the config's, or the params are not an object.
 */
export function digestParams(params: StaticValue | null, context: ParamsContext): string | undefined {
  if (params === null) return paramsDigest(undefined);
  if (params.type !== 'object') return undefined;
  const templates: { pointer: string; value: string }[] = [];
  let known = true;
  const project = (value: StaticValue, pointer: string): JsonValue => {
    switch (value.type) {
      case 'json':
        return value.value;
      case 'array':
        return value.items.map((item, index) => project(item, paramPointer(pointer, index)));
      case 'object':
        return Object.fromEntries(value.entries.map(([key, item]) => [key, project(item, paramPointer(pointer, key))]));
      case 'unique':
        templates.push({ pointer, value: '' });
        return '';
      case 'secret': {
        const purpose = context.secretPurposes.get(value.name);
        if (purpose === undefined) known = false;
        return { kind: 'secret', name: value.name, purpose: purpose ?? '' };
      }
      case 'username': {
        const username = context.usernames.get(value.credential);
        if (username === undefined) known = false;
        return username ?? '';
      }
    }
  };
  const projected = Object.fromEntries(params.entries.map(([key, item]) => [key, project(item, paramPointer('', key))]));
  return known ? paramsDigest(templateParams(projected, templates)) : undefined;
}
