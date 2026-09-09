/**
 * Compile-time assertions on the public SDK surface. Never executed: `tsc`
 * (the package `typecheck` script) is the test, and every `@ts-expect-error`
 * below must stay necessary.
 */

import { z } from 'zod';
import {
  test,
  type Agent,
  type AsyncExpectation,
  type E2EConfig,
  type Screen,
  type TraceCacheStore,
} from '../../src/index.ts';

declare const agent: Agent;
declare const remoteStore: TraceCacheStore;
declare const asyncExpectation: AsyncExpectation;
declare const screen: Screen;

({ cache: 'read-write' }) satisfies E2EConfig;
({ cache: { mode: 'read-only', store: remoteStore, dir: 'shared-cache' } }) satisfies E2EConfig;
({ targets: [{ platform: 'ios' }] }) satisfies E2EConfig;
// @ts-expect-error a target's name defaults to its platform; the platform has no default
({ targets: [{ name: 'ios' }] }) satisfies E2EConfig;
// @ts-expect-error cache mode is a closed union
({ cache: 'sometimes' }) satisfies E2EConfig;
// @ts-expect-error attribute values must be text matches
asyncExpectation.toHaveAttribute('x', 42);
screen.getByRole('button', { name: 'Save', visible: true });
void screen.getByLabel('Plan').selectOption({ value: 'pro' });
// @ts-expect-error one of label, value, or index, never two
void screen.getByLabel('Plan').selectOption({ value: 'pro', index: 1 });
// @ts-expect-error role queries never match hidden nodes; visible is the one visibility knob
screen.getByRole('button', { hidden: true });

const plainResult = await agent.act('open billing');
// @ts-expect-error act returns no data; extract does
plainResult.data;
// @ts-expect-error act takes no schema; structured output is extract({ schema })
await agent.act('read total', undefined, { schema: z.object({ total: z.number() }) });
// @ts-expect-error act takes no vision option; assert, waitFor, and extract do
await agent.act('open billing', undefined, { vision: true });

test.describe('synchronous', () => {});
// @ts-expect-error describe registration must be synchronous
test.describe('asynchronous', async () => {});
declare const condition: boolean;
// @ts-expect-error a conditionally async describe is still asynchronous
test.describe('conditionally asynchronous', () => condition ? undefined : Promise.resolve());
