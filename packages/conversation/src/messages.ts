/**
 * The AI SDK vocabulary this backend reads, and the projection of a
 * `UIMessage[]` transcript onto the contract's `SemanticNode` tree.
 *
 * The AI SDK types are structural, so this module declares only the shape it
 * consumes rather than importing the SDK's generic `UIMessage`: a message is
 * a role plus parts, a part is a text part or a tool part, and a tool part
 * carries a state, an input, an output, and (when the tool asked for one) an
 * approval. That keeps the projection independent of the SDK's type
 * parameters while matching what `readUIMessageStream` produces at runtime.
 */

import type { SemanticNode } from '@e2edev/e2e/backend';

export type MessageRole = 'system' | 'user' | 'assistant';

/** A tool invocation's lifecycle, as the AI SDK reports it on a UI tool part. */
export type ToolState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied';

export interface UIApproval {
  readonly id: string;
  approved?: boolean;
  reason?: string;
}

/** One message part: a text part, a reasoning part, or a tool part. */
export interface UIPart {
  readonly type: string;
  readonly text?: string;
  readonly state?: ToolState;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly errorText?: string;
  approval?: UIApproval;
}

export interface UIMessageLike {
  readonly id: string;
  readonly role: MessageRole;
  readonly parts: readonly UIPart[];
}

/** The tool name of a tool part: `tool-<name>` for a static tool, `toolName` for a dynamic one. */
function toolNameOf(part: UIPart): string | undefined {
  if (part.type === 'dynamic-tool') return part.toolName;
  if (part.type.startsWith('tool-')) return part.type.slice('tool-'.length);
  return undefined;
}

/** One recorded tool call, the structured view the fixture and assertions read. */
export interface ToolCall {
  readonly name: string;
  readonly toolCallId: string;
  readonly state: ToolState;
  readonly input: unknown;
  readonly output: unknown;
  readonly errorText?: string;
  readonly approved?: boolean;
  readonly approvalId?: string;
}

/** Every tool call in the transcript, in order, newest calls last. */
export function toolCallsOf(messages: readonly UIMessageLike[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      const name = toolNameOf(part);
      if (name === undefined || part.toolCallId === undefined) continue;
      calls.push({
        name,
        toolCallId: part.toolCallId,
        state: part.state ?? 'input-available',
        input: part.input,
        output: part.output,
        ...(part.errorText === undefined ? {} : { errorText: part.errorText }),
        ...(part.approval?.approved === undefined ? {} : { approved: part.approval.approved }),
        ...(part.approval?.id === undefined ? {} : { approvalId: part.approval.id }),
      });
    }
  }
  return calls;
}

/** The concatenated text of one message's text parts. */
export function textOf(message: UIMessageLike): string {
  return message.parts
    .filter((part) => part.type === 'text' && part.text !== undefined)
    .map((part) => part.text)
    .join('')
    .trim();
}

/** The newest assistant message's text, or '' when the assistant has not spoken. */
export function lastAssistantText(messages: readonly UIMessageLike[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as UIMessageLike;
    if (message.role === 'assistant') return textOf(message);
  }
  return '';
}

/** A tool part still waiting on a human decision, with its approval id. */
export interface PendingApproval {
  readonly toolCallId: string;
  readonly name: string;
  readonly approvalId: string;
  readonly input: unknown;
}

/** Every approval the newest assistant turn is blocked on. */
export function pendingApprovals(messages: readonly UIMessageLike[]): PendingApproval[] {
  const last = messages.at(-1);
  if (last === undefined || last.role !== 'assistant') return [];
  const pending: PendingApproval[] = [];
  for (const part of last.parts) {
    const name = toolNameOf(part);
    if (name === undefined || part.state !== 'approval-requested' || part.approval?.id === undefined || part.toolCallId === undefined) {
      continue;
    }
    pending.push({ toolCallId: part.toolCallId, name, approvalId: part.approval.id, input: part.input });
  }
  return pending;
}

/** What the composer node an action targets should do. */
export type ComposerIntent = { readonly kind: 'send' } | { readonly kind: 'approve'; readonly approvalId: string; readonly approved: boolean };

/** One projected node with the geometry-free addressing a conversation needs. */
export interface ProjectedNode {
  readonly id: string;
  readonly node: SemanticNode;
  /** What a tap or Enter on this node means; absent for read-only nodes. */
  readonly intent?: ComposerIntent;
  readonly parent?: ProjectedNode | undefined;
}

export interface ProjectedTranscript {
  readonly root: SemanticNode;
  /** Every node in document order, root first. */
  readonly index: readonly ProjectedNode[];
}

