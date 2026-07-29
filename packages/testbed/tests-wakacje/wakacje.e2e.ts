import { AgentError, expect, test } from "e2e";
import { z } from "zod";

/**
 * Booking journey on a real production travel site: consent dialog, destination
 * autosuggest, offer listing, and the offer page of the funnel. The test stops
 * before any reservation form is filled or submitted — nothing is ever booked.
 *
 * Vision-driven end to end. `agent.vision: true` in the config puts a masked
 * screenshot in every model call, and steps below opt down to `'only'` where the
 * tree is not just unnecessary but actively misleading:
 *
 * - a judgment about what the page *presents* ("not covered", "shows a price")
 *   is answerable from the tree with the wrong answer, so the tree is withheld;
 * - the offer card is one link whose accessible name is the whole card, so no
 *   derived query re-finds it and pointing is the only thing that reaches it.
 *
 * `agent.type` keeps the tree: it needs a node reference to fill, and `'only'`
 * has none to offer.
 *
 * One asymmetry worth internalizing: a pixels-only judgment is scoped to the
 * viewport, while the tree is scoped to the document. Conditions here are
 * therefore written about what is on screen, and the suite scrolls when it wants
 * to ask about something further down.
 */
test("searches Greece vacations and reaches an offer", async ({ app, agent }) => {
  await app.open("/");

  // The consent dialog loads asynchronously and is session-dependent: accept
  // it when it shows up, move on quickly when it never does. Only a waitFor
  // timeout means "no dialog"; anything else is a real failure.
  try {
    // 'only': a consent sheet is a visual layer. The tree lists its button
    // whether or not it is on screen, and lists page content the sheet covers.
    await agent.waitFor("a cookie consent dialog with an accept button is visible", {
      timeout: 15_000,
      vision: "only",
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
  // 'only': the autosuggest list exists in the DOM before it is painted, so the
  // tree says "shown" while the dropdown is still closed.
  await agent.waitFor("the destination dropdown shows a suggestion for Grecja as a country", {
    vision: "only",
  });
  await agent.tap("the Grecja country suggestion in the destination dropdown");
  // The destination dropdown confirms with "Wybierz"; the search itself is a
  // separate "Szukaj" submit on the form behind it.
  await agent.tap("the Wybierz button that confirms the destination selection");
  await agent.tap("the Szukaj button that submits the vacation search");

  // The result URL varies (/grecja/ or /wczasy/?src=fromSearch), so the offer
  // list itself is the assertion, not the address. 'only' because a results
  // skeleton is in the tree before any offer is rendered.
  //
  // Note what this condition does *not* claim: prices. A pixels-only judgment is
  // scoped to the viewport, and at this scroll position the first card is cut off
  // just above its price. The tree-only version of this step passed while
  // asserting prices, because the DOM holds prices for all 6701 matched offers
  // whether or not one is painted — which is precisely the kind of pass this
  // suite is meant to stop accepting.
  await agent.waitFor("a list of vacation offers with hotel names is visible", {
    vision: "only",
  });

  // So bring a whole card into view before asking about its price, the way a
  // shopper would. No target, so this costs no model call.
  await agent.scroll({ direction: "down" });
  await agent.waitFor("a vacation offer card showing a hotel name and a price in zł is visible", {
    vision: "only",
  });

  // 'only': read the card as a shopper sees it. The tree carries the same text
  // plus the SEO footer and every off-screen card, and the "first" offer in DOM
  // order is not reliably the first one painted.
  const offer = await agent.extract(
    "the hotel name and total price text of the first vacation offer visible on screen",
    { schema: z.object({ hotel: z.string(), price: z.string() }), vision: "only" },
  );
  // Tight enough to catch a misread, which is the point of extracting from
  // pixels: `/\d/` would pass on any hallucinated number, so a shrunk or blurred
  // screenshot could silently keep this suite green while the model guessed.
  expect(offer.hotel.length).toBeGreaterThan(5);
  expect(offer.price).toMatch(/\d[\d\s]{2,}\s*(zł|PLN)/);

  // An offer card is one link whose accessible name aggregates the whole card:
  // hotel, dates, airports, board, rating, review count, price, CTA. No derived
  // query re-finds a name like that, so every tier that ends in a node
  // reference strands here — measured, not assumed: with `'fallback'` the
  // escalated call still chose the card link and then polled out.
  //
  // 'only' is the tier that fits: no tree means the answer can only be a point,
  // the runner bounds and hit-tests it against the same observation, and the
  // card is a large, unambiguous click target on screen.
  await agent.tap("the first vacation offer card visible on screen", { vision: "only" });
  // 'only': the offer page paints progressively, and its tree is populated well
  // before anything of it is on screen. This asks only what the top of the page
  // can actually answer.
  await agent.waitFor("a hotel offer page for one specific hotel is visible", {
    vision: "only",
  });

  // The price and the booking CTA sit below the hero, so bring the CTA into view
  // before asking a viewport-scoped question about it. Unlike the offer card,
  // this button has a name of its own, so the tree can address it.
  await agent.scrollTo("the button that starts booking or checks availability for this offer");

  // Funnel boundary: verify the booking entry point exists, never enter it.
  // Judged on pixels alone because the check is about what the page actually
  // presents — a price rendered into a promo image, a button under a cookie
  // banner — not about which nodes exist.
  await agent.assert(
    "a booking or availability button and a total price are visible on screen, and no reservation form has been submitted",
    { vision: "only" },
  );
});
