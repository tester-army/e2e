"use client";

/**
 * OrcaRouter Connect, the benchmark app's own provider configuration surface.
 * The two ways in sit side by side and end with the same thing, an ordinary
 * `sk-orca-…` key:
 *
 * - **API key** — the user pastes a key, or the field reads
 *   `ORCAROUTER_API_KEY`. It is kept in memory, masked in the field, and only
 *   ever sent as an `Authorization: Bearer` header.
 * - **Connect with OrcaRouter** — OAuth 2.0 + PKCE. The browser is sent to the
 *   authorization origin, the redirect returns to this page with a code, and
 *   the code is redeemed at `/api/v1/auth/keys`, which mints the key.
 *
 * `resolveCredential` is the small seam both entries fill: whichever one ran,
 * `providerRequests()` and the catalog read the same `{ key }`. Nothing
 * downstream branches on which entry produced it.
 *
 * Every model list here is a `<select>` whose options come from the live
 * `GET /v1/models` body, filtered by the capability of the entry point it sits
 * at and recomputed when the attachment switch changes. An id that no longer
 * fits is cleared, never carried, and no control anywhere accepts a typed model
 * id.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadCatalog, type CatalogLoad } from "@/orca-catalog";
import {
  describeModel,
  modelsFor,
  type Capability,
  type CatalogModel,
} from "@/orca-options";

/**
 * Origin policy, mirroring `orcaRouterOrigins` in the provider package:
 * authentication and inference are two different public origins, each read
 * from its own value and never derived from the other — swapping a hostname
 * or appending a path yields `https://api.orcarouter.ai/v1/auth/keys`, which
 * is a 404. A remote origin is HTTPS; plain HTTP is allowed only on a loopback
 * host, so a local deployment can be exercised.
 */
const DEFAULT_AUTH_BASE_URL = "https://www.orcarouter.ai";
const DEFAULT_API_BASE_URL = "https://api.orcarouter.ai/v1";

function readOrigin(raw: string | undefined, fallback: string): string {
  const value = (raw ?? fallback).trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${value} is not a URL`);
  }
  const loopback = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "::1" || url.hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${value} must use HTTPS unless the host is loopback`);
  }
  return url.href.replace(/\/+$/u, "");
}

const AUTH_BASE_URL = readOrigin(process.env.NEXT_PUBLIC_ORCA_AUTH_BASE_URL, DEFAULT_AUTH_BASE_URL);
const API_BASE_URL = readOrigin(process.env.NEXT_PUBLIC_ORCA_API_BASE_URL, DEFAULT_API_BASE_URL);
const API_KEY_ENV = "ORCAROUTER_API_KEY";
const KEY_PREFIX = "sk-orca-";
const AUTHORIZE_PATH = "/auth";
const EXCHANGE_PATH = "/api/v1/auth/keys";
const PKCE_STORAGE_KEY = "orca.pkce";
const KEY_PLACEHOLDER = `${KEY_PREFIX}…`;

interface Credential {
  readonly key: string;
  /** Which entry produced it; shown to the user, never sent. */
  readonly source: "api-key" | "oauth";
}

interface CredentialResult {
  readonly credential: Credential;
}

