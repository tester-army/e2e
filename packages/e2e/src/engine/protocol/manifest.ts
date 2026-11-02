/**
 * The manifest: what an engine server is, as JSON. `describeEngine` derives
 * one from an engine, `checkManifest` checks the shape of a declared one, and
 * `manifestMismatch` compares the declared manifest with the one a server
 * announces. What the members mean together is `defineEngine`'s to check,
 * once the client has built its engine from the manifest.
 */

import { isDeepStrictEqual } from 'node:util';
import { ConfigurationError } from '../../internal/errors.ts';
import { obj } from '../../internal/objects.ts';
import type { EngineHandle } from '../index.ts';
import { ENGINE_METHODS, METHODS, SERVED_METHODS, engineMember, type EngineManifest, type EngineMethod } from './protocol.ts';

/**
 * Describes an engine as the manifest `serveEngine` returns from
 * `initialize`: its static members, the methods its declared members
 * answer, and the attempt hooks the server always answers.
 */
export function describeEngine(engine: EngineHandle): EngineManifest {
  return obj({
    name: engine.name,
    version: engine.version,
    spiVersion: engine.spiVersion,
    platform: engine.platform,
    workers: engine.workers,
    methods: ENGINE_METHODS.filter((method) => SERVED_METHODS.has(method) || engineMember(engine, METHODS[method].member) !== undefined),
    actions: engine.actions,
    pointerActions: engine.pointerActions,
    tapModifiers: engine.tapModifiers === true ? true : undefined,
  });
}

/**
 * Checks a declared manifest's shape at config load: an object whose methods
 * are protocol methods, each once. The rest is checked by `defineEngine`.
 */
export function checkManifest(manifest: EngineManifest): EngineManifest {
  const invalid = (detail: string): ConfigurationError => new ConfigurationError('INVALID_CONFIG', `connectEngine: ${detail}`);
  if (typeof manifest !== 'object' || manifest === null) throw invalid('manifest must be an object');
  if (!Array.isArray(manifest.methods)) throw invalid('manifest.methods must be an array of engine methods');
  const seen = new Set<string>();
  for (const method of manifest.methods as readonly unknown[]) {
    if (typeof method !== 'string' || !Object.hasOwn(METHODS, method)) {
      throw invalid(`manifest.methods names unknown method ${JSON.stringify(method)}`);
    }
    if (seen.has(method)) throw invalid(`manifest.methods lists "${method}" twice`);
    seen.add(method);
  }
  return manifest;
}

/** Names the fields where the server's manifest differs from the declared one, or undefined when they agree. */
export function manifestMismatch(declared: EngineManifest, announced: EngineManifest | undefined): string | undefined {
  if (announced === undefined) return 'the server sent none';
  const expected = comparable(declared);
  const actual = comparable(announced);
  const fields = (Object.keys(expected) as (keyof typeof expected)[]).filter((field) => !isDeepStrictEqual(expected[field], actual[field]));
  if (fields.length === 0) return undefined;
  const show = (value: unknown): string => JSON.stringify(value) ?? 'none';
  return fields.map((field) => `${field} is ${show(actual[field])}, declared ${show(expected[field])}`).join('; ');
}

/** A manifest with its lists in one order and its optional flags explicit, so equal manifests compare equal. */
function comparable(manifest: EngineManifest) {
  const sorted = <T extends string>(list: readonly T[] | undefined): readonly T[] => [...(list ?? [])].toSorted();
  return {
    name: manifest.name,
    version: manifest.version,
    spiVersion: manifest.spiVersion,
    platform: manifest.platform,
    workers: manifest.workers,
    methods: sorted<EngineMethod>(manifest.methods),
    actions: sorted(manifest.actions),
    pointerActions: sorted(manifest.pointerActions),
    tapModifiers: manifest.tapModifiers === true,
  };
}
