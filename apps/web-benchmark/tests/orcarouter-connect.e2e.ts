/**
 * The OrcaRouter Connect scenario: the two ways in and the model control both
 * of them feed. The page's catalog is the recorded live answer
 * (`public/orca/catalog.json`, a real `GET /v1/models` body), so what the
 * selects offer is what the endpoint lists.
 *
 * These are DOM-level assertions on purpose: the scenario is a plain form in
 * the benchmark app's style, and the `e2e` locators are the same surface the
 * other deterministic suites use.
 */

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Locator } from "e2e";
/** Every id the recorded chat catalog carries; the app never invents one. */
const CATALOG_IDS = [
  "orcarouter/free",
  "orcarouter/fusion",
  "orcarouter/fusion-flash",
  "orcarouter/fusion-mini",
  "orcarouter/orcacode-review",
  "orcarouter/open-code",
  "orcarouter/test-cache-glm52-opus",
  "orcarouter/simple-test",
  "orcarouter/intco-qa",
  "orcarouter/auto",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash-0731",
  "deepseek/deepseek-v4-pro-0813",
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
];

/** The two records the vision filter keeps: the ones declaring `image` as an input. */
const VISION_IDS = ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-flash-vision-exp"];

const seen = async (select: Locator): Promise<string[]> =>
  (await select.getByRole("option").allTextContents())
    .map((text) => text.trim())
    .filter((text) => text !== "" && text !== "Choose a model")
    .map((text) => text.split(" — ")[0]!.trim());

