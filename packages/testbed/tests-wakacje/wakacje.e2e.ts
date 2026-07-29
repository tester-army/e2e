import { AgentError, expect, test } from "e2e";
import { z } from "zod";

/**
 * Booking journey on a real production travel site. Stops before any reservation
 * form is filled or submitted — nothing is ever booked.
 *
 * Mixed tiers on purpose: the tree answers most steps better and cheaper, and
 * `vision: "only"` is opted into on the three where the tree is not merely
 * unnecessary but wrong. Note that a pixels-only judgment is scoped to the
 * viewport while the tree is scoped to the document, so those steps ask about
 * what is on screen and scroll before asking about anything further down.
 */
test("searches Greece vacations and reaches an offer", async ({ app, agent }) => {
  await app.open("/");

  // Session-dependent: accept the dialog when it appears, move on when it never
  // does. Only a waitFor timeout means "no dialog"; anything else is a failure.
  try {
    await agent.waitFor("a cookie consent dialog with an accept button is visible", {
      timeout: 15_000,
    });
    await agent.tap("the button that accepts cookies and closes the consent dialog");
  } catch (error) {
    if (!(error instanceof AgentError) || error.code !== "STEP_TIMEOUT") throw error;
  }
  // Pixels: no tree encodes occlusion. An overlay leaves the form present,
  // enabled, and named while hiding it on screen.
  await agent.waitFor("the vacation search form asking where to go is visible and not covered", {
    vision: "only",
  });

  await agent.tap("the destination search field asking where you want to go");
  await agent.type("the destination search input", "Grecja");
  await agent.waitFor("the destination dropdown shows a suggestion for Grecja as a country");
  await agent.tap("the Grecja country suggestion in the destination dropdown");
  await agent.tap("the Wybierz button that confirms the destination selection");
  await agent.tap("the Szukaj button that submits the vacation search");

  // The result URL varies, so the offer list is the assertion, not the address.
  await agent.waitFor("a list of vacation offers with hotel names and prices in zł is visible");

  // From the tree: these are exact strings it carries verbatim, and a screenshot
  // read is where transcription errors come from.
  const offer = await agent.extract(
    "the hotel name and total price text of the first vacation offer in the list",
    { schema: z.object({ hotel: z.string(), price: z.string() }) },
  );
  expect(offer.hotel.length).toBeGreaterThan(5);
  expect(offer.price).toMatch(/\d[\d\s]{2,}\s*(zł|PLN)/);

  // Pixels: the card is one link whose accessible name aggregates the whole card,
  // so no derived query re-finds it and pointing is the only thing that reaches
  // it. Scrolling first puts the card fully in view and costs no model call.
  await agent.scroll({ direction: "down" });
  await agent.tap("the first vacation offer card visible on screen", { vision: "only" });
  await agent.waitFor(
    "a hotel offer page is visible with a price and a way to continue booking or check availability",
  );

  // Funnel boundary: verify the booking entry point exists, never enter it.
  // Pixels, because this is about what the page presents rather than which nodes
  // exist — so the CTA has to be on screen first.
  await agent.scrollTo("the button that starts booking or checks availability for this offer");
  await agent.assert(
    "a booking or availability button and a total price are visible on screen, and no reservation form has been submitted",
    { vision: "only" },
  );
});
