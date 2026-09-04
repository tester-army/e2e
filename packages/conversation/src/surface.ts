/**
 * The conversation surface: one AI SDK agent (or chat endpoint) held as a
 * `ConversationSession`, exposed to the runner as observe/locate/perform.
 * It owns the id space (one fresh generation per observation), the pending
 * draft, and the translation between the contract's vocabulary and the
 * session: a `fill` on the composer stages a message, `press Enter` sends it,
 * a `tap` on Approve or Deny answers a paused tool. The runner owns the rest.
 */

import {
  BackendError,
  type BackendAttemptContext,
  type BackendCleanupContext,
  type BackendInitInfo,
  type BackendSnapshot,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
  type SemanticNode,
} from '@e2edev/e2e/backend';
import { resolveExpression } from './locate.ts';
import {
  lastAssistantText,
  pendingApprovals,
  projectTranscript,
  toolCallsOf,
  type ProjectedNode,
  type ToolCall,
  type UIMessageLike,
} from './messages.ts';
import { ConversationSession, type ChatTransportLike } from './session.ts';
import { conversationUrl, invalidState, notActionable, unsupported } from './support.ts';

/** How the backend reaches the agent under test. Exactly one field is set. */
export interface ConversationTarget {
  /**
   * An AI SDK v7 agent object (`new Experimental_Agent({...})`). The backend
   * wraps it in the SDK's `DirectChatTransport`, so the agent runs in this
   * process with no HTTP in between.
   */
  readonly agent?: unknown;
  /**
   * A deployed chat endpoint that speaks the AI SDK UI message stream
   * protocol (a Next.js `/api/chat` route). The backend drives it with the
   * SDK's `DefaultChatTransport`, so the test exercises what is shipped.
   */
  readonly api?: string;
  /** A ready-made `ChatTransport`, for a transport the two above cannot express. */
  readonly transport?: ChatTransportLike;
}

export interface ConversationOptions extends ConversationTarget {
  /** A label for reports and the path anchor; defaults to the agent id or "agent". */
  readonly name?: string;
  /**
   * A prior transcript seeded before every attempt, so a test can start
   * mid-conversation. User and assistant messages only: an agent owns its own
   * system prompt (its AI SDK `instructions`), and a second system message in
   * the prompt is rejected by the SDK, so a `system`-role seed is refused at
   * config load.
   */
  readonly history?: readonly UIMessageLike[];
  /** Extra headers for the `api` transport (auth, say). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** The AI SDK constructors this backend needs, resolved once from the peer dependency. */
interface TransportModule {
  DirectChatTransport: new (options: { agent: unknown }) => ChatTransportLike;
  DefaultChatTransport: new (options: { api: string; headers?: Record<string, string> }) => ChatTransportLike;
}

let transportModule: TransportModule | undefined;
async function loadTransports(): Promise<TransportModule> {
  if (transportModule !== undefined) return transportModule;
  const mod = (await import('ai')) as unknown as TransportModule;
  transportModule = mod;
  return mod;
}

export class ConversationSurface {
  private session: ConversationSession | undefined;
  private generation = new Map<string, ProjectedNode>();
  private idCounter = 0;
  private draft = '';
  private agentLabel = 'agent';

  constructor(readonly options: ConversationOptions) {
    const set = [options.agent, options.api, options.transport].filter((value) => value !== undefined);
    if (set.length !== 1) {
      throw new BackendError('INVALID_STATE', 'conversation() needs exactly one of `agent`, `api`, or `transport`', {
        retryable: false,
      });
    }
    if ((options.history ?? []).some((message) => message.role === 'system')) {
      throw new BackendError(
        'INVALID_STATE',
        'conversation() history cannot include a system message; an agent owns its own system prompt',
        { retryable: false },
      );
    }
  }

  get attemptRunning(): boolean {
    return this.session !== undefined;
  }

  /** Structured tool-call view for the fixture and assertions, optionally by tool name. */
  toolCalls(name?: string): ToolCall[] {
    const calls = toolCallsOf(this.requireSession().transcript);
    return name === undefined ? calls : calls.filter((call) => call.name === name);
  }

  /** The whole transcript, for the fixture. */
  transcript(): readonly UIMessageLike[] {
    return this.requireSession().transcript;
  }

  private requireSession(): ConversationSession {
    if (this.session === undefined) throw invalidState('no conversation is open; the surface acts inside an attempt only');
    return this.session;
  }

  private label(): string {
    const agent = this.options.agent as { id?: unknown } | undefined;
    const fromAgent = agent !== undefined && typeof agent.id === 'string' ? agent.id : undefined;
    return this.options.name ?? fromAgent ?? (this.options.api !== undefined ? this.options.api : 'agent');
  }

  private seed(): UIMessageLike[] {
    return (this.options.history ?? []).map((message) => message);
  }

  async init(info: BackendInitInfo): Promise<void> {
    this.agentLabel = this.label();
    // Fail fast at worker start if the peer or the target is wrong, not on the first step.
    if (this.options.agent !== undefined || this.options.api !== undefined) await loadTransports();
    void info;
  }

  private async buildTransport(): Promise<ChatTransportLike> {
    if (this.options.transport !== undefined) return this.options.transport;
    const { DirectChatTransport, DefaultChatTransport } = await loadTransports();
    if (this.options.agent !== undefined) return new DirectChatTransport({ agent: this.options.agent });
    return new DefaultChatTransport({
      api: this.options.api as string,
      ...(this.options.headers === undefined ? {} : { headers: { ...this.options.headers } }),
    });
  }