test.describe("orcarouter connect", () => {
  test.beforeEach(async ({ app, screen }) => {
    await app.open("/e/orcarouter-connect");
    await screen.getByTestId("orca-catalog-status").waitFor({ state: "visible" });
    await expect(screen.getByTestId("orca-catalog-status")).toContainText("16 models");
  });

  test("offers both ways in, side by side, before anything is connected", async ({ screen }) => {
    await expect(screen.getByTestId("orca-api-key-method")).toBeVisible();
    await expect(screen.getByTestId("orca-api-key")).toBeVisible();
    await expect(screen.getByTestId("orca-pkce-method")).toBeVisible();
    await expect(screen.getByTestId("orca-connect-start")).toBeEnabled();
    await expect(screen.getByTestId("orca-credential-status")).toHaveText("Not connected.");
    await expect(screen.getByTestId("orca-credential-masked")).toHaveText("none");
    // The model control waits for a credential rather than offering a free-text id.
    await expect(screen.getByTestId("orca-model-agent")).toBeDisabled();
  });

  test("the API-key entry stores a masked key, never the key itself", async ({ screen }) => {
    const field = screen.getByTestId("orca-api-key");
    // A password input: the runner refuses to read a secure field's value back
    // (POLICY_DENIED), which is the same rule the store's masking follows.
    await field.fill("sk-orca-test-abc12345");
    await screen.getByTestId("orca-save-key").tap();

    await expect(screen.getByTestId("orca-credential-masked")).toHaveText("sk-orca-••••••••2345");
    await expect(screen.getByTestId("orca-credential-masked")).toHaveAttribute("data-secret-masked", "true");
    await expect(screen.getByTestId("orca-auth-header")).toHaveText("Authorization: Bearer sk-orca-••••••••2345");
    await expect(screen.getByTestId("orca-credential-status")).toHaveText("Connected with an API key.");
    // The controls the credential unlocks are now live.
    await expect(screen.getByTestId("orca-model-agent")).toBeEnabled();
  });

  test("clearing removes the key and locks the model control again", async ({ screen }) => {
    await screen.getByTestId("orca-api-key").fill("sk-orca-test-abc12345");
    await screen.getByTestId("orca-save-key").tap();
    await expect(screen.getByTestId("orca-model-agent")).toBeEnabled();

    await screen.getByTestId("orca-clear-key").tap();
    await expect(screen.getByTestId("orca-credential-masked")).toHaveText("none");
    await expect(screen.getByTestId("orca-credential-masked")).toHaveAttribute("data-secret-masked", "false");
    await expect(screen.getByTestId("orca-credential-status")).toHaveText("Not connected.");
    await expect(screen.getByTestId("orca-model-agent")).toBeDisabled();
  });

  test("a value that is not shaped like a key is stored with a warning, not refused", async ({ screen }) => {
    await screen.getByTestId("orca-api-key").fill("not-a-key");
    await screen.getByTestId("orca-save-key").tap();
    await expect(screen.getByTestId("orca-credential-masked")).toContainText("sk-orca-");
    await expect(screen.getByTestId("orca-notice")).toContainText("does not start with sk-orca-");
  });

  test("an empty key is refused with an actionable line", async ({ screen }) => {
    await screen.getByTestId("orca-save-key").tap();
    await expect(screen.getByTestId("orca-notice")).toHaveText(
      "Enter a key, or use Connect with OrcaRouter to get one.",
    );
    await expect(screen.getByTestId("orca-credential-status")).toHaveText("Not connected.");
  });

  test("the text dropdown is the catalog, and only the catalog", async ({ screen }) => {
    await screen.getByTestId("orca-api-key").fill("sk-orca-test-abc12345");
    await screen.getByTestId("orca-save-key").tap();

    const options = await seen(screen.getByTestId("orca-model-agent"));
    expect(options.toSorted()).toEqual([...CATALOG_IDS].toSorted());
    await expect(screen.getByTestId("orca-model-agent")).toHaveAttribute("data-capability", "chat");
  });

  test("attaching an image narrows the dropdown to the models that declare image input", async ({ screen }) => {
    await screen.getByTestId("orca-api-key").fill("sk-orca-test-abc12345");
    await screen.getByTestId("orca-save-key").tap();
    // A text-only model first, so the incompatibility is the one being cleared.
    await screen.getByTestId("orca-model-agent").selectOption({ value: "deepseek/deepseek-v4-pro" });
    await expect(screen.getByTestId("orca-model-agent")).toHaveValue("deepseek/deepseek-v4-pro");

    await screen.getByTestId("orca-attachment-toggle").tap();
    await expect(screen.getByTestId("orca-model-agent")).toHaveAttribute("data-capability", "multimodal");

    const options = await seen(screen.getByTestId("orca-model-agent"));
    expect(options.toSorted()).toEqual([...VISION_IDS].toSorted());
    // The text-only pick does not survive a capability it cannot serve.
    await expect(screen.getByTestId("orca-model-agent")).toHaveValue("");
  });

  test("the capability-scoped selects stay empty rather than offering a guess", async ({ screen }) => {
    await screen.getByTestId("orca-api-key").fill("sk-orca-test-abc12345");
    await screen.getByTestId("orca-save-key").tap();
    // The recorded catalog declares no embedding, image-generation, video, or rerank record.
    for (const id of ["orca-model-embedding", "orca-model-image", "orca-model-video", "orca-model-rerank"]) {
      const options = await seen(screen.getByTestId(id));
      expect(options).toEqual([]);
    }
  });

  test("Connect sends a PKCE authorize request and can be cancelled", async ({ screen }) => {
    await screen.getByTestId("orca-connect-start").tap();
    // The authorization URL is on the auth origin, carries S256 and a state, and never the verifier.
    const href = await screen.getByTestId("orca-authorize-url").getAttribute("href");
    expect(href).toContain("https://www.orcarouter.ai/auth?");
    expect(href).toContain("code_challenge_method=S256");
    expect(href).toContain("code_challenge=");
    expect(href).toContain("state=");
    expect(href).not.toContain("code_verifier");
    await expect(screen.getByTestId("orca-authorize-url")).toHaveAttribute("data-verifier-in-url", "false");
    await expect(screen.getByTestId("orca-connect-cancel")).toBeVisible();

    await screen.getByTestId("orca-connect-cancel").tap();
    await expect(screen.getByTestId("orca-connect-cancel")).toBeHidden();
    await expect(screen.getByTestId("orca-credential-status")).toHaveText("Not connected.");
  });

  test("a fragmented code with no sign-in in progress is reported, not accepted", async ({ app, screen }) => {
    await app.open("/e/orcarouter-connect?code=code-from-nowhere&state=state-from-nowhere");
    await expect(screen.getByTestId("orca-notice")).toContainText("no sign-in in progress");
    await expect(screen.getByTestId("orca-credential-status")).toHaveText("Not connected.");
  });
});
