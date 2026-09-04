/**
 * The conversation backend for e2e (RFC0002): a body that lets the e2e agent
 * talk to another agent. Built with the public `defineBackend`, validated by
 * the same rules and graded by the same capabilities as any other backend.
 * Core imports nothing from here; this package imports the contract from
 * `@e2edev/e2e/backend` and contributes the `conversation` fixture the way the
 * browser backend contributes `web`.
 */

import { createRequire } from 'node:module';
import { defineBackend, type BackendHandle } from '@e2edev/e2e/backend';
import { createConversationFixture } from './conversation.ts';
import { ConversationSurface, type ConversationOptions } from './surface.ts';

const surfaces = new WeakMap<BackendHandle, ConversationSurface>();

/** Assembles the manifest for one surface. Exported for tests that script the transport. */
export function buildBackend(surface: ConversationSurface): BackendHandle {
  const handle = defineBackend({
    name: 'conversation',
    version: ownVersion(),
    spiVersion: 1,
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation) => surface.observe(operation),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    app: {
      restart: (operation) => surface.restart(operation),
    },
    url: (operation) => surface.url(operation),
    fixtures: {
      conversation: (context) => createConversationFixture(surface, context),
    },
  });
  surfaces.set(handle, surface);
  return handle;
}

/**
 * Creates one conversation backend: one session per attempt against the agent
 * under test. Name exactly one of `agent` (an in-process AI SDK agent), `api`
 * (a deployed chat endpoint), or `transport` (a ready-made `ChatTransport`).
 */
export function conversation(options: ConversationOptions): BackendHandle {
  return buildBackend(new ConversationSurface(options));
}

/** The surface behind a handle this package created; undefined for any other backend. */
export function surfaceOf(backend: BackendHandle): ConversationSurface | undefined {
  return surfaces.get(backend);
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
