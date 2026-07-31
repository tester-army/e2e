/**
 * The `agent-tool-1` grammar (spec/schema/agent-tool-v1.schema.json).
 *
 * The runner's request schema is a flat discriminated object rather than the
 * spec's root `oneOf`, so the validator is what enforces the union. These tests
 * therefore check it against the spec file directly.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  ACTION_SPACE,
  CONTROL_KINDS,
  describeActionSpace,
  TOOL_SCHEMA,
  validateToolCall as validate,
} from '../../src/agent/action-space.ts';
import type { AgentObservation } from '../../src/agent/observation.ts';
import type { SemanticNode } from '../../src/driver/index.ts';

/** The observation every fixture below quotes. */
function observationOf(ids: readonly string[], revision = 'r1'): AgentObservation {
  const nodes = new Map<string, SemanticNode>(
    ids.map((id) => [id, { ref: { id, revision }, role: 'button', name: 'Continue' } as SemanticNode]),
  );
  return {
    revision,
    text: '',
    bytes: 0,
    nodes,
    viewport: { width: 1280, height: 720, scale: 1 },
    truncated: false,
  };
}

const OBSERVATION = observationOf(['n1', 'n2', 'n7']);

const validateToolCall = (value: unknown) => validate(value, OBSERVATION);

const SPEC_SCHEMA = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../../spec/schema/agent-tool-v1.schema.json'),
    'utf8',
  ),
) as object;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const matchesSpec = ajv.compile(SPEC_SCHEMA);

/** Every wire shape the runner must accept. */
const LEGAL: readonly { readonly name: string; readonly call: Record<string, unknown> }[] = [
  { name: 'tap', call: { toolVersion: 'agent-tool-1', kind: 'tap', target: { id: 'n7', revision: 'r1' } } },
  {
    name: 'plain type',
    call: {
      toolVersion: 'agent-tool-1',
      kind: 'type',
      target: { id: 'n7', revision: 'r1' },
      value: 'Acme Inc',
    },
  },
  {
    name: 'secret type',
    call: {
      toolVersion: 'agent-tool-1',
      kind: 'type',
      target: { id: 'n7', revision: 'r1' },
      sensitiveName: 'admin',
      purpose: 'password',
    },
  },
  { name: 'viewport scroll', call: { toolVersion: 'agent-tool-1', kind: 'scroll', direction: 'down' } },
  {
    name: 'container scroll',
    call: {
      toolVersion: 'agent-tool-1',
      kind: 'scroll',
      direction: 'up',
      momentum: 'slow',
      target: { id: 'n2', revision: 'r1' },
    },
  },
  { name: 'press', call: { toolVersion: 'agent-tool-1', kind: 'press', key: 'Enter' } },
  {
    name: 'longPress',
    call: {
      toolVersion: 'agent-tool-1',
      kind: 'longPress',
      target: { id: 'n7', revision: 'r1' },
      durationMs: 500,
    },
  },
  { name: 'navigate', call: { toolVersion: 'agent-tool-1', kind: 'navigate', url: '/billing' } },
  { name: 'observe', call: { toolVersion: 'agent-tool-1', kind: 'observe' } },
  {
    name: 'conclude',
    call: {
      toolVersion: 'agent-tool-1',
      kind: 'conclude',
      status: 'success',
      explanation: 'reached the dashboard',
    },
  },
  {
    name: 'conclude with data',
    call: {
      toolVersion: 'agent-tool-1',
      kind: 'conclude',
      status: 'success',
      explanation: 'read the total',
      data: { total: 42 },
    },
  },
];

describe('the act request schema', () => {
  // additionalProperties is false, so a field this schema omits is one a strict
  // provider strips from the response, making that kind unreachable.
  it('declares every field the validator reads', () => {
    expect(Object.keys(TOOL_SCHEMA.properties ?? {}).toSorted()).toEqual([
      'data',
      'direction',
      'durationMs',
      'explanation',
      'key',
      'kind',
      'momentum',
      'purpose',
      'sensitiveName',
      'status',
      'target',
      'toolVersion',
      'url',
      'value',
    ]);
  });

  // A flat schema cannot say "required when kind is conclude", so anything left
  // optional here is something a model will sometimes omit — and a validator that
  // then demands it stalls the flow, because the repair round re-sends the same
  // request and gets the same answer. Requiring `explanation` globally is the only
  // way to actually ask for it; every other argument belongs to one kind and
  // cannot be demanded of the rest.
  it('requires the discriminator and the explanation, and nothing else', () => {
    expect(TOOL_SCHEMA.required?.toSorted()).toEqual(['explanation', 'kind', 'toolVersion']);
  });

  it('accepts every legal call, so a compliant answer round-trips', () => {
    for (const { name, call } of LEGAL) {
      // The request schema asks every kind for an explanation; the spec's wire
      // schema forbids one on anything but `conclude`, so the fixtures carry it
      // only here. The runner ignores it for the kinds that do not use it.
      const answer = { explanation: 'because the observation shows it', ...call };
      expect(
        ajv.validate(TOOL_SCHEMA as object, answer),
        `${name} against the request schema`,
      ).toBe(true);
      expect(validateToolCall(answer), `${name} validates`).toMatchObject({ ok: true });
    }
  });
});