  async startAttempt(context: BackendAttemptContext): Promise<void> {
    if (this.session !== undefined) throw invalidState('an attempt is already running on this conversation backend');
    this.generation = new Map();
    this.draft = '';
    this.session = new ConversationSession({
      transport: await this.buildTransport(),
      chatId: context.attemptId,
      initialMessages: this.seed(),
    });
  }

  async endAttempt(_context: BackendCleanupContext): Promise<void> {
    this.session = undefined;
    this.generation = new Map();
    this.draft = '';
  }

  async dispose(_context: BackendCleanupContext): Promise<void> {
    this.session = undefined;
    this.generation = new Map();
  }

  /** `app.restart()`: a fresh conversation from the seeded history. */
  async restart(_operation: OperationContext): Promise<void> {
    this.requireSession().reset();
    this.draft = '';
    this.generation = new Map();
  }

  private project() {
    const session = this.requireSession();
    return projectTranscript(session.transcript, {
      agentLabel: this.agentLabel,
      status: session.status,
      draft: this.draft,
      mintId: () => {
        this.idCounter += 1;
        return `n${this.idCounter}`;
      },
    });
  }

  async observe(_operation: OperationContext): Promise<BackendSnapshot> {
    const projected = this.project();
    this.generation = new Map(projected.index.map((entry) => [entry.id, entry]));
    return { nodes: [projected.root] };
  }

  async locate(expression: LocatorExpression, _operation: OperationContext): Promise<readonly SemanticNode[]> {
    const projected = this.project();
    const found = resolveExpression(expression, projected.index);
    for (const entry of projected.index) this.generation.set(entry.id, entry);
    return found.map((entry) => entry.node);
  }

  private resolveRef(ref: NodeRef): ProjectedNode {
    const entry = this.generation.get(ref.id);
    if (entry === undefined) {
      throw new BackendError('NODE_STALE', `node ${ref.id} is not part of the newest observation`, { retryable: true });
    }
    return entry;
  }

  async perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    const entry = this.resolveRef(ref);
    const intent = entry.intent;
    switch (action.kind) {
      case 'fill':
        if (intent?.kind !== 'send') throw notActionable(`node ${entry.id} is not the composer; only the composer accepts typing`);
        this.draft = action.value;
        return;
      case 'clear':
        if (intent?.kind !== 'send') throw notActionable(`node ${entry.id} is not the composer`);
        this.draft = '';
        return;
      case 'press':
        if (intent?.kind !== 'send') throw notActionable(`node ${entry.id} is not the composer`);
        if (action.key !== 'Enter' && action.key !== 'Return') {
          throw unsupported(`the composer only submits on Enter; "${action.key}" is not a conversation key`);
        }
        return this.sendDraft(operation);
      case 'tap':
        if (intent?.kind !== 'approve') {
          throw notActionable(`node ${entry.id} is not an Approve or Deny control`);
        }
        return this.respond(intent.approvalId, intent.approved, operation);
      case 'focus':
        return undefined;
      case 'doubleTap':
      case 'check':
      case 'uncheck':
      case 'hover':
      case 'longPress':
      case 'selectOption':
      case 'setInputFiles':
      case 'dragTo':
      case 'scrollIntoView':
      case 'swipe':
        throw unsupported(`a conversation cannot perform "${action.kind}"; type into the composer or tap Approve or Deny`);
    }
  }

  /** Sends whatever is staged in the composer and clears it. */
  async sendDraft(operation: OperationContext): Promise<void> {
    const text = this.draft.trim();
    if (text === '') throw notActionable('the composer is empty; fill it before pressing Enter');
    this.draft = '';
    await this.send(text, operation);
  }

  /** Sends one message directly (the fixture's `send`), bypassing the composer draft. */
  async send(text: string, operation: OperationContext): Promise<void> {
    await this.requireSession().send(text, operation.signal);
  }

  /** Answers one pending approval (the fixture's `approve`/`deny`). */
  async respond(approvalId: string, approved: boolean, operation: OperationContext, reason?: string): Promise<void> {
    await this.requireSession().respond(approvalId, approved, reason, operation.signal);
  }

  /** The single pending approval, or a clear error when there is not exactly one. */
  soleApproval(): { approvalId: string; name: string } {
    const pending = pendingApprovals(this.requireSession().transcript);
    if (pending.length === 0) throw invalidState('no tool approval is pending');
    if (pending.length > 1) throw invalidState('several tool approvals are pending; answer them by name');
    const [only] = pending;
    return { approvalId: only!.approvalId, name: only!.name };
  }

  /** A pending approval by tool name. */
  approvalFor(name: string): { approvalId: string } {
    const pending = pendingApprovals(this.requireSession().transcript).filter((entry) => entry.name === name);
    if (pending.length === 0) throw invalidState(`no pending approval for tool "${name}"`);
    return { approvalId: pending[0]!.approvalId };
  }

  lastText(): string {
    return lastAssistantText(this.requireSession().transcript);
  }

  status(): string {
    return this.requireSession().status;
  }

  async url(_operation: OperationContext): Promise<string> {
    return conversationUrl(this.agentLabel, this.session?.status ?? 'ready');
  }
}
