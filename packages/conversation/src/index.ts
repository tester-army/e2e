/**
 * `@e2edev/conversation` public surface: the `conversation()` backend factory,
 * the `conversation` fixture types, and a `test` typed with that fixture.
 * `expect` still comes from `@e2edev/e2e`; the agent-side tool pack lives on
 * the `@e2edev/conversation/tools` subpath so this entry never loads the AI SDK.
 */

import { test as base } from '@e2edev/e2e';
import type { Conversation } from './conversation.ts';

export { conversation } from './backend.ts';
export type { ConversationOptions, ConversationTarget } from './surface.ts';
export type { Conversation } from './conversation.ts';
export type { ToolCall, ToolState, UIMessageLike } from './messages.ts';

/**
 * `test` typed with this backend's contributed `conversation` fixture. The
 * same runtime `test` as `@e2edev/e2e`'s; only the fixture types differ.
 */
export const test = base.extend<{ conversation: Conversation }>();
