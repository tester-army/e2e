/**
 * `schema/cige-1.schema.json`, generated from the zod schema the loader
 * validates with, so the two can't drift. The build writes it
 * (`scripts/build-schema.ts`) and a test fails when the committed copy is
 * stale. The loader takes `x-` keys off before zod sees them, so zod's output
 * knows nothing of them; every closed object gets them back here.
 */

import { z } from 'zod';

import { CigeFile } from './schema.ts';

const EXTENSION_KEYS = { '^x-[A-Za-z0-9._-]+$': {} };

/** Adds the `x-` key pattern to every object the schema closes to unknown keys, at any depth. */
function withExtensionKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withExtensionKeys);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, withExtensionKeys(value)]));
  if (out.additionalProperties === false) out.patternProperties = EXTENSION_KEYS;
  return out;
}

/** The JSON Schema of a `.cige.json` file, as editors and other tools validate it. */
export function cigeJsonSchema(): Record<string, unknown> {
  const { $schema: draft, ...generated } = z.toJSONSchema(CigeFile, { target: 'draft-2020-12', io: 'input' });
  return {
    $schema: draft,
    $id: 'https://e2e.tester.army/schema/cige-1.schema.json',
    title: 'CIGE test case, version 1',
    description:
      'An agentic test case in the CIGE standard: Context grounds the run, Intent states why the test exists and what a pass needs, Guardrails say what the agent must never do, and Execution is the first path to try. Every object also accepts x- keys (x-owner, x-ticket) for your own data; no other unknown key is allowed. See https://www.amazon.science/publications/cige-an-agentic-ai-test-case-standard.',
    ...(withExtensionKeys(generated) as Record<string, unknown>),
  };
}
