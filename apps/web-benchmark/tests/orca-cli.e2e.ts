/**
 * The OrcaRouter surface in the benchmark app: the model catalog options the
 * Connect scenario offers, and the CLI paths that fill the same two entries
 * (a pasted key, and the browser sign-in) in a temporary HOME.
 *
 * The app may not import `e2e/src`, so the catalog rules are mirrored in
 * `app/src/orca-options.ts`; `orca-catalog-parity.e2e.ts` pins that copy
 * against the package's `selectModels`, and this file drives the app's own
 * catalog loader against a served body and its failure mode.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/** The app's own catalog modules. Reached by absolute path because this is a TS file, not a bundler entry. */
const OPTIONS_URL = fileURLToPath(new URL("../app/src/orca-options.ts", import.meta.url));

async function loadOptions(): Promise<{
  readCatalog: (body: unknown) => Array<Record<string, unknown>>;
  modelsFor: (models: unknown[], capability: string) => Array<{ id: string }>;
  describeModel: (model: unknown, capability: string) => string;
}> {
  return (await import(OPTIONS_URL)) as never;
}

/** A body shaped like the endpoint's answer; every capability declared by metadata, never by a name. */
const CATALOG = {
  object: "list",
  data: [
    // Chat endpoint, no modality declaration.
    { id: "orcarouter/auto", object: "model", supported_endpoint_types: ["openai", "anthropic"] },
    // Chat endpoint, text only.
    { id: "vendor/text-only", supported_endpoint_types: ["openai"], architecture: { input_modalities: ["text"] } },
    // Chat endpoint that takes an image.
    { id: "vendor/vision", supported_endpoint_types: ["openai-response"], architecture: { input_modalities: ["text", "image"] } },
    // Not a chat endpoint at all.
    { id: "vendor/embed", supported_endpoint_types: ["embeddings"], architecture: { input_modalities: ["text"] } },
    { id: "vendor/imagegen", supported_endpoint_types: ["image-generation"] },
    { id: "vendor/video", supported_endpoint_types: ["openai-video"] },
    { id: "vendor/rerank", supported_endpoint_types: ["jina-rerank"] },
    // An endpoint type the client cannot speak: dropped, not guessed at.
    { id: "vendor/mystery", supported_endpoint_types: ["text-completion"] },
    { id: "", supported_endpoint_types: ["openai"] },
  ],
};

test.describe("orca model options", () => {
  test("a record's own metadata decides every capability, and an undeclared one fails closed", async () => {
    const { readCatalog, modelsFor } = await loadOptions();
    const models = readCatalog(CATALOG);
    // The id-less record is dropped; a record whose endpoint type this client
    // cannot speak is kept but declares nothing, so no capability offers it.
    expect(models.map((model) => model.id)).toEqual([
      "orcarouter/auto",
      "vendor/text-only",
      "vendor/vision",
      "vendor/embed",
      "vendor/imagegen",
      "vendor/video",
      "vendor/rerank",
      "vendor/mystery",
    ]);
    const mystery = models.find((model) => model.id === "vendor/mystery");
    expect(mystery?.endpointTypes).toEqual([]);

    expect(modelsFor(models, "chat").map((model) => model.id)).toEqual([
      "orcarouter/auto",
      "vendor/text-only",
      "vendor/vision",
    ]);
    // Multimodal understanding is chat plus a declared image input; the
    // text-only model is absent, not merely guarded at send time.
    expect(modelsFor(models, "multimodal").map((model) => model.id)).toEqual(["vendor/vision"]);
    expect(modelsFor(models, "embedding").map((model) => model.id)).toEqual(["vendor/embed"]);
    expect(modelsFor(models, "image").map((model) => model.id)).toEqual(["vendor/imagegen"]);
    expect(modelsFor(models, "video").map((model) => model.id)).toEqual(["vendor/video"]);
    expect(modelsFor(models, "rerank").map((model) => model.id)).toEqual(["vendor/rerank"]);
    for (const capability of ["chat", "multimodal", "embedding", "image", "video", "rerank"] as const) {
      expect(modelsFor(models, capability).map((model) => model.id)).not.toContain("vendor/mystery");
    }
  });

  test("an empty or malformed body offers nothing rather than a guess", async () => {
    const { readCatalog, modelsFor } = await loadOptions();
    expect(readCatalog({ data: [] })).toEqual([]);
    expect(readCatalog({})).toEqual([]);
    expect(readCatalog(null)).toEqual([]);
    expect(modelsFor([], "chat")).toEqual([]);
  });

  test("the option label keeps the vendor/model id exactly as the catalog spells it", async () => {
    const { readCatalog, describeModel } = await loadOptions();
    const vision = readCatalog(CATALOG).find((model) => model.id === "vendor/vision");
    const label = describeModel(vision, "multimodal");
    expect(label.startsWith("vendor/vision — ")).toBe(true);
    expect(label).toContain("image in");
  });
});

