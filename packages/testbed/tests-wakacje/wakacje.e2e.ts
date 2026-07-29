import { AgentError, expect, test } from "e2e";
import { z } from "zod";

/**
 * Booking journey on a real production travel site: consent dialog, destination
 * autosuggest, offer listing, and the offer page of the funnel. The test stops
 * before any reservation form is filled or submitted — nothing is ever booked.
 *
 * Deliberately a mix of tiers rather than vision everywhere. The suite does pass
 * fully vision-driven — `agent.vision: true` project-wide with `'only'` on the
 * judgments, measured green in ~65 s against ~114 s tree-driven — but that is not
 * what it should demonstrate, because most of those steps are answered better and
 * cheaper by the accessibility tree. Vision is used on the three steps where the
 * tree is not merely unnecessary but wrong:
 *
 * - occlusion ("visible and not covered") is not encoded in any tree: an overlay
 *   leaves the form present, enabled, and named while hiding it on screen;
 * - the offer card is one link whose accessible name is the entire card, so no
 *   derived query re-finds it and pointing is the only thing that reaches it;
 * - the funnel-boundary assertion is about what the page presents — a price
 *   rendered into a promo image, a CTA under a banner — not about which nodes
 *   exist.
 *
 * Everything else stays on the tree, including `extract`: reading an exact string
 * is what the tree is good at, and a screenshot read is where transcription
 * errors come from.
 *
 * One asymmetry to keep in mind when adding steps: a pixels-only judgment is
 * scoped to the viewport, while the tree is scoped to the document. Conditions
 * judged on pixels are therefore written about what is on screen, and the suite
 * scrolls before asking about anything further down.
 */
test("searches Greece vacations and reaches an offer", async ({ app, agent }) => {
  await app.open("/");

  // The consent dialog loads asynchronously and is session-dependent: accept
  // it when it shows up, move on quickly when it never does. Only a waitFor
  // timeout means "no dialog"; anything else is a real failure.
  try {
    await agent.waitFor("a cookie consent dialog with an accept button is visible", {
      timeout: 15_000,
    });
    await agent.tap("the button that accepts cookies and closes the consent dialog");
  } catch (error) {
    if (!(error instanceof AgentError) || error.code !== "STEP_TIMEOUT") throw error;
  }
  // "not covered" is a property no accessibility tree encodes: a consent sheet
  // or sticky promo that overlays the form leaves it present and named in the
  // tree while hiding it on screen. Sending the tree too would just offer the
  // cheaper wrong answer, so this judgment gets the pixels and only the pixels.
  await agent.waitFor("the vacation search form asking where to go is visible and not covered", {
    vision: "only",
  });

  await agent.tap("the destination search field asking where you want to go");
  await agent.type("the destination search input", "Grecja");
  // The autosuggest is debounced and fetched; give it time to materialize.
  await agent.waitFor("the destination dropdown shows a suggestion for Grecja as a country");
  await agent.tap("the Grecja country suggestion in the destination dropdown");
  // The destination dropdown confirms with "Wybierz"; the search itself is a
  // separate "Szukaj" submit on the form behind it.
  await agent.tap("the Wybierz button that confirms the destination selection");
  await agent.tap("the Szukaj button that submits the vacation search");

  // The result URL varies (/grecja/ or /wczasy/?src=fromSearch), so the offer
  // list itself is the assertion, not the address. Tree-judged, so this may
  // legitimately claim prices: they are in the DOM whether or not one is painted.
  await agent.waitFor("a list of vacation offers with hotel names and prices in zł is visible");

  // Extracted from the tree, not from pixels. The values are exact strings and
  // the tree has them verbatim; a screenshot read is where transcription errors
  // come from, and 11px text is measurably the first thing to corrupt.
  const offer = await agent.extract(
    "the hotel name and total price text of the first vacation offer in the list",
    { schema: z.object({ hotel: z.string(), price: z.string() }) },
  );
  // Tight enough that a wrong read can fail it. `/\d/` passed on any
  // hallucinated number, which made this assertion incapable of catching the one
  // thing it exists to catch.
  expect(offer.hotel.length).toBeGreaterThan(5);
  expect(offer.price).toMatch(/\d[\d\s]{2,}\s*(zł|PLN)/);

  // An offer card is one link whose accessible name aggregates the whole card:
  // hotel, dates, airports, board, rating, review count, price, CTA. No derived
  // query re-finds a name like that, so every tier that ends in a node reference
  // strands here — measured, not assumed: with `'fallback'` the escalated call
  // still chose the card link and then polled out against the deadline.
  //
  // 'only' is the tier that fits: no tree means the answer can only be a point,
  // the runner bounds and hit-tests it against the same observation, and the card
  // is a large, unambiguous click target on screen. Scroll first so the card the
  // model points at is fully in view; with no target this costs no model call.
  await agent.scroll({ direction: "down" });
  await agent.tap("the first vacation offer card visible on screen", { vision: "only" });
  await agent.waitFor(
    "a hotel offer page is visible with a price and a way to continue booking or check availability",
  );

  // Funnel boundary: verify the booking entry point exists, never enter it.
  // Judged on pixels alone because the check is about what the page actually
  // presents — a price rendered into a promo image, a button under a cookie
  // banner — not about which nodes exist. That makes it viewport-scoped, so bring
  // the CTA into view first; unlike the offer card, this button has a name of its
  // own, so the tree can address it.
  await agent.scrollTo("the button that starts booking or checks availability for this offer");
  await agent.assert(
    "a booking or availability button and a total price are visible on screen, and no reservation form has been submitted",
    { vision: "only" },
  );
});
