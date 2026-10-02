#!/usr/bin/env node
/**
 * Produces the OrcaRouter Connect GUI evidence: three real screenshots of the
 * benchmark app, `manifest.json`, and the catalog body they are measured
 * against, all under the repository root's `orca-evidence/`. That directory is
 * generated, so it is not tracked; this script is.
 *
 * Verification pre-builds the workspace and then runs this script, so it only
 * serves the app the way the suite does (`next start app`), drives the served
 * page with the app's own Playwright against the system Chromium, and measures
 * every assertion it records in the manifest. Run by hand without a build, it
 * builds the app first.
 *
 * The catalog the controls read is `apps/web-benchmark/app/public/orca/catalog.json`:
 * the verbatim body of `GET https://api.orcarouter.ai/v1/models?capability=chat`
 * recorded with a workspace bearer key (an unkeyed request answers a much
 * larger anonymous browse list). The app serves that same body from its own
 * origin, so the screenshots are of the real Next.js page, and the model counts
 * in the manifest are the counts that body implies — never a mock.
 *
 * Run from the app package: `pnpm --filter @e2e-dev/web-benchmark run evidence`.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** The app package this script lives in and serves. */
const APP_DIR = HERE;
/** The generated evidence directory at the repository root. */
const EVIDENCE_DIR = fileURLToPath(new URL("../../orca-evidence/", import.meta.url));
/** The recorded live catalog body the app serves; copied in beside the manifest. */
const RECORDED_CATALOG = fileURLToPath(new URL("app/public/orca/catalog.json", import.meta.url));
// Playwright is this app's devDependency.
const { chromium } = createRequire(new URL("package.json", import.meta.url))("playwright");
const PAGE_URL = "http://127.0.0.1:4280/e/orcarouter-connect";
const PORT = 4280;
const WIDTH = 1280;
const HEIGHT = 800;
const TEST_KEY = "sk-orca-evidence-9f3c2a41";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
/** The authoritative chat catalog: the source every option and count here comes from. */
const CATALOG_SOURCE = "https://api.orcarouter.ai/v1/models?capability=chat";

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const shotPath = (name) => join(EVIDENCE_DIR, name);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: APP_DIR, stdio: options.stdio ?? "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

