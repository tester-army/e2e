import { test } from 'e2e';
import { z } from 'zod';

/**
 * Parameterized tests: each case is a separate result with `$key` title
 * interpolation. Typed structured output from act() replaces brittle
 * scraping of the confirmation screen.
 */
test.each([
  { plan: 'Starter', seats: 5, price: 0 },
  { plan: 'Pro', seats: 25, price: 29 },
  { plan: 'Scale', seats: 100, price: 99 },
])('the $plan plan advertises correct limits', { tags: ['billing'] }, async ({ app, agent }, { plan, seats, price }) => {
  await app.open('/pricing');

  const { data } = await agent.act(`open the details of the ${plan} plan`, undefined, {
    schema: z.object({
      advertisedSeats: z.number(),
      advertisedMonthlyPrice: z.number(),
    }),
  });

  if (data.advertisedSeats !== seats || data.advertisedMonthlyPrice !== price) {
    throw new Error(`${plan}: expected ${seats} seats at $${price}, saw ${JSON.stringify(data)}`);
  }
});
