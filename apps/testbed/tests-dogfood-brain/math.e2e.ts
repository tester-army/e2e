/**
 * Engine-free dogfood: the math-brain executor never touches the page — no
 * app.open, no observations, no grammar actions. The first test should pass
 * on the executor's own tools; the second should conclude failed honestly,
 * because booking flights is not something a calculator can do.
 */

import { test } from 'e2e';

test('computes with only its own tools, no driver involved', async ({ agent }) => {
  await agent.act(
    'Compute (3 + 4) * 6 with your tools. Conclude passed only if the result is exactly 42, and put the number in your summary.',
  );
});

test('concludes honestly when its tools cannot do the job', async ({ agent }) => {
  await agent.act('Book a flight from Warsaw to Paris for tomorrow morning.');
});
