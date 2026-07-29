import { AgentError, expect, test } from "e2e";
import { z } from "zod";

/**
 * Booking journey on a real production site. Nothing is ever booked: the test
 * stops before any reservation form is filled or submitted.
 *
 * The tree answers most steps better and cheaper; `vision: "only"` is opted into
 * where it cannot. Pixels see the viewport, the tree sees the document, so those
 * steps ask about what is on screen and scroll before asking about more.
 */
test("searches Greece vacations and reaches an offer", async ({ app, agent }) => {
  await app.open("/");

  // Session-dependent, so a missing dialog is fine but a real error is not.
  try {
    await agent.waitFor("a cookie consent dialog with an accept button is visible", {
      timeout: 15_000,
    });
    await agent.tap("the button that accepts cookies and closes the consent dialog");
  } catch (error) {
    if (!(error instanceof AgentError) || error.code !== "STEP_TIMEOUT") throw error;
  }
  // No tree encodes occlusion: an overlay leaves the form named and enabled.
  await agent.waitFor("the vacation search form asking where to go is visible and not covered", {
    vision: "only",
  });

  await agent.tap("the destination search field asking where you want to go");
  await agent.type("the destination search input", "Grecja");
  await agent.waitFor("the destination dropdown shows a suggestion for Grecja as a country");
  await agent.tap("the Grecja country suggestion in the destination dropdown");
  await agent.tap("the Wybierz button that confirms the destination selection");
  await agent.tap("the Szukaj button that submits the vacation search");

  await agent.waitFor("a list of vacation offers with hotel names and prices in zł is visible");

  // Exact strings, which the tree carries verbatim and a screenshot read blurs.
  const offer = await agent.extract(
    "the hotel name and total price text of the first vacation offer in the list",
    { schema: z.object({ hotel: z.string(), price: z.string() }) },
  );
  expect(offer.hotel.length).toBeGreaterThan(5);
  expect(offer.price).toMatch(/\d[\d\s]{2,}\s*(zł|PLN)/);

  // The card's accessible name is the whole card, so no derived query re-finds it
  // and pointing is the only thing that reaches it.
  await agent.scroll({ direction: "down" });
  await agent.tap("the first vacation offer card visible on screen", { vision: "only" });
  await agent.waitFor(
    "a hotel offer page is visible with a price and a way to continue booking or check availability",
  );

  // Funnel boundary: verify the booking entry point exists, never enter it.
  await agent.scrollTo("the button that starts booking or checks availability for this offer");
  await agent.assert(
    "a booking or availability button and a total price are visible on screen, and no reservation form has been submitted",
    { vision: "only" },
  );
});
