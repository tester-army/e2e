/**
 * The contract between a subscription login and the AI SDK: a provider knows
 * how to sign the user in, refresh what the login returned, and shape one API
 * request so the vendor accepts it with a subscription token. Everything else
 * (the credential file, the fetch that swaps the token in, the model
 * constructors) is shared.
 */

/** What a login returns and a refresh renews. Providers may add fields (an account id). */
export interface OAuthCredentials {
  readonly access: string;
  /** Empty when the vendor issues non-expiring tokens. */
  readonly refresh: string;
  /** Epoch milliseconds; `0` when the token does not expire. */
  readonly expires: number;
  readonly [key: string]: unknown;
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
  /**
   * Browser flows only: a prompt shown at once, alongside the callback server.
   * Whichever settles first, the pasted code or the callback, wins.
   */
  onManualCodeInput?(): Promise<string>;
  readonly signal?: AbortSignal;
}

/** A request the provider shaped, and how to read the vendor's answer to it. */
export interface PreparedRequest {
  readonly request: Request;
  /** Post-processes the response, e.g. folds a stream the vendor forces into the JSON the SDK asked for. */
  readonly finalize?: (response: Response) => Promise<Response>;
}

export interface OAuthProvider<Options = Record<string, never>> {
  readonly id: string;
  readonly name: string;
  /** Milliseconds before `expires` at which the token is refreshed ahead of a call. */
  readonly refreshSkewMs?: number;
  login(callbacks: OAuthLoginCallbacks, options?: Options): Promise<OAuthCredentials>;
  /** Renews the credentials, or throws an OAuthError when the user has to sign in again. */
  refresh(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  /**
   * Shapes one outgoing API request. It arrives with the bearer token and the
   * user agent already set and the SDK's own key header removed; the provider
   * rewrites the URL, adds vendor headers, and adjusts the body as needed.
   */
  prepareRequest?(request: Request, credentials: OAuthCredentials): Promise<PreparedRequest> | PreparedRequest;
}

/** Where credentials live between runs, keyed by provider id. */
export interface CredentialStore {
  get(providerId: string): Promise<OAuthCredentials | undefined>;
  set(providerId: string, credentials: OAuthCredentials): Promise<void>;
  remove(providerId: string): Promise<void>;
  /** Every provider id with stored credentials. */
  list(): Promise<string[]>;
}

/** The fetch signature AI SDK providers accept. */
export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
