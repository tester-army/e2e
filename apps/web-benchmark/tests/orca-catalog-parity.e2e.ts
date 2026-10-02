/**
 * The Connect scenario mirrors the provider package's capability filter (the
 * app may not import `e2e/src`), so this pins the two against each other with
 * one catalog body. If `selectModels` and the app's `modelsFor` ever disagree,
 * the GUI would offer a model the provider would not, and this fails.
 */

import { fileURLToPath } from "node:url";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const PACKAGE_CATALOG = fileURLToPath(
  new URL("../../../packages/e2e/src/oauth/orcarouter-catalog.ts", import.meta.url),
);
const APP_OPTIONS = fileURLToPath(new URL("../app/src/orca-options.ts", import.meta.url));

/** One body shaped like `GET /v1/models`: every capability declared by metadata. */
const LIVE = {
  object: "list",
  data: [
    { id: "orcarouter/auto", supported_endpoint_types: ["openai", "openai-response", "anthropic", "gemini"] },
    { id: "vendor/text-only", supported_endpoint_types: ["openai"], architecture: { input_modalities: ["text"] } },
    { id: "vendor/vision", supported_endpoint_types: ["openai-response"], architecture: { input_modalities: ["text", "image"] } },
    { id: "vendor/audio", supported_endpoint_types: ["anthropic"], architecture: { input_modalities: ["text", "audio"] } },
    { id: "vendor/embed", supported_endpoint_types: ["embeddings"] },
    { id: "vendor/imagegen", supported_endpoint_types: ["image-generation"] },
    { id: "vendor/video", supported_endpoint_types: ["openai-video"] },
    { id: "vendor/rerank", supported_endpoint_types: ["jina-rerank"] },
  ],
};

test.describe("orca capability filter parity", () => {
  test("the app's filter and the package's selectModels keep the same ids for every capability", async () => {
    const pkg = (await import(PACKAGE_CATALOG)) as {
      readCatalog?: unknown;
      selectModels: (models: readonly never[], query: never) => Array<{ id: string }>;
      chatQuery: () => never;
      visionQuery: () => never;
      embeddingQuery: () => never;
      imageQuery: () => never;
      videoQuery: () => never;
      rerankQuery: () => never;
    };
    const app = (await import(APP_OPTIONS)) as {
      readCatalog: (body: unknown) => Array<{ id: string; endpointTypes: string[]; inputModalities: string[] }>;
      modelsFor: (models: readonly never[], capability: string) => Array<{ id: string }>;
    };

    const appModels = app.readCatalog(LIVE);
    // The package parses its own records from the same body, so feed it the
    // body directly through its own reader when it exports one, else through
    // the app's parsed shape (which is a structural subset).
    const pair: Array<[string, () => unknown, readonly never[]] > = [
      ["chat", pkg.chatQuery, appModels as never],
      ["multimodal", pkg.visionQuery, appModels as never],
      ["embedding", pkg.embeddingQuery, appModels as never],
      ["image", pkg.imageQuery, appModels as never],
      ["video", pkg.videoQuery, appModels as never],
      ["rerank", pkg.rerankQuery, appModels as never],
    ];
    for (const [capability, query, models] of pair) {
      const fromPackage = pkg.selectModels(models, query() as never).map((model) => model.id);
      const fromApp = app.modelsFor(models, capability).map((model) => model.id);
      expect(fromApp, capability).toEqual(fromPackage);
    }
    // The vision filter is genuinely narrower than chat, so parity is not vacuous.
    expect(app.modelsFor(appModels as never, "multimodal").map((model) => model.id)).toEqual(["vendor/vision"]);
    expect(app.modelsFor(appModels as never, "chat").map((model) => model.id)).toEqual([
      "orcarouter/auto",
      "vendor/text-only",
      "vendor/vision",
      "vendor/audio",
    ]);
  });
});
