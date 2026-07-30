import { test, expect } from 'e2e';

/**
 * The two canvas pages. Nothing drawn on a canvas has a node, a name, or a
 * role, so the deterministic suite could only reach the target by doing
 * arithmetic on the canvas bounding box and driving `web.mouse` — see
 * tests-selenium/canvas.e2e.ts. This is the inverse asymmetry to frames: here
 * the agent is the only tier with a real answer.
 */
test.describe('canvas', () => {
  test('judges a drawn scene from pixels', async ({ app, agent }) => {
    await app.open('/canvas/');

    // 'only': the tree describes an empty `<canvas>` element and nothing else,
    // so sending it would only offer a cheaper way to guess.
    await agent.assert('the canvas asks whether you are hungry', { vision: 'only' });
  });

  test('drives a drawn UI end to end with no nodes at all', async ({ app, agent }) => {
    await app.open('/canvas/');

    // Every participant here is painted: the button, the state it produces, and
    // the button that undoes it. There is no deterministic way to write this
    // test — not even `web.mouse`, without hard-coding coordinates.
    await agent.tap("the Let's Eat button drawn in the lower right of the canvas", {
      vision: 'only',
    });
    await agent.assert('the canvas now shows a photograph of a hamburger', { vision: 'only' });

    await agent.tap('the Reset button drawn in the lower right of the canvas', { vision: 'only' });
    // State, not history: a screenshot cannot show that something happened
    // "again", and a judgment asked to see recurrence in one frame correctly
    // refuses. Every agentic assertion has to be answerable from what is there.
    await agent.assert("the canvas asks whether you are hungry and offers a Let's Eat button", {
      vision: 'only',
    });
  });

  test('taps a shape that exists only as pixels', async ({ app, agent, web }) => {
    await app.open('/other/canvas');

    let message = '';
    const dispose = await web.onDialog(async (dialog) => {
      message = dialog.message;
      await dialog.accept();
    });
    try {
      await agent.tap('the white square outlined in the middle of the teal rectangle', {
        vision: 'only',
      });
    } finally {
      await dispose();
    }
    // The page alerts only when the click lands inside the drawn path, so the
    // dialog message is the hit-test.
    expect(message).toBe('You clicked on the square!');
  });

  test('a node-only verb refuses pixels-only input', async ({ app, agent }) => {
    await app.open('/demo_page');

    let denied = '';
    try {
      await agent.type('the Text Input Field', 'nope', { vision: 'only' });
    } catch (error) {
      denied = error instanceof Error ? (Reflect.get(error, 'code') as string) : '';
    }
    expect(denied).toBe('POLICY_DENIED');
  });

  test('vision resolves a real control to a node', async ({ app, agent, web }) => {
    await app.open('/apps/calculator');

    // Additive vision: the tree is still in the request, so the button is
    // selected as a node and re-resolved through a derived locator.
    await agent.tap('the 7 key', { vision: true });
    await expect(web.locator('#output')).toHaveValue('7');
  });
});
