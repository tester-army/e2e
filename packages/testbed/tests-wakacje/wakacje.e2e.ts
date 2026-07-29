import { AgentError, expect, test } from "e2e";
import { z } from "zod";

/**
 * Booking journey on a real production travel site: consent dialog, destination
 * autosuggest, offer listing, and the offer page of the funnel. The test stops
 * before any reservation form is filled or submitted — nothing is ever booked.
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
  // list itself is the assertion, not the address.
  await agent.waitFor("a list of vacation offers with hotel names and prices in zł is visible");

  const offer = await agent.extract(
    "the hotel name and total price text of the first vacation offer in the list",
    { schema: z.object({ hotel: z.string(), price: z.string() }) },
  );
  expect(offer.hotel.length).toBeGreaterThan(2);
  expect(offer.price).toMatch(/zł|PLN|\d/);

  // An offer card is one link whose accessible name aggregates the whole card:
  // hotel, dates, airports, board, rating, review count, price, CTA. Nothing can
  // re-find that name, so picking it strands the locate sweep — which is what
  // the tree-only model does here.
  //
  // That stranded sweep is precisely the signal `'fallback'` escalates on, so
  // this step costs no pixels on a layout whose tree is addressable and one
  // screenshot on this one. Vision then fixes it by improving the choice, not by
  // bypassing it: seeing the card, the model picks the small inner control it
  // would actually click, and the runner still re-resolves that node through a
  // derived query. Pointing is the last resort underneath.
  await agent.tap("the first vacation offer card in the results list", { vision: "fallback" });
  await agent.waitFor(
    "a hotel offer page is visible with a price and a way to continue booking or check availability",
  );

  // Funnel boundary: verify the booking entry point exists, never enter it.
  // Judged on pixels alone because the check is about what the page actually
  // presents — a price rendered into a promo image, a button under a cookie
  // banner — not about which nodes exist.
  await agent.assert(
    "the offer page shows a booking or availability button and a total price, and no reservation form has been submitted",
    { vision: "only" },
  );
});
