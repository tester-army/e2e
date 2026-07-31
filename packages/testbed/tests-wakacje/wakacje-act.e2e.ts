import { expect, test } from "e2e";

const PLANNING_TIMEOUT = 180_000;

test("books Greece vacations through the reservation funnel", async ({
  app,
  agent,
  screen,
}) => {
  await app.open("/");
  await agent.act(
    "accept the cookie consent dialog, or conclude if none is shown",
  );

  await agent.act(
    "search for vacations in Grecja and show the results",
    undefined,
    {
      timeout: PLANNING_TIMEOUT,
    },
  );
  await expect(screen.getByTestId("offer-listing-name").first()).toBeVisible();

  await agent.act("open the first vacation offer", undefined, {
    timeout: PLANNING_TIMEOUT,
  });
  await agent.waitFor(
    "a hotel offer page is visible with a price and a way to continue booking or check availability",
  );

  await agent.act(
    'start booking this offer until the reservation form headed "Twoje dane" is on screen',
    undefined,
    { vision: "fallback", timeout: PLANNING_TIMEOUT },
  );

  await agent.act(
    "fill in every required field of the passenger form and submit it, then stop as soon as the participants step appears without filling it",
    {
      firstName: "John",
      lastName: "Doe",
      email: "johndoe@gmail.com",
      phone: "123123123",
      consent: "accept all consents",
    },
    { timeout: PLANNING_TIMEOUT },
  );
  await agent.waitFor("the Uczestnicy step of the reservation is active");

  await agent.act(
    "fill in every required field of the participants form, confirm the data is correct, and submit it",
    {
      street: "Testowa 23/1",
      postalCode: "71-123",
      city: "Szczecin",
      secondAdult: { firstName: "Johnny", lastName: "Bravo" },
    },
    { timeout: PLANNING_TIMEOUT },
  );
});