describe('agent-tool-1', () => {
  it('accepts exactly the shapes the spec declares', () => {
    for (const { name, call } of LEGAL) {
      expect(matchesSpec(call), `${name} against the spec schema`).toBe(true);
      expect(validateToolCall(call), name).toMatchObject({ ok: true });
    }
  });

  it('splits a plain fill from a sensitive one on the wire kind they share', () => {
    const plain = validateToolCall({
      toolVersion: 'agent-tool-1',
      kind: 'type',
      target: { id: 'n7', revision: 'r1' },
      value: 'hunter2',
    });
    expect(plain).toMatchObject({ ok: true, value: { name: 'type', args: { value: 'hunter2' } } });
    const sensitive = validateToolCall({
      toolVersion: 'agent-tool-1',
      kind: 'type',
      target: { id: 'n7', revision: 'r1' },
      sensitiveName: 'admin',
      purpose: 'password',
    });
    expect(sensitive).toMatchObject({
      ok: true,
      value: { name: 'secretType', args: { sensitiveName: 'admin', purpose: 'password' } },
    });
  });

  // Ambiguous about whether the filled value came from the model or the host,
  // which is the distinction the secret boundary rests on.
  it('refuses a fill that is both plain and sensitive', () => {
    expect(
      validateToolCall({
        toolVersion: 'agent-tool-1',
        kind: 'type',
        target: { id: 'n7', revision: 'r1' },
        value: 'hunter2',
        sensitiveName: 'admin',
        purpose: 'password',
      }),
    ).toMatchObject({ ok: false });
  });

  // The request schema declares every kind's fields on one flat object, and many
  // models answer by filling in every declared property. Rejecting the stray
  // ones made a correct decision unrecoverable: the repair round could only
  // produce the same response, so the flow burned its whole budget on a
  // conclusion it had already got right.
  it('ignores a field the named kind does not take', () => {
    const NODE = { id: 'n7', revision: 'r1' };
    for (const [kind, extra, expected] of [
      ['conclude', { value: 'Grecja' }, { control: 'conclude', status: 'success' }],
      ['conclude', { key: 'Enter', url: '/x', target: NODE }, { control: 'conclude' }],
      ['tap', { url: 'https://example.test' }, { name: 'tap' }],
      ['tap', { value: 'text' }, { name: 'tap' }],
      ['press', { target: NODE }, { name: 'press' }],
      ['observe', { target: NODE, value: 'x' }, { control: 'observe' }],
      ['navigate', { target: NODE }, { name: 'navigate' }],
    ] as const) {
      const minimal: Readonly<Record<string, Record<string, unknown>>> = {
        tap: { target: NODE },
        press: { key: 'Enter' },
        navigate: { url: '/x' },
        observe: {},
        conclude: { status: 'success', explanation: 'done' },
      };
      const probe = { toolVersion: 'agent-tool-1', kind, ...minimal[kind], ...extra };
      // The spec's oneOf still forbids it on the wire; the runner is lenient
      // about what it accepts and strict about what it derives from it.
      expect(matchesSpec(probe), `spec accepts ${kind}+extras`).toBe(false);
      expect(validateToolCall(probe), `${kind} with extras`).toMatchObject({
        ok: true,
        value: expected,
      });
    }
  });

  // A stray field must not make a sibling sharing the wire kind look viable.
  it('resolves a plain fill carrying a spurious secret field', () => {
    expect(
      validateToolCall({
        toolVersion: 'agent-tool-1',
        kind: 'type',
        target: { id: 'n7', revision: 'r1' },
        value: 'Acme Inc',
        purpose: 'password',
      }),
    ).toMatchObject({ ok: true, value: { name: 'type', args: { value: 'Acme Inc' } } });
  });

  it('refuses an unknown kind and an unknown toolVersion', () => {
    expect(validateToolCall({ toolVersion: 'agent-tool-1', kind: 'evaluate' })).toMatchObject({
      ok: false,
    });
    expect(
      validateToolCall({ toolVersion: 'agent-tool-2', kind: 'observe' }),
    ).toMatchObject({ ok: false });
  });

  it('refuses a target that is not a bounded { id, revision } pair', () => {
    for (const target of [
      undefined,
      null,
      'n7',
      { id: 'n7' },
      { id: '', revision: 'r1' },
      { id: 'n7', revision: 'r1', extra: 1 },
      { point: { x: 1, y: 2 }, revision: 'r1' },
    ]) {
      expect(
        validateToolCall({ toolVersion: 'agent-tool-1', kind: 'tap', target }),
        JSON.stringify(target),
      ).toMatchObject({ ok: false });
    }
  });

  it('bounds longPress duration and refuses a non-integer', () => {
    for (const durationMs of [50, 20_000, 500.5, '500']) {
      expect(
        validateToolCall({
          toolVersion: 'agent-tool-1',
          kind: 'longPress',
          target: { id: 'n7', revision: 'r1' },
          durationMs,
        }),
        String(durationMs),
      ).toMatchObject({ ok: false });
    }
  });

  it('refuses a scroll without a direction, and an unknown direction', () => {
    expect(validateToolCall({ toolVersion: 'agent-tool-1', kind: 'scroll' })).toMatchObject({
      ok: false,
    });
    expect(
      validateToolCall({ toolVersion: 'agent-tool-1', kind: 'scroll', direction: 'sideways' }),
    ).toMatchObject({ ok: false });
  });

  // Status maps onto success or ACTION_FAILED, so prose here would let model
  // text decide whether the test passed.
  it('refuses a conclusion without a legal status', () => {
    for (const status of [undefined, 'ok', true, 'SUCCESS']) {
      expect(
        validateToolCall({
          toolVersion: 'agent-tool-1',
          kind: 'conclude',
          status,
          explanation: 'done',
        }),
        String(status),
      ).toMatchObject({ ok: false });
    }
  });

  it('rejects a target that is not in the current observation', () => {
    expect(
      validateToolCall({
        toolVersion: 'agent-tool-1',
        kind: 'tap',
        target: { id: 'n404', revision: 'r1' },
      }),
    ).toMatchObject({ ok: false });
  });

  // Ids are minted per observation, so an older revision may name a different node.
  it('rejects a stale observation revision', () => {
    expect(
      validateToolCall({
        toolVersion: 'agent-tool-1',
        kind: 'tap',
        target: { id: 'n7', revision: 'r0' },
      }),
    ).toMatchObject({ ok: false });
  });

  it('carries a conclusion payload through untouched', () => {
    const data = { total: 42, items: ['a', 'b'], nested: { ok: true } };
    expect(
      validateToolCall({
        toolVersion: 'agent-tool-1',
        kind: 'conclude',
        status: 'success',
        explanation: 'read it',
        data,
      }),
    ).toMatchObject({ ok: true, value: { data } });
  });
});

