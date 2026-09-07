/**
 * Compile-time assertions on the public SDK surface. Never executed: `tsc`
 * (the package `typecheck` script) is the test, and every `@ts-expect-error`
 * below must stay necessary.
 */

import { z } from 'zod';
import { defineConfig, test, type Agent, type TraceCacheStore } from '../../src/index.ts';

declare const agent: Agent;
declare const remoteStore: TraceCacheStore;

defineConfig({ cache: 'read-write' });
defineConfig({ cache: { mode: 'read-only', store: remoteStore, dir: 'shared-cache' } });
// @ts-expect-error cache mode is a closed union
defineConfig({ cache: 'sometimes' });

const schemaOptions = {
  schema: z.object({ total: z.number() }),
};
const schemaResult = await agent.act('read total', undefined, schemaOptions);
schemaResult.data.total satisfies number;

const plainResult = await agent.act('open billing');
// @ts-expect-error data exists only when a schema is supplied
plainResult.data;

test.describe('synchronous', () => {});
// @ts-expect-error describe registration must be synchronous
test.describe('asynchronous', async () => {});
declare const condition: boolean;
// @ts-expect-error a conditionally async describe is still asynchronous
test.describe('conditionally asynchronous', () => condition ? undefined : Promise.resolve());