/** The API-key adapter: shape-checks a pasted or environment key into a credential. */
function resolveApiKeyCredential(raw: string): CredentialResult {
  return { credential: { key: raw.trim().replace(/^["']|["']$/gu, ""), source: "api-key" } };
}

/** The PKCE adapter: the key the exchange minted into the same credential shape. */
function resolveOAuthCredential(key: string): CredentialResult {
  return { credential: { key, source: "oauth" } };
}

/** The masked form of a key: the prefix and the last four characters, never the whole value. */
function maskKey(key: string): string {
  if (key.length === 0) return "";
  return `${KEY_PREFIX}••••••••${key.slice(-4)}`;
}

/** base64url of random bytes from the platform RNG, no padding. */
function randomUrlSafe(bytes: number): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buffer))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** base64url(sha256(verifier)), no padding: the S256 code challenge. */
async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Constant-time comparison, so a mismatch says nothing about the expected value. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface EntryPoint {
  readonly id: "agent" | "vision" | "embedding" | "image" | "video" | "rerank";
  readonly capability: Capability;
  readonly label: string;
}

const AGENT_ENTRY_POINT: EntryPoint = { id: "agent", capability: "chat", label: "The agent" };

const CATALOG_ENTRY_POINTS: readonly EntryPoint[] = [
  { id: "embedding", capability: "embedding", label: "Embedding" },
  { id: "image", capability: "image", label: "Image generation" },
  { id: "video", capability: "video", label: "Video generation" },
  { id: "rerank", capability: "rerank", label: "Rerank" },
];

export default function OrcaRouterConnect() {
  const [catalog, setCatalog] = useState<CatalogLoad | undefined>(undefined);
  const [credential, setCredential] = useState<Credential | undefined>(undefined);
  const [draftKey, setDraftKey] = useState("");
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [fatal, setFatal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | undefined>(undefined);
  const [attachment, setAttachment] = useState<"none" | "image">("none");
  const [selected, setSelected] = useState<Partial<Record<EntryPoint["id"], string>>>({});
  const [authorizeUrl, setAuthorizeUrl] = useState<string | undefined>(undefined);

  // One generation per login attempt. A response that resolves after a newer
  // attempt started is dropped, and pagehide/reload invalidates in place, so
  // nothing but the newest attempt may write a credential.
  const generation = useRef(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);

  const beginAttempt = useCallback(() => {
    generation.current += 1;
    busyRef.current = true;
    setBusy(true);
    setHint(undefined);
    return generation.current;
  }, []);

  const settle = useCallback((attempt: number, apply: () => void) => {
    if (!mounted.current || attempt !== generation.current) return;
    busyRef.current = false;
    setBusy(false);
    setHint(undefined);
    apply();
  }, []);

  const accept = useCallback(
    (attempt: number, result: CredentialResult) => {
      settle(attempt, () => {
        setCredential(result.credential);
        setDraftKey("");
        setFatal(false);
        setNotice(undefined);
      });
    },
    [settle],
  );

  /** Releases the login lock without touching a stored credential; used by pagehide and cancel. */
  const releaseLogin = useCallback(() => {
    generation.current += 1;
    busyRef.current = false;
    setBusy(false);
    setHint(undefined);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadCatalog().then((load) => {
      if (mounted.current) setCatalog(load);
    });
    // pagehide fires when the page is being unloaded, before the `finally` of
    // an in-flight fetch could run. It has to clear the lock synchronously so a
    // second sign-in can start without a remount.
    const onPageHide = () => releaseLogin();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", onPageHide);
      releaseLogin();
    };
  }, [releaseLogin]);

  // Flow A: the redirect lands back on this page with `?code=&state=`.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (code === null || state === null) return;
    const pending = readPendingPkce();
    if (pending === undefined) {
      setFatal(true);
      setNotice("The browser returned a code with no sign-in in progress; start again.");
      return;
    }
    if (!constantTimeEqual(state, pending.state)) {
      setFatal(true);
      setNotice("The returned code belongs to a different sign-in attempt; start again.");
      return;
    }
    const attempt = beginAttempt();
    setHint("Exchanging the code for an OrcaRouter key.");
    void exchange(code, pending.verifier).then(
      (key) => {
        clearPendingPkce();
        history.replaceState(null, "", location.pathname);
        accept(attempt, resolveOAuthCredential(key));
      },
      (cause: unknown) => {
        clearPendingPkce();
        settle(attempt, () => {
          setFatal(true);
          setNotice(cause instanceof Error ? cause.message : String(cause));
        });
      },
    );
    // Runs once per mount; the redirect is a fresh page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const models = useMemo<readonly CatalogModel[]>(() => catalog?.models ?? [], [catalog]);
  const visionCapability: Capability = attachment === "image" ? "multimodal" : "chat";

  const capabilityFor = useCallback(
    (entry: EntryPoint): Capability => (entry.id === "agent" ? visionCapability : entry.capability),
    [visionCapability],
  );

  const optionsFor = useCallback(
    (entry: EntryPoint): CatalogModel[] => modelsFor(models, capabilityFor(entry)),
    [capabilityFor, models],
  );

  // An id that a capability change no longer admits has to go, or the control
  // would carry a model the entry point cannot serve. The longest option list
  // is what fails first, so its signature decides when to re-check.
  const offeredSignature = `${visionCapability}:${models.length}`;
  useEffect(() => {
    void offeredSignature;
    setSelected((current) => {
      let changed = false;
      const next = { ...current };
      for (const entry of [AGENT_ENTRY_POINT, ...CATALOG_ENTRY_POINTS]) {
        const value = next[entry.id];
        if (value === undefined) continue;
        if (!optionsFor(entry).some((model) => model.id === value)) {
          delete next[entry.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [offeredSignature, optionsFor]);

  const stored = credential !== undefined;

  const saveKey = useCallback(() => {
    const value = draftKey.trim();
    if (value === "") {
      setFatal(true);
      setNotice("Enter a key, or use Connect with OrcaRouter to get one.");
      return;
    }
    const attempt = beginAttempt();
    settle(attempt, () => {
      setFatal(false);
      setNotice(
        value.startsWith(KEY_PREFIX)
          ? undefined
          : `That value does not start with ${KEY_PREFIX}; storing it anyway, and the first request will say whether it works.`,
      );
      setCredential(resolveApiKeyCredential(value).credential);
      setDraftKey("");
    });
  }, [beginAttempt, draftKey, settle]);

  const clearKey = useCallback(() => {
    releaseLogin();
    setCredential(undefined);
    setDraftKey("");
    setFatal(false);
    setNotice("The stored OrcaRouter credential was cleared.");
  }, [releaseLogin]);

  /** Flow A: a fresh verifier and state per attempt, S256, then the consent screen. */
  const connect = useCallback(() => {
    const attempt = beginAttempt();
    setFatal(false);
    setNotice(undefined);
    setHint("Opening www.orcarouter.ai…");
    void (async () => {
      const verifier = randomUrlSafe(32);
      const state = randomUrlSafe(24);
      const challenge = await s256Challenge(verifier);
      if (attempt !== generation.current || !mounted.current) return;
      writePendingPkce({ verifier, state });
      const authorize = new URL(AUTHORIZE_PATH, `${AUTH_BASE_URL}/`);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("scope", "api");
      const url = authorize.toString();
      // The verifier itself is never in this URL, so showing it is safe, and it
      // is the fallback when the popup is blocked.
      setAuthorizeUrl(url);
      window.open(url, "orca-connect", "width=520,height=680");
      setHint("Approve in the browser; this page finishes when the redirect returns with the code.");
    })().catch((cause: unknown) => {
      settle(attempt, () => {
        setFatal(true);
        setNotice(cause instanceof Error ? cause.message : String(cause));
      });
    });
  }, [beginAttempt, settle]);

  const cancel = useCallback(() => {
    releaseLogin();
    clearPendingPkce();
    setAuthorizeUrl(undefined);
    setNotice(undefined);
  }, [releaseLogin]);

  return (
    <section
      aria-label="OrcaRouter provider configuration"
      data-testid="orca-connect"
      style={{ border: "1px solid #d4d4d4", borderRadius: 10, padding: 20, background: "#fff" }}
    >
      <h2 style={{ margin: 0, fontSize: 18 }}>OrcaRouter</h2>
      <p style={{ color: "#555", fontSize: 13, marginTop: 4 }}>
        One key for every model OrcaRouter serves. Sign in to get one, or paste one you already have.
      </p>

      <div data-testid="orca-auth-methods" style={{ display: "flex", gap: 16, alignItems: "stretch", marginTop: 16 }}>
        <fieldset data-testid="orca-api-key-method" style={{ border: "1px solid #e5e5e5", borderRadius: 8, padding: 14, flex: "1 1 0" }}>
          <legend style={{ fontSize: 13, fontWeight: 600 }}>API key</legend>
          <label htmlFor="orca-api-key" style={{ display: "block", fontSize: 12, color: "#555" }}>
            API key ({API_KEY_ENV})
          </label>
          <input
            id="orca-api-key"
            name="orca-api-key"
            type="password"
            autoComplete="off"
            data-testid="orca-api-key"
            placeholder={KEY_PLACEHOLDER}
            value={draftKey}
            onChange={(event) => setDraftKey(event.target.value)}
            style={{ width: "100%", marginTop: 6, padding: "8px 10px", border: "1px solid #ccc", borderRadius: 6 }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" data-testid="orca-save-key" onClick={saveKey}>
              Save key
            </button>
            <button type="button" data-testid="orca-clear-key" onClick={clearKey}>
              Clear
            </button>
          </div>
        </fieldset>

        <fieldset data-testid="orca-pkce-method" style={{ border: "1px solid #e5e5e5", borderRadius: 8, padding: 14, flex: "1 1 0" }}>
          <legend style={{ fontSize: 13, fontWeight: 600 }}>Connect with OrcaRouter</legend>
          <p style={{ fontSize: 12, color: "#555", margin: "0 0 10px" }}>
            OAuth 2.0 + PKCE in the browser. No client secret, no redirect URI to register.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" data-testid="orca-connect-start" onClick={connect} disabled={busy}>
              {busy ? "Connecting…" : "Connect with OrcaRouter"}
            </button>
            {busy ? (
              <button type="button" data-testid="orca-connect-cancel" onClick={cancel}>
                Cancel
              </button>
            ) : null}
          </div>
          <p data-testid="orca-credential-status" aria-live="polite" style={{ fontSize: 12, marginTop: 10 }}>
            {credential === undefined
              ? "Not connected."
              : `Connected with ${credential.source === "oauth" ? "OrcaRouter sign-in" : "an API key"}.`}
          </p>
          <p style={{ fontSize: 12, marginTop: 4 }}>
            <a
              data-testid="orca-authorize-url"
              data-verifier-in-url="false"
              href={authorizeUrl ?? `${AUTH_BASE_URL}${AUTHORIZE_PATH}`}
              target="orca-connect"
              rel="noreferrer"
            >
              {authorizeUrl === undefined ? `${AUTH_BASE_URL}${AUTHORIZE_PATH}` : "Open the authorization page"}
            </a>
          </p>
        </fieldset>
      </div>

      {hint === undefined ? null : (
        <p data-testid="orca-login-hint" style={{ fontSize: 12, color: "#555" }}>
          {hint}
        </p>
      )}

      <div style={{ marginTop: 14, padding: 12, background: "#fafafa", border: "1px solid #eee", borderRadius: 8 }}>
        <span style={{ fontSize: 12, color: "#555" }}>Credential</span>
        <div
          data-testid="orca-credential-masked"
          data-secret-masked={stored ? "true" : "false"}
          style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13, marginTop: 4 }}
        >
          {stored ? maskKey(credential.key) : "none"}
        </div>
        <div data-testid="orca-auth-header" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "#333", marginTop: 6 }}>
          Authorization: Bearer {stored ? maskKey(credential.key) : "—"}
        </div>
        <div style={{ fontSize: 12, color: "#555", marginTop: 8 }}>
          Inference base URL <code>{API_BASE_URL}</code> · authorised by <code>{AUTH_BASE_URL}</code>
        </div>
      </div>

      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label htmlFor="orca-model-agent" style={{ fontSize: 13, fontWeight: 600 }}>
              {attachment === "image" ? "Agent model (with an image)" : "Agent model (text)"}
            </label>
            <button
              type="button"
              data-testid="orca-attachment-toggle"
              aria-pressed={attachment === "image"}
              onClick={() => setAttachment((current) => (current === "image" ? "none" : "image"))}
            >
              {attachment === "image" ? "Remove image attachment" : "Attach an image"}
            </button>
          </div>
          <select
            id="orca-model-agent"
            data-testid="orca-model-agent"
            data-capability={visionCapability}
            value={selected.agent ?? ""}
            onChange={(event) => setSelected((current) => ({ ...current, agent: event.target.value }))}
            disabled={!stored}
            style={{ width: 460, marginTop: 6, padding: "6px 8px" }}
          >
            <option value="">Choose a model</option>
            {optionsFor(AGENT_ENTRY_POINT).map((model) => (
              <option key={model.id} value={model.id}>
                {describeModel(model, visionCapability)}
              </option>
            ))}
          </select>
        </div>

        {CATALOG_ENTRY_POINTS.map((entry) => (
          <div key={entry.id}>
            <label htmlFor={`orca-model-${entry.id}`} style={{ fontSize: 13, fontWeight: 600 }}>
              {entry.label}
            </label>
            <select
              id={`orca-model-${entry.id}`}
              data-testid={`orca-model-${entry.id}`}
              data-capability={entry.capability}
              value={selected[entry.id] ?? ""}
              onChange={(event) => setSelected((current) => ({ ...current, [entry.id]: event.target.value }))}
              disabled={!stored}
              style={{ width: 460, marginTop: 6, padding: "6px 8px" }}
            >
              <option value="">Choose a model</option>
              {optionsFor(entry).map((model) => (
                <option key={model.id} value={model.id}>
                  {describeModel(model, entry.capability)}
                </option>
              ))}
            </select>
          </div>
        ))}

        <p data-testid="orca-catalog-status" style={{ fontSize: 12, color: "#555" }}>
          {catalog === undefined
            ? "Loading the model catalog…"
            : catalog.degraded
              ? `Catalog unavailable (${catalog.reason ?? "unknown"}); showing the verified fallback.`
              : `${catalog.models.length} models from ${API_BASE_URL}/models.`}
        </p>
      </div>

      {notice === undefined ? null : (
        <p data-testid="orca-notice" role="alert" style={{ color: fatal ? "#b3261e" : "#555", fontSize: 13 }}>
          {notice}
        </p>
      )}
    </section>
  );
}

interface PendingPkce {
  readonly verifier: string;
  readonly state: string;
}

function writePendingPkce(pending: PendingPkce): void {
  try {
    sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // A browser with storage disabled still finishes the flow; the code arrives in this tab.
  }
}

function readPendingPkce(): PendingPkce | undefined {
  try {
    const raw = sessionStorage.getItem(PKCE_STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<PendingPkce>;
    return typeof parsed.verifier === "string" && typeof parsed.state === "string"
      ? { verifier: parsed.verifier, state: parsed.state }
      : undefined;
  } catch {
    return undefined;
  }
}

function clearPendingPkce(): void {
  try {
    sessionStorage.removeItem(PKCE_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Redeems the code at the auth origin; the inference origin never serves this path. */
async function exchange(code: string, verifier: string): Promise<string> {
  const url = new URL(EXCHANGE_PATH, `${AUTH_BASE_URL}/`);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (response.status === 403) {
    throw new Error("OrcaRouter refused the code (unknown, expired, already used, or the verifier did not match); start again.");
  }
  if (response.status === 429) {
    throw new Error("OrcaRouter rate-limited the sign-in (429); wait a moment and try again, or use an API key.");
  }
  if (!response.ok) throw new Error(`the OrcaRouter exchange failed: HTTP ${response.status}`);
  const payload = (await response.json()) as { key?: unknown; scope?: unknown };
  if (typeof payload.key !== "string" || payload.key === "") throw new Error("the OrcaRouter exchange returned no key");
  if (typeof payload.scope === "string" && payload.scope !== "" && payload.scope !== "api") {
    throw new Error(`OrcaRouter granted the "${payload.scope}" scope rather than "api", which cannot call the inference API.`);
  }
  return payload.key;
}