function truncate(value: unknown, limit = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Projects one transcript. `mintId` is called once per node in document
 * order, so the surface's id space stays unique across observations.
 * `composer` adds the input row and, when the turn is paused on approvals,
 * the Approve and Deny buttons a test or the agent acts on.
 */
export function projectTranscript(
  messages: readonly UIMessageLike[],
  options: {
    readonly agentLabel: string;
    readonly status: string;
    readonly draft: string;
    readonly mintId: () => string;
  },
): ProjectedTranscript {
  const index: ProjectedNode[] = [];

  // A leaf node with an optional intent, registered against a parent that is
  // filled in after it is built (parents are constructed after their children).
  const leaf = (
    spec: {
      readonly role: string;
      readonly name?: string;
      readonly text?: string;
      readonly value?: string;
      readonly states?: SemanticNode['states'];
      readonly children?: readonly SemanticNode[];
    },
    intent?: ComposerIntent,
  ): { entry: ProjectedNode; setParent: (parent: ProjectedNode) => void } => {
    const id = options.mintId();
    const node: SemanticNode = {
      ref: { id, revision: '' },
      role: spec.role,
      ...(spec.name === undefined || spec.name === '' ? {} : { name: spec.name }),
      ...(spec.text === undefined || spec.text === '' ? {} : { text: spec.text }),
      ...(spec.value === undefined || spec.value === '' ? {} : { value: spec.value }),
      ...(spec.states === undefined ? {} : { states: spec.states }),
      ...(spec.children === undefined || spec.children.length === 0 ? {} : { children: spec.children }),
    };
    let parentBox: ProjectedNode | undefined;
    const entry: ProjectedNode = {
      id,
      node,
      ...(intent === undefined ? {} : { intent }),
      get parent(): ProjectedNode | undefined {
        return parentBox;
      },
    };
    index.push(entry);
    return { entry, setParent: (parent) => (parentBox = parent) };
  };

  const rootChildren: SemanticNode[] = [];
  const rootDeferred: ((root: ProjectedNode) => void)[] = [];

  for (const message of messages) {
    const partEntries: { entry: ProjectedNode; setParent: (parent: ProjectedNode) => void }[] = [];
    for (const part of message.parts) {
      const toolName = toolNameOf(part);
      if (part.type === 'text' && part.text !== undefined && part.text.trim() !== '') {
        partEntries.push(leaf({ role: 'text', text: part.text.trim() }));
      } else if (toolName !== undefined) {
        const label = `tool ${toolName}`;
        const detail =
          part.state === 'output-error'
            ? `error: ${part.errorText ?? 'unknown'}`
            : part.state === 'output-available'
              ? `→ ${truncate(part.output)}`
              : `(${part.state ?? 'pending'}) ${truncate(part.input)}`;
        const buttons: { entry: ProjectedNode; setParent: (parent: ProjectedNode) => void }[] = [];
        if (part.state === 'approval-requested' && part.approval?.id !== undefined) {
          buttons.push(
            leaf({ role: 'button', name: 'Approve' }, { kind: 'approve', approvalId: part.approval.id, approved: true }),
            leaf({ role: 'button', name: 'Deny' }, { kind: 'approve', approvalId: part.approval.id, approved: false }),
          );
        }
        const toolLeaf = leaf({
          role: 'status',
          name: label,
          text: `${label} ${detail}`,
          children: buttons.map((button) => button.entry.node),
        });
        for (const button of buttons) button.setParent(toolLeaf.entry);
        partEntries.push(toolLeaf);
      }
    }
    const messageLeaf = leaf({ role: message.role, children: partEntries.map((part) => part.entry.node) });
    for (const part of partEntries) part.setParent(messageLeaf.entry);
    rootChildren.push(messageLeaf.entry.node);
    rootDeferred.push((root) => messageLeaf.setParent(root));
  }

  // The composer: the one place a user message is typed. Present only when the
  // turn is not paused on an approval, so the agent's next move is a decision.
  if (pendingApprovals(messages).length === 0) {
    const composer = leaf(
      { role: 'textbox', name: 'Message', value: options.draft, states: { focused: true } },
      { kind: 'send' },
    );
    rootChildren.push(composer.entry.node);
    rootDeferred.push((root) => composer.setParent(root));
  }

  const rootId = options.mintId();
  const rootNode: SemanticNode = {
    ref: { id: rootId, revision: '' },
    role: 'application',
    name: options.agentLabel,
    ...(rootChildren.length === 0 ? {} : { children: rootChildren }),
  };
  const root: ProjectedNode = { id: rootId, node: rootNode };
  index.unshift(root);
  for (const attach of rootDeferred) attach(root);
  return { root: rootNode, index };
}

/** True when `entry` is a strict descendant of `ancestor`. */
export function isWithin(entry: ProjectedNode, ancestor: ProjectedNode): boolean {
  for (let current = entry.parent; current !== undefined; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}
