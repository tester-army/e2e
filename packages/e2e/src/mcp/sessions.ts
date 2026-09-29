/**
 * The bookkeeping behind `e2e mcp`'s sessions: which exist and in what
 * phase, what each holds, the limit, and the errors a call that names a
 * session gets. A session is one entry from the moment it is admitted until
 * its attempt has closed, so the limit and the engine and config claims
 * cover a session still booting or still tearing down, while a name resolves
 * only to a session that is live. The lifecycle itself, opening an attempt
 * and closing it, belongs to the host; this module only orders it.
 */

import type { EngineHandle } from '../engine/index.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { uuidv7 } from '../internal/ids.ts';

/** How many ended sessions keep the reason they ended, for the error a call naming one gets. */
const ENDED_KEPT = 32;

/** What the registry reads of a live session. */
export interface NamedSession {
  readonly id: string;
  readonly target: { readonly name: string };
}


type Phase<S> =
  | { readonly phase: 'opening' }
  | { readonly phase: 'live'; readonly session: S }
  | { readonly phase: 'closing'; readonly session: S; readonly reason: string; readonly closed: Promise<string> };

interface Entry<S> {
  phase: Phase<S>;
  /**
   * The config the session loads. Credentials and secrets resolve through one
   * process-wide registry, so every session shares one config; claimed
   * before the file evaluates, since its top-level code resolves secrets
   * against the registry an open session installed.
   */
  configPath: string | undefined;
  /** The target's engine instance, which runs one attempt at a time. */
  engine: EngineHandle | undefined;
  /** Settles when the open does, whatever its outcome. */
  opened: Promise<unknown>;
}

export class SessionRegistry<S extends NamedSession> {
  private readonly entries = new Map<string, Entry<S>>();
  /** Why recent sessions ended, oldest first. */
  private readonly ended = new Map<string, string>();
  /** Set once the server shuts down: nothing new is admitted, ever. */
  private draining = false;

  constructor(private readonly limit: number) {}

  /** Whether any session is live. */
  get hasLive(): boolean {
    return this.live().length > 0;
  }

  /**
   * Admits a session and runs `open` for it under a fresh id. A session whose
   * open fails leaves once `open` has settled, after the host tore down what
   * it opened, so its claims hold until then.
   */
  admit(open: (id: string) => Promise<string>): Promise<string> {
    if (this.draining) return Promise.reject(new ConfigurationError('SESSION_OPEN', 'the server is shutting down; no session can open'));
    if (this.entries.size >= this.limit) return Promise.reject(this.limitReached());
    const id = uuidv7();
    const entry: Entry<S> = { phase: { phase: 'opening' }, configPath: undefined, engine: undefined, opened: Promise.resolve() };
    this.entries.set(id, entry);
    const opened = open(id).catch((cause: unknown) => {
      this.entries.delete(id);
      throw cause;
    });
    entry.opened = opened;
    return opened;
  }

  /** Claims the config for an opening session before it loads, or refuses a config other than the one open sessions share. */
  claimConfig(id: string, configPath: string): void {
    const holder = this.others(id).find(([, entry]) => entry.configPath !== undefined && entry.configPath !== configPath);
    if (holder !== undefined) {
      const [holderId, entry] = holder;
      throw new ConfigurationError(
        'CONFIG_IN_USE',
        `session ${holderId} is open on config ${entry.configPath}; sessions open at once share one config, because credentials and secrets resolve process-wide; open this one on that config, or close every session on it first`,
      );
    }
    this.require(id).configPath = configPath;
  }

  /** Claims the target's engine instance for an opening session, or refuses one another session is driving. */
  claimEngine(id: string, target: string, engine: EngineHandle | undefined): void {
    const holder = this.others(id).find(([, entry]) => engine !== undefined && entry.engine === engine);
    if (holder !== undefined) {
      const [holderId] = holder;
      throw new ConfigurationError(
        'ENGINE_IN_USE',
        `target "${target}" gets its engine instance from a package, so every session shares it, and session ${holderId} is driving it; create the engine in the config or a file it imports by path, or close_session ${holderId} first`,
      );
    }
    this.require(id).engine = engine;
  }

  /** Makes an opened session live: from now on calls resolve to it. */
  activate(session: S): void {
    this.require(session.id).phase = { phase: 'live', session };
  }

