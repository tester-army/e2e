/**
 * The contract between a subscription login and the AI SDK: a provider knows
 * how to sign the user in, refresh what the login returned, and send one API
 * request the vendor's way with a subscription token. Everything else (the
 * credential file, the fetch that swaps the token in, the model
 * constructors) is shared.
 */

/** What a login returns and a refresh renews; providers extend it with what their requests need. */
export interface OAuthCredentials {
  readonly access: string;
  /**
   * Empty when the vendor issues non-expiring tokens, and empty when the
   * vendor issues a durable key with no refresh grant at all (OrcaRouter):
   * such a credential is reused until the vendor revokes it.
   */
  readonly refresh: string;
  /** Epoch milliseconds; `0` when the token does not expire. */
  readonly expires: number;
}

/** Where the user is sent and, for device flows, the code to enter there. */
export interface OAuthAuthInfo {
  readonly url: string;
  readonly instructions: string;
  readonly userCode?: string;
}

export interface OAuthPrompt {
  readonly message: string;
  readonly placeholder?: string;
}

/** How a login flow talks to the terminal (or whatever hosts it). */
export interface OAuthLoginCallbacks {
  /** The URL to open and how to finish there. Called once per flow. */
  onAuth(info: OAuthAuthInfo): void;
  /** Asks the user for text: the pasted code when the local callback never arrives. */
  onPrompt(prompt: OAuthPrompt): Promise<string>;
  onProgress?(message: string): void;
  readonly signal?: AbortSignal;
}

/** The fetch signature AI SDK providers accept. */
export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OAuthProvider<Credentials extends OAuthCredentials = OAuthCredentials, LoginOptions = unknown> {
  readonly id: string;
  readonly name: string;
  login(callbacks: OAuthLoginCallbacks, options?: LoginOptions): Promise<Credentials>;
  /** Renews the credentials, or throws an OAuthError when the user has to sign in again. */
  refresh(credentials: Credentials): Promise<Credentials>;
  /**
   * A credential the process environment already holds, for a provider whose
   * key users keep in one variable. Consulted before the store, so an
   * explicitly set variable wins over a stored login, the way an `E2E_USER_*`
   * override wins over the config. Absent or `undefined`, the store decides.
   */
  environmentCredentials?(): Credentials | undefined;
  /**
   * Sends one API request. It arrives with the bearer token and the user
   * agent set and the SDK's own key header removed; the provider rewrites the
   * URL, adds vendor headers, adjusts the body, and reads the answer as the
   * vendor gives it. Absent, the request goes out as is.
   */
  send?(request: Request, credentials: Credentials, upstream: FetchFunction): Promise<Response>;
  /**
   * The models the subscription serves, asked of the vendor with `fetch`,
   * which carries the login the way `send` does. Absent when the vendor
   * publishes no list.
   */
  models?(fetch: FetchFunction): Promise<SubscriptionModel[]>;
}

/** One model a subscription serves: the id a config passes to the constructor, and how the vendor describes it. */
export interface SubscriptionModel {
  readonly id: string;
  readonly name?: string;
  /** Vendor facts worth a glance: reasoning levels, vision, preview, hidden. */
  readonly detail?: string;
}

/**
 * Where credentials live between runs, keyed by provider id. A store holds
 * whatever each provider's login returned, so a provider reads back its own
 * shape.
 */
export interface CredentialStore {
  get(providerId: string): Promise<OAuthCredentials | undefined>;
  set(providerId: string, credentials: OAuthCredentials): Promise<void>;
  remove(providerId: string): Promise<void>;
  /** Every provider id with stored credentials. */
  list(): Promise<string[]>;
}