/** The app's catalog loader reads `/orca/catalog.json`; a local server stands in for the app origin. */
async function serveCatalog(body: string | undefined, status = 200): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/orca/catalog.json`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function loadCatalogModule(): Promise<{
  loadCatalog: (fetchImpl?: typeof fetch) => Promise<{ models: readonly { id: string }[]; degraded: boolean; reason?: string }>;
  VERIFIED_FALLBACK_CATALOG: readonly { id: string }[];
}> {
  return (await import(fileURLToPath(new URL("../app/src/orca-catalog.ts", import.meta.url)))) as never;
}

test.describe("orca catalog loading", () => {
  test("a live answer is the only source of truth when it reads", async () => {
    const server = await serveCatalog(JSON.stringify(CATALOG));
    try {
      const { loadCatalog } = await loadCatalogModule();
      const load = await loadCatalog((input) => fetch(server.url, typeof input === "string" ? {} : {}));
      expect(load.degraded).toBe(false);
      expect(load.models.map((model) => model.id)).toContain("vendor/vision");
    } finally {
      await server.close();
    }
  });

  test("a failed read degrades to the verified fallback and says why", async () => {
    const server = await serveCatalog("boom", 500);
    try {
      const { loadCatalog } = await loadCatalogModule();
      const load = await loadCatalog(() => fetch(server.url));
      expect(load.degraded).toBe(true);
      expect(load.reason).toContain("HTTP 500");
      // The fallback is bounded, and every id in it was observed live. The
      // OpenAI, Anthropic, and Google namespaces are absent on purpose.
      expect(load.models.map((model) => model.id)).toEqual([
        "orcarouter/auto",
        "deepseek/deepseek-v4-pro",
        "deepseek/deepseek-v4-flash-vision-exp",
      ]);
      // The seed survives no harder than the live answer: the vision filter
      // keeps only the record that declares image input.
      const { modelsFor } = await loadOptions();
      expect(modelsFor(load.models as never, "multimodal").map((model) => model.id)).toEqual([
        "deepseek/deepseek-v4-flash-vision-exp",
      ]);
    } finally {
      await server.close();
    }
  });

  test("a body with no models degrades rather than rendering an empty live list", async () => {
    const server = await serveCatalog(JSON.stringify({ data: [] }));
    try {
      const { loadCatalog } = await loadCatalogModule();
      const load = await loadCatalog(() => fetch(server.url));
      expect(load.degraded).toBe(true);
      expect(load.reason).toContain("listed no models");
    } finally {
      await server.close();
    }
  });
});

/** The built CLI: the app's `e2e` dependency links the workspace package. */
const CLI = fileURLToPath(new URL("../node_modules/e2e/dist/cli/bin.js", import.meta.url));

/**
 * Runs the CLI in a throwaway HOME, so nothing touches the developer's
 * credential file. The OrcaRouter variables are cleared first: an operator's
 * real key in the environment would change what these runs assert.
 */
function cli(args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const base: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const name of ["ORCAROUTER_API_KEY", "ORCA_BASE_URL", "ORCA_AUTH_BASE_URL", "ORCA_API_BASE_URL"]) delete base[name];
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...base, ...env, E2E_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Reads the credential file a CLI run wrote, when it wrote one. */
function storedCredentials(home: string): Record<string, { access: string; refresh: string; expires: number }> | undefined {
  try {
    return JSON.parse(readFileSync(path.join(home, ".config", "e2e", "oauth.json"), "utf8")) as never;
  } catch {
    return undefined;
  }
}

test.describe("orca cli", () => {
  let home: string;
  test.beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "orca-cli-"));
  });
  test.afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("both OrcaRouter entries are listed, and both appear in the login help", async () => {
    const listed = cli(["login", "--help"], { HOME: home });
    expect(listed.stdout + listed.stderr).toContain("OrcaRouter");
    // A key pasted from the environment needs no terminal input.
    const login = cli(["login", "orcarouter"], { HOME: home, ORCAROUTER_API_KEY: "sk-orca-cli-test-0001" });
    expect(login.status).toBe(0);
    const stored = storedCredentials(home);
    expect(stored?.["orcarouter"]?.access).toBe("sk-orca-cli-test-0001");
    // The key is durable, not a refresh token.
    expect(stored?.["orcarouter"]?.refresh).toBe("");
    expect(stored?.["orcarouter"]?.expires).toBe(0);
    // Nothing echoed the key back.
    expect(login.stdout).not.toContain("sk-orca-cli-test-0001");
  });

  test("signing out removes the stored key", async () => {
    cli(["login", "orcarouter"], { HOME: home, ORCAROUTER_API_KEY: "sk-orca-cli-test-0002" });
    expect(storedCredentials(home)?.["orcarouter"]?.access).toBe("sk-orca-cli-test-0002");
    const out = cli(["logout", "orcarouter"], { HOME: home });
    expect(out.status).toBe(0);
    expect(storedCredentials(home)?.["orcarouter"]).toBeUndefined();
  });

  test("models lists the live catalog and never prints the key", async () => {
    const list = cli(["models", "orcarouter"], { HOME: home, ORCAROUTER_API_KEY: "sk-orca-cli-test-0003" });
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("orcarouter/auto");
    expect(list.stdout).not.toContain("sk-orca-cli-test-0003");
  });

  test("models without a login falls back to the verified catalog and names the command that fixes it", async () => {
    const list = cli(["models", "orcarouter"], { HOME: home });
    // The listing never invents a model and never fails to render: a read that
    // cannot be authenticated degrades to the bounded, live-verified fallback.
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("verified fallback");
    expect(list.stdout).toContain("npx e2e login orcarouter");
    expect(list.stdout).toContain("orcarouter/auto");
    expect(list.stdout).not.toContain("sk-orca-");
  });

  test("both entries are selectable by name, and a wrong one lists them", async () => {
    const wrong = cli(["login", "not-a-provider"], { HOME: home });
    expect(wrong.status).toBe(2);
    const output = wrong.stdout + wrong.stderr;
    expect(output).toContain("orcarouter");
    expect(output).toContain("orcarouter-oauth");
  });
});

/** A one-shot local authorization server: the redirect, then the exchange. */
async function startFakeAuth(): Promise<{ url: string; requests: Array<{ path: string; body: string }>; close(): Promise<void> }> {
  const requests: Array<{ path: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ path: request.url ?? "/", body });
    if ((request.url ?? "").startsWith("/api/v1/auth/keys")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ key: "sk-orca-minted-by-pkce", scope: "api" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test.describe("orca pkce through the provider adapter", () => {
  test("a fake auth server completes authorize, callback, exchange, and persist", async () => {
    const auth = await startFakeAuth();
    const home = mkdtempSync(path.join(tmpdir(), "orca-pkce-"));
    try {
      const module = (await import(fileURLToPath(new URL("../../../packages/e2e/src/oauth/providers/orcarouter.ts", import.meta.url)))) as {
        createAuthProvider: (options: { env: Record<string, string>; loginTimeoutMs?: number }) => {
          login(callbacks: {
            onAuth(info: { url: string }): void;
            onPrompt(): Promise<string>;
            onProgress?(message: string): void;
            signal?: AbortSignal;
          }): Promise<{ access: string; refresh: string; expires: number }>;
        };
      };
      const storeModule = (await import(fileURLToPath(new URL("../../../packages/e2e/src/oauth/store.ts", import.meta.url)))) as {
        FileCredentialStore: new (file: string) => { get(id: string): Promise<unknown>; set(id: string, value: unknown): Promise<void> };
      };
      const provider = module.createAuthProvider({
        env: { ORCA_AUTH_BASE_URL: auth.url, ORCA_API_BASE_URL: "http://127.0.0.1:1/v1" },
      });
      const file = path.join(home, "oauth.json");
      const store = new storeModule.FileCredentialStore(file);
      const controller = new AbortController();

      const credentials = await provider.login({
        signal: controller.signal,
        onAuth(info) {
          // The authorize URL is on the fake auth origin, and carries a state
          // the callback server will check in constant time.
          const authorize = new URL(info.url);
          expect(authorize.origin).toBe(new URL(auth.url).origin);
          expect(authorize.pathname).toBe("/auth");
          expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
          const state = authorize.searchParams.get("state") ?? "";
          expect(state.length).toBeGreaterThan(10);
          // The verifier is never in the URL, and the challenge is not it.
          expect(info.url).not.toContain("code_verifier");
          // Drive the browser's redirect.
          const redirect = authorize.searchParams.get("callback_url") ?? "";
          expect(redirect.startsWith("http://localhost:")).toBe(true);
          void fetch(`${redirect}?code=fake-code&state=${encodeURIComponent(state)}`).catch(() => undefined);
        },
        async onPrompt() {
          throw new Error("the browser returned, so nothing should be pasted");
        },
      });
      await store.set("orcarouter-oauth", credentials);

      expect(credentials.access).toBe("sk-orca-minted-by-pkce");
      expect(credentials.refresh).toBe("");
      expect(credentials.expires).toBe(0);
      const exchange = auth.requests.find((request) => request.path.startsWith("/api/v1/auth/keys"));
      expect(exchange).toBeDefined();
      const body = JSON.parse(exchange?.body ?? "{}") as Record<string, string>;
      expect(body["code"]).toBe("fake-code");
      expect(body["code_challenge_method"]).toBe("S256");
      // A real verifier: base64url of 32 bytes is 43 characters.
      expect(body["code_verifier"]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(JSON.parse(readFileSync(file, "utf8")) as unknown).toMatchObject({
        "orcarouter-oauth": { access: "sk-orca-minted-by-pkce" },
      });
    } finally {
      await auth.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
