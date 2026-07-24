import { z } from 'zod';
import { test, type Agent } from 'e2e';

declare const agent: Agent;

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