/**
 * Schema, prompt, and validator all derive from the table, so an action added
 * there is reachable without editing any of them. Asserted as a property over
 * the whole space: a test naming today's actions would pass while a newly added
 * one sat unreachable.
 */
describe('the action space derivation', () => {
  const ALL = [
    ...Object.entries(ACTION_SPACE).map(([name, entry]) => ({ name, ...entry })),
    ...Object.values(CONTROL_KINDS).map((entry) => ({ name: entry.kind, ...entry })),
  ];

  it('declares every argument of every entry in the request schema', () => {
    const declared = new Set(Object.keys(TOOL_SCHEMA.properties ?? {}));
    for (const entry of ALL) {
      for (const argument of Object.keys(entry.args)) {
        expect(declared.has(argument), `${entry.name}.${argument} is declared`).toBe(true);
      }
    }
  });

  it('offers every entry kind in the schema enum', () => {
    const kinds = (TOOL_SCHEMA.properties?.['kind'] as { enum?: string[] } | undefined)?.enum ?? [];
    for (const entry of ALL) {
      expect(kinds, `${entry.kind} is offered`).toContain(entry.kind);
    }
  });

  it('describes every entry in the request text', () => {
    const described = describeActionSpace().join('\n');
    for (const entry of ALL) {
      expect(described, `${entry.kind} appears in the prompt`).toContain(`kind "${entry.kind}"`);
      // Unstated argument names cannot be supplied, leaving the schema field unused.
      for (const argument of Object.keys(entry.args)) {
        expect(described, `${entry.name}.${argument} is explained`).toContain(`"${argument}"`);
      }
    }
  });

  it('reaches every dispatchable action through validation', () => {
    for (const [name, entry] of Object.entries(ACTION_SPACE)) {
      const call: Record<string, unknown> = { toolVersion: 'agent-tool-1', kind: entry.kind };
      for (const [argument, spec] of Object.entries(entry.args)) {
        if (!spec.required) continue;
        call[argument] = SAMPLES[argument] ?? 'sample';
      }
      const result = validateToolCall(call);
      expect(result, `${name} is reachable: ${JSON.stringify(call)}`).toMatchObject({ ok: true });
      if (result.ok && !('control' in result.value)) {
        expect(result.value.name, `${name} resolves to itself`).toBe(name);
      }
    }
  });

  it('gives every action a trail rendering and a perform', () => {
    for (const [name, entry] of Object.entries(ACTION_SPACE)) {
      expect(typeof entry.describe, `${name}.describe`).toBe('function');
      expect(typeof entry.perform, `${name}.perform`).toBe('function');
      expect(entry.when.length, `${name}.when is non-empty`).toBeGreaterThan(0);
    }
  });
});

/** Legal sample values for required arguments, by argument name. */
const SAMPLES: Readonly<Record<string, unknown>> = {
  target: { id: 'n7', revision: 'r1' },
  value: 'text',
  sensitiveName: 'admin',
  purpose: 'password',
  direction: 'down',
  key: 'Enter',
  url: '/x',
  status: 'success',
  explanation: 'done',
};
