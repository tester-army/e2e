import { test } from "e2e";

/**
 * Booking journey on a real production travel site: consent dialog, destination
 * autosuggest, offer listing, offer page, and the first two steps of the
 * reservation funnel. It fills the passenger form with obvious test data and
 * advances to the participants step, which creates a pending order server-side.
 * It never reaches payment, so nothing is ever bought.
 */
test("searches Greece vacations and reaches an offer", async ({ app, agent, screen }) => {
  await app.open("/");

  // The consent dialog loads asynchronously and is session-dependent: accept
  // it when it shows up, move on quickly when it never does.
  try {
    await screen
      .getByRole("button", { name: /Akceptuję i przechodzę/i })
      .waitFor({ state: "visible", timeout: 15_000 });
    await agent.tap(
      "the button that accepts cookies and closes the consent dialog",
    );
  } catch {
    // No consent dialog this session.
  }
  await screen.getByRole("button", { name: /^Dokąd\?/ }).waitFor({
    state: "visible",
  });

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

  await agent.tap("Kup teraz");
  // Several offer cards carry the same "Zarezerwuj na NN h" label and the tree
  // cannot say which card is this offer's, so this is the step that needs to
  // look at the page.
  await agent.tap("Zarezerwuj", { vision: "fallback" });
  await agent.waitFor("the reservation form is displayed");
  await agent.type("Name field", "John");
  await agent.type("Surname field", "Doe");
  await agent.type("email", "johndoe@gmail.com");
  await agent.type("repeat email", "johndoe@gmail.com");
  await agent.type("phone", "123123123");
  await agent.tap("Zaznacz wszystkie zgody");
  await agent.tap("Dalej");
  // Submitting step 1 prepares the order server-side ("Przygotowujemy Twoje
  // zamówienie") before step 2 renders, and the URL never changes, so the
  // arrival is something to wait for rather than to assert once.
  await agent.waitFor("the Uczestnicy step of the reservation is active");

  await agent.type("street field", "Testowa 23/1");
  await agent.type("Postal code", "71-123");
  await agent.type("City", "Szczecin");
  await agent.type("Dorosly 2 Name", "Johnny");
  await agent.type("Dorosly 2 Surname", "Bravo");
  await agent.tap("Dane sa prawidlowe");
  await agent.tap("Dalej");
});
