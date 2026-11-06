/**
 * Chromium's DevTools protocol, reached through chromium-bidi's `goog:cdp`
 * extension: commands and events typed by `devtools-protocol`, sent to the
 * CDP session of one browsing context's target or to the browser.
 */

import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import type { BidiConnection } from './connection.ts';

/** A CDP command name. */
type CdpMethod = keyof ProtocolMapping.Commands;

/** The parameters of `M`; an empty object for a command that takes none. */
type CdpParams<M extends CdpMethod> = M extends CdpMethod ? (ProtocolMapping.Commands[M]['paramsType'] extends [] ? Record<string, never> : NonNullable<ProtocolMapping.Commands[M]['paramsType'][0]>) : never;

/** What `M` resolves with. */
type CdpResult<M extends CdpMethod> = ProtocolMapping.Commands[M]['returnType'];

/** A CDP event name. */
type CdpEvent = keyof ProtocolMapping.Events;

/** A CDP command with its parameters, as a feature builds it before sending. */
export type CdpCommand<M extends CdpMethod = CdpMethod> = { [K in M]: { readonly method: K; readonly params: CdpParams<K> } }[M];

/** CDP on one target session, or on the browser when `session` is undefined. */
export class ChromiumCdp {
  private constructor(
    private readonly connection: BidiConnection,
    readonly session: string | undefined,
  ) {}

  /** CDP on the target that renders `context`; frames one process renders share it. */
  static async forContext(connection: BidiConnection, context: string): Promise<ChromiumCdp> {
    const { session } = (await connection.sendExtension('goog:cdp.getSession', { context })) as { session?: string };
    return new ChromiumCdp(connection, session);
  }

  /** CDP on the browser target. */
  static browser(connection: BidiConnection): ChromiumCdp {
    return new ChromiumCdp(connection, undefined);
  }

  /** Sends one command and resolves with its result. */
  async send<M extends CdpMethod>(method: M, params: CdpParams<M>): Promise<CdpResult<M>> {
    const reply = (await this.connection.sendExtension('goog:cdp.sendCommand', { method, params, ...(this.session === undefined ? {} : { session: this.session }) })) as { result: CdpResult<M> };
    return reply.result;
  }

  /** Listens for `event` from this session; returns the unsubscribe. The BiDi session must subscribe to `goog:cdp.<event>` too. */
  on<E extends CdpEvent>(event: E, handler: (params: ProtocolMapping.Events[E][0]) => void): () => void {
    return this.connection.onExtension(`goog:cdp.${event}`, (envelope) => {
      if (envelope['session'] === this.session) handler(envelope['params'] as ProtocolMapping.Events[E][0]);
    });
  }
}