  /** Whether `id` names a live session. */
  isLive(id: string): boolean {
    return this.entries.get(id)?.phase.phase === 'live';
  }

  /** The session a call names, or the only live one when it names none. */
  resolve(id: string | undefined): S {
    if (id !== undefined) {
      const phase = this.entries.get(id)?.phase;
      if (phase?.phase === 'live') return phase.session;
      if (phase?.phase === 'closing') throw new ConfigurationError('NO_SESSION', `session "${id}" is closing (${phase.reason})`);
      const ended = this.ended.get(id);
      if (ended !== undefined) throw new ConfigurationError('NO_SESSION', `session "${id}" ended: ${ended}; call open_session for a new one`);
      const live = this.live();
      throw new ConfigurationError('NO_SESSION', `session "${id}" is not open; ${live.length === 0 ? 'no session is open' : `open: ${describe(live)}`}`);
    }
    const live = this.live();
    const [only] = live;
    if (only === undefined) {
      const previous = [...this.ended.values()].at(-1);
      throw new ConfigurationError('NO_SESSION', `no session is open; call open_session first${previous === undefined ? '' : ` (the previous session ended: ${previous})`}`);
    }
    if (live.length > 1) throw new ConfigurationError('SESSION_REQUIRED', `${live.length} sessions are open; pass session to name one: ${describe(live)}`);
    return only;
  }

  /**
   * Closes the session a call names, or the only live one, with `teardown`;
   * the session leaves, and its claims go, once `teardown` settles. Closing a
   * session already closing returns the same close.
   */
  close(id: string | undefined, reason: string, teardown: (session: S) => Promise<string>): Promise<string> {
    const phase = id === undefined ? undefined : this.entries.get(id)?.phase;
    if (phase?.phase === 'closing') return phase.closed;
    const session = this.resolve(id);
    const closed = teardown(session).finally(() => {
      this.entries.delete(session.id);
      this.remember(session.id, reason);
    });
    this.require(session.id).phase = { phase: 'closing', session, reason, closed };
    return closed;
  }

  /**
   * Closes every session once the opens still running have settled, and
   * admits nothing from then on, so no session starts an app or a browser
   * while the server goes away. Returns what each close it ran reported.
   */
  async closeAll(reason: string, teardown: (session: S) => Promise<string>): Promise<string[]> {
    this.draining = true;
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.opened));
    const closing = [...this.entries.values()].map((entry) => entry.phase).filter((phase) => phase.phase === 'closing');
    const summaries = await Promise.all(this.live().map((session) => this.close(session.id, reason, teardown)));
    await Promise.allSettled(closing.map((phase) => phase.closed));
    return summaries;
  }

  /** Every admitted session but `id`, with its entry. */
  private others(id: string): [string, Entry<S>][] {
    return [...this.entries].filter(([other]) => other !== id);
  }

  /** The live sessions, in the order they were admitted. */
  private live(): S[] {
    return [...this.entries.values()].flatMap((entry) => (entry.phase.phase === 'live' ? [entry.phase.session] : []));
  }

  /** The entry of an admitted session; the host only names ids the registry gave it. */
  private require(id: string): Entry<S> {
    const entry = this.entries.get(id);
    if (entry === undefined) throw new Error(`session ${id} is not admitted`);
    return entry;
  }

  private limitReached(): ConfigurationError {
    const slots = [...this.entries.values()].map((entry) =>
      entry.phase.phase === 'opening' ? 'one opening' : `${describe([entry.phase.session])}${entry.phase.phase === 'closing' ? ' (closing)' : ''}`,
    );
    return new ConfigurationError(
      'SESSION_OPEN',
      `no session slot is free (e2e mcp --max-sessions ${this.limit}): ${slots.join(', ')}; close_session one first`,
    );
  }

  /** Keeps why a session ended, forgetting the oldest beyond `ENDED_KEPT`. */
  private remember(id: string, reason: string): void {
    this.ended.set(id, reason);
    const [oldest] = this.ended.keys();
    if (this.ended.size > ENDED_KEPT && oldest !== undefined) this.ended.delete(oldest);
  }
}

/** Sessions by id and target, for a message. */
function describe(sessions: readonly NamedSession[]): string {
  return sessions.map((session) => `${session.id} on "${session.target.name}"`).join(', ');
}
