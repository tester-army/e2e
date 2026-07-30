import { test, expect } from 'e2e';

/**
 * The frame cases the deterministic suite could not express. The observation
 * walk stitches every allowed child document into one tree and acts through
 * live element handles, so the agent is not limited to the six `getBy*` queries
 * a frame-scoped `Screen` offers — and it is not limited to one frame deep.
 *
 * Each test here has a `skip`ped or `evaluate`-based counterpart in
 * tests-selenium/iframes.e2e.ts. Together they say precisely where the two
 * tiers differ.
 */
test.describe('frames', () => {
  test('uploads to a file input that has no accessible name', async ({ app, agent, web }) => {
    await app.open('/w3schools/file_upload');

    // Deterministically unreachable: the input is inside a frame and `Screen`
    // has no CSS escape hatch, so `setInputFiles` has no target.
    await agent.upload('the file upload button', 'fixtures/attachment.txt');

    const chosen = await web.evaluate(() => {
      const frame = document.querySelector('#iframeResult');
      const doc = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
      // No `instanceof`: the input belongs to the frame's realm, so it is not an
      // instance of this document's HTMLInputElement.
      const field = doc?.querySelector('#myFile') as { files?: FileList | null } | null;
      return field?.files?.[0]?.name ?? '';
    });
    expect(chosen).toBe('attachment.txt');
  });

  test('disables the upload button from inside the frame', async ({ app, agent, web }) => {
    await app.open('/w3schools/file_upload');

    // "Try it" appears three times on this page: once as the live button in the
    // embedded document, once inside the source listing, and once in the prose
    // above it. The instruction has to say which document it means — the first
    // attempt tapped the source listing's span, and the step *passed* while
    // doing nothing.
    await agent.tap('the Try it button inside the embedded result document');
    const disabled = await web.evaluate(() => {
      const frame = document.querySelector('#iframeResult');
      const doc = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
      const field = doc?.querySelector('#myFile') as { disabled?: boolean } | null;
      return field?.disabled === true;
    });
    expect(disabled).toBe(true);
  });

  test('checks a labelled box inside a frame and judges the result', async ({ app, agent, web }) => {
    await app.open('/w3schools/checkboxes');

    await agent.check('the "I have a boat" checkbox');
    await expect(web.frameLocator('#iframeResult').getByLabel('I have a boat')).toBeChecked();
    await agent.assert('exactly one of the three vehicle checkboxes is ticked');
  });

  test('reads a document nested two frames deep', async ({ app, agent }) => {
    await app.open('/w3schools/iframes');

    // `Screen` cannot express two boundaries at all. The observation walk
    // descends to MAX_FRAME_DEPTH, so the inner document is in the tree.
    await agent.assert('an inner box says the page is displayed in an iframe');
  });

  test(
    'drags inside a frame',
    {
      skip:
        'both endpoints are reference-only, and dragTo takes four observations, ' +
        'each disposing the generation that holds the source handle',
    },
    async ({ app, agent, web }) => {
      await app.open('/w3schools/drag_drop');

      const parent = () =>
        web.evaluate(() => {
          const frame = document.querySelector('#iframeResult');
          const doc = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
          return doc?.querySelector('#drag1')?.parentElement?.id ?? '';
        });

      expect(await parent()).not.toBe('div1');
      // The destination is in the tree at all only because an empty painted
      // rectangle is now observed, and a reference-backed endpoint can now be
      // dragged. What still blocks this is neither: `dragTo` locates twice, each
      // locate takes two observations, and every observation disposes the
      // generation before it — so the source handle is gone by dispatch. A drag
      // with one query-addressable endpoint works; this page gives neither.
      await agent.dragTo('the W3Schools logo image', 'the empty bordered rectangle above it');
      expect(await parent()).toBe('div1');
    },
  );
});