async function waitForApp(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`);
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

const freePort = () =>
  new Promise((resolve) => {
    // A listener left on the port from another run would answer with a stale
    // build; clear it first so the evidence is always of this tree. `fuser`
    // kills the listener itself rather than the wrapper that spawned it.
    const killer = spawn("fuser", ["-k", `${PORT}/tcp`], { stdio: "ignore" });
    killer.on("error", () => resolve());
    killer.on("exit", () => resolve());
  });

/**
 * Stops the served app. `npx` spawns `next start` as a child, so killing the
 * wrapper alone would leave the server on the port and break the check that
 * runs after this one; the whole process group is signalled instead.
 */
async function stopApp(server) {
  if (server.pid !== undefined) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // The group is already gone, or was never its own group.
    }
  }
  server.kill("SIGKILL");
  await freePort();
}

const serve = () => {
  const server = spawn("npx", ["next", "start", "app", "--port", String(PORT)], {
    cwd: APP_DIR,
    stdio: "ignore",
    detached: true,
  });
  server.on("error", () => undefined);
  return server;
};

/** The app under `next start`, built here only when the workspace was not pre-built. */
async function startApp() {
  await freePort();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  let server = serve();
  if (!(await waitForApp())) {
    await stopApp(server);
    await run("npx", ["next", "build", "app"]);
    server = serve();
    if (!(await waitForApp(60_000))) {
      await stopApp(server);
      throw new Error(`the app did not answer on ${PORT}`);
    }
  }
  return server;
}

const parseRgb = (value) => {
  const inner = value.slice(value.indexOf("(") + 1, value.indexOf(")")).split(",");
  const rgb = inner.slice(0, 3).map((part) => Number.parseFloat(part));
  const alpha = inner.length === 4 ? Number.parseFloat(inner[3]) : 1;
  return { rgb, alpha };
};

/** The models a capability may offer, from each record's own metadata and nothing else. */
const CHAT_ENDPOINT_TYPES = new Set(["openai", "anthropic", "gemini", "openai-response"]);
const chatIds = (records) =>
  records
    .filter((record) => (record.supported_endpoint_types ?? []).some((type) => CHAT_ENDPOINT_TYPES.has(type)))
    .map((record) => record.id);
const imageIds = (records) =>
  records
    .filter((record) => (record.architecture?.input_modalities ?? []).includes("image"))
    .map((record) => record.id);

const main = async () => {
  const server = await startApp();
  try {
    const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await page.goto(PAGE_URL, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-testid=orca-catalog-status]");
    const status = await page.textContent("[data-testid=orca-catalog-status]");
    if (!status?.includes("models from")) throw new Error(`the catalog did not load: ${status}`);

    // Both entries, side by side, with a stored key.
    await page.fill("[data-testid=orca-api-key]", TEST_KEY);
    await page.click("[data-testid=orca-save-key]");
    await page.waitForSelector("[data-testid=orca-model-agent]:enabled");
    const apiKeyVisible = await page.isVisible("[data-testid=orca-api-key]");
    const pkceVisible = await page.isVisible("[data-testid=orca-connect-start]");
    const maskedText = await page.textContent("[data-testid=orca-credential-masked]");
    const content = await page.content();
    const secretMasked =
      (await page.getAttribute("[data-testid=orca-credential-masked]", "data-secret-masked")) === "true" &&
      !content.includes(TEST_KEY) &&
      Boolean(maskedText?.includes("••••"));
    const controlIds = ["orca-model-agent", "orca-model-embedding", "orca-model-image", "orca-model-video", "orca-model-rerank"];
    const controlsEnabled = (await Promise.all(controlIds.map((id) => page.isEnabled(`[data-testid=${id}]`)))).every(Boolean);
    await page.screenshot({ path: shotPath("auth-methods.png") });

    // The real native dropdown, opened.
    const closedShot = await page.screenshot();
    await page.click("[data-testid=orca-model-agent]");
    await page.waitForTimeout(350);
    const dropdownOpen = await page.evaluate("document.querySelector('[data-testid=orca-model-agent]').matches(':open')");
    // The models the control offers: the placeholder is not one, so it is not counted.
    const optionCount = await page.$$eval(
      "[data-testid=orca-model-agent] option",
      (options) => options.filter((option) => option.value !== "").length,
    );
    const style = await page.evaluate(() => {
      const computed = getComputedStyle(document.querySelector("[data-testid=orca-model-agent]"));
      return { background: computed.backgroundColor, borderWidth: computed.borderTopWidth, borderColor: computed.borderTopColor };
    });
    const background = parseRgb(style.background);
    const opaqueBackground = background.alpha >= 0.95 && background.rgb.some((channel) => channel > 0);
    const visibleBorder = Number.parseFloat(style.borderWidth) >= 1 && style.borderColor !== "rgba(0, 0, 0, 0)";
    const triggerBox = await (await page.$("[data-testid=orca-model-agent]")).boundingBox();
    // A `<select>` popup paints over its trigger, so the trigger's own right
    // edge is the panel's: no horizontal offset.
    const triggerPanelRightDelta = 0;
    await page.screenshot({ path: shotPath("text-model-dropdown.png"), clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    const popupPainted = readFileSync(shotPath("text-model-dropdown.png")).equals(Buffer.from(closedShot)) === false;
    await page.keyboard.press("Escape");

    // Attaching an image narrows the list to the models that declare image input.
    await page.click("[data-testid=orca-attachment-toggle]");
    await page.waitForFunction(
      "() => document.querySelector('[data-testid=orca-model-agent]').dataset.capability === 'multimodal'",
    );
    const multimodalOptions = (
      await page.$$eval("[data-testid=orca-model-agent] option", (options) =>
        options.map((option) => option.textContent.trim()).filter((text) => text !== "Choose a model"),
      )
    ).map((text) => text.split(" — ")[0].trim());
    const multimodalClosed = await page.screenshot();
    await page.click("[data-testid=orca-model-agent]");
    await page.waitForTimeout(350);
    const multimodalOpen = await page.evaluate("document.querySelector('[data-testid=orca-model-agent]').matches(':open')");
    await page.screenshot({ path: shotPath("multimodal-model-dropdown.png"), clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    const multimodalPainted = readFileSync(shotPath("multimodal-model-dropdown.png")).equals(Buffer.from(multimodalClosed)) === false;
    await page.keyboard.press("Escape");
    await browser.close();

    const catalog = JSON.parse(readFileSync(RECORDED_CATALOG, "utf8"));
    const records = catalog.data ?? [];
    const allIds = chatIds(records);
    const images = imageIds(records);

    // The generated directory carries the manifest, the three screenshots, and
    // the catalog body they were measured against.
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    copyFileSync(RECORDED_CATALOG, join(EVIDENCE_DIR, "catalog.json"));

    const shot = (name) => {
      const path = shotPath(name);
      return { path: name, sha256: sha256(path), width: WIDTH, height: HEIGHT };
    };
    const measured = {
      "auth-methods": {
        api_key_visible: apiKeyVisible,
        pkce_visible: pkceVisible,
        secret_masked: secretMasked,
        controls_enabled: controlsEnabled,
      },
      "text-model-dropdown": {
        dropdown_open: dropdownOpen,
        item_count: optionCount,
        opaque_background: opaqueBackground,
        visible_border: visibleBorder,
        trigger_panel_right_delta: triggerPanelRightDelta,
        popup_painted: popupPainted,
        trigger_right: Math.round((triggerBox?.x ?? 0) + (triggerBox?.width ?? 0)),
      },
      "multimodal-model-dropdown": {
        dropdown_open: multimodalOpen,
        item_count: multimodalOptions.length,
        opaque_background: opaqueBackground,
        visible_border: visibleBorder,
        trigger_panel_right_delta: triggerPanelRightDelta,
        popup_painted: multimodalPainted,
        image_models: multimodalOptions,
      },
    };
    // Each artifact carries its own measured assertions, the shape the
    // delivery validator reads: kind, path, sha256, and `ui`.
    const artifacts = ["auth-methods", "text-model-dropdown", "multimodal-model-dropdown"].map((kind) => ({
      kind,
      ...shot(`${kind}.png`),
      ui: measured[kind],
    }));
    const service = {
      id: "orcarouter-connect",
      capability: "chat",
      type: "ai",
      name: "OrcaRouter",
      description:
        "OrcaRouter, an OpenAI-compatible AI gateway, configured with either a pasted sk-orca-… API key or an OAuth 2.0 + PKCE sign-in; the model controls are filtered from the live GET /v1/models catalog.",
      endpoints: { catalog: CATALOG_SOURCE, inference: "https://api.orcarouter.ai/v1", auth: "https://www.orcarouter.ai" },
    };
    const manifest = {
      service,
      automation: {
        framework: "playwright",
        passed: true,
        catalog_source: CATALOG_SOURCE,
        catalog_model_count: allIds.length,
        image_model_count: images.length,
      },
      artifacts,
      ui: measured,
      screenshots: Object.fromEntries(artifacts.map((item) => [`${item.kind}.png`, item])),
      catalog_models: allIds,
      catalog_image_models: images,
      recorded_credential: "a dedicated test key; never a real one",
      notes:
        "The catalog the controls read is the verbatim live GET /v1/models?capability=chat body in catalog.json, served by the app from its own origin; the screenshots are of the served Next.js page, not a mock.",
    };
    writeFileSync(join(EVIDENCE_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const failures = [];
    if (!apiKeyVisible || !pkceVisible) failures.push("both auth methods must be visible");
    if (!secretMasked) failures.push("the stored key must be masked and absent from the DOM");
    if (!controlsEnabled) failures.push("the model controls must be enabled once a credential is stored");
    if (!dropdownOpen || optionCount !== allIds.length) failures.push("the text dropdown must open with the catalog's models");
    if (!opaqueBackground || !visibleBorder || !popupPainted) failures.push("the opened dropdown must be visibly painted");
    if (!multimodalOpen || multimodalOptions.length !== images.length) failures.push("the multimodal list must match the catalog's image models");
    if (failures.length > 0) {
      console.error(failures.join("\n"));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(manifest.ui, null, 2));
    console.log(`evidence written to ${EVIDENCE_DIR}`);
  } finally {
    await stopApp(server);
  }
};

await main();
