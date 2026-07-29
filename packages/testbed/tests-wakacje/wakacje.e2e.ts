import { expect, test } from "e2e";
import { z } from "zod";

/**
 * Booking journey on a real production travel site: consent dialog, destination
 * autosuggest, offer listing, and the offer page of the funnel. The test stops
 * before any reservation form is filled or submitted — nothing is ever booked.
 */
test("searches Greece vacations and reaches an offer", async ({ app, agent, screen }) => {
  await app.open("/");

  // The consent dialog loads asynchronously and is session-dependent: accept
  // it when it shows up, move on quickly when it never does.
  try {
    await screen
      .getByRole("button", { name: /Akceptuję i przechodzę/i })
      .waitFor({ state: "visible", timeout: 15_000 });
    await agent.tap("the button that accepts cookies and closes the consent dialog");
  } catch {
    // No consent dialog this session.
  }
  await screen.getByRole("button", { name: /^Dokąd\?/ }).waitFor({ state: "visible" });

  await agent.tap("the destination search field asking where you want to go");
  await agent.type("the destination search input", "Grecja");
  // The autosuggest is debounced and fetched; give it time to materialize.
  await screen
    .getByRole("checkbox", { name: "Grecja" })
    .waitFor({ state: "visible", timeout: 20_000 });
  await agent.tap("the Grecja country suggestion in the destination dropdown");
  // The destination dropdown confirms with "Wybierz"; the search itself is a
  // separate "Szukaj" submit on the form behind it.
  await agent.tap("the Wybierz button that confirms the destination selection");
  await agent.tap("the Szukaj button that submits the vacation search");

  // The result URL varies (/grecja/ or /wczasy/?src=fromSearch), so the offer
  // list itself is the assertion, not the address.
  await screen
    .getByTestId("offer-listing-name")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });

  const offer = await agent.extract(
    "the hotel name and total price text of the first vacation offer in the list",
    { schema: z.object({ hotel: z.string(), price: z.string() }) },
  );
  expect(offer.hotel.length).toBeGreaterThan(2);
  expect(offer.price).toMatch(/zł|PLN|\d/);

  await agent.tap(
    "the link or button that opens the first vacation offer details",
  );
  // Left agentic on purpose. Offer pages differ per hotel: some expose
  // "crosssell-btn-reservation", some a differently-named CTA, so no single
  // locator covers them. This is the one gate where tolerating page variation is
  // the whole point, and it costs one model call.
  await agent.waitFor(
    "a hotel offer page is visible with a price and a way to continue booking or check availability",
  );

  // Funnel boundary: verify the booking entry point exists, never enter it.
  await agent.assert(
    "the offer page shows a booking or availability button and a total price, and no reservation form has been submitted",
  );
});
