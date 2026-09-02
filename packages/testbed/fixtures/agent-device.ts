/**
 * agent-device as an RFC0002 integration: one factory returning the typed
 * body (`backend`) and the model vocabulary (`tools`), sharing one client.
 * The backend covers observe + tap/type/scroll; everything beyond the grammar
 * is a slim, hand-schema'd agent tool, so there is no third-party schema to
 * prune and nothing for a model to junk-fill.
 */

import { createAgentDeviceClient } from 'agent-device';
import { defineBackend, type BackendSnapshot } from 'e2e/backend';
import { defineTool, type DefinedTool } from 'e2e/agent';
import { tool } from 'ai';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

type Client = ReturnType<typeof createAgentDeviceClient>;

interface AgentDeviceNode {
  readonly ref?: string;
  readonly type?: string;
  readonly label?: string;
  readonly value?: string;
  readonly identifier?: string;
}

/**
 * The Apple runner defers full snapshots after slow accessibility work and
 * returns a sparse one-node tree; retrying device-side costs under a second,
 * returning it to the model costs a whole confused turn.
 */
async function snapshotWithRetry(client: Client): Promise<readonly AgentDeviceNode[]> {
  for (const backoffMs of [0, 1_200, 3_000]) {
    if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
    let snapshot: { nodes?: readonly AgentDeviceNode[]; snapshotQuality?: { state?: string } };
    try {
      snapshot = (await client.capture.snapshot({ interactiveOnly: true })) as typeof snapshot;
    } catch (cause) {
      // Before the first open there is no app session to observe: an empty
      // screen is the honest answer, and the model's next move is the open
      // tool. Anything else is a real failure.
      if (cause instanceof Error && /active app session/i.test(cause.message)) return [];
      throw cause;
    }
    if (snapshot.snapshotQuality?.state !== 'sparse') return snapshot.nodes ?? [];
  }
  return [];
}

function toBackendSnapshot(nodes: readonly AgentDeviceNode[]): BackendSnapshot {
  return {
    nodes: nodes
      .filter((node) => typeof node.ref === 'string' && node.ref !== '')
      .map((node) => ({
        ref: { id: node.ref as string, revision: '' },
        ...(node.type === undefined ? {} : { role: node.type.toLowerCase() }),
        ...(node.label === undefined ? {} : { name: node.label }),
        ...(node.value === undefined ? {} : { value: node.value }),
        ...(node.identifier === undefined ? {} : { attributes: { 'data-testid': node.identifier } }),
      })),
  };
}

export interface AgentDeviceOptions {
  readonly session: string;
  readonly platform: 'ios' | 'android';
}

/** The RFC0002 integration convention: `{ backend, tools }` from one factory. */
export function agentDevice(options: AgentDeviceOptions): {
  backend: ReturnType<typeof defineBackend>;
  tools: Readonly<Record<string, DefinedTool>>;
} {
  const client = createAgentDeviceClient({ session: options.session });

  const backend = defineBackend({
    name: 'agent-device',
    spiVersion: 1,
    async init() {
      // Boot happens here, once per worker, outside every step budget. The
      // named session is reused; opening an app binds the device claim.
    },
    async dispose() {
      await client.sessions.close().catch(() => undefined);
    },
    async observe() {
      return toBackendSnapshot(await snapshotWithRetry(client));
    },
    actions: {
      async tap(target) {
        // agent-device parses a bare ref as a selector; the @ prefix marks a ref.
        await client.interactions.press({ ref: `@${target.ref.id}` });
      },
      async type(target, value) {
        // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- agent-device fill, not Array#fill
        await client.interactions.fill({ ref: `@${target.ref.id}`, text: value });
      },
      async scroll(direction) {
        await client.interactions.scroll({ direction });
      },
    },
  });

  const tools: Record<string, DefinedTool> = {
    open: defineTool(
      tool({
        description:
          'Open an app by name (e.g. "Reminders", "Settings"), bringing it to the foreground. Set relaunch to restart it fresh.',
        inputSchema: z.object({ app: z.string().min(1), relaunch: z.boolean().optional() }),
        execute: async ({ app, relaunch }) => {
          await client.apps.open({ app, platform: options.platform, ...(relaunch === true ? { relaunch: true } : {}) });
          return `Opened ${app}.`;
        },
      }),
      { replay: 'deterministic', mutates: true, secrets: false },
    ),
    back: defineTool(
      tool({
        description: 'Navigate back once (in-app back).',
        inputSchema: z.object({}),
        execute: async () => {
          await client.command.back({});
          return 'Went back.';
        },
      }),
      { replay: 'deterministic', mutates: true, secrets: false },
    ),
    swipe: defineTool(
      tool({
        description: 'Swipe from one viewport point to another, e.g. to delete a list row (swipe it far left).',
        inputSchema: z.object({
          from: z.object({ x: z.number(), y: z.number() }),
          to: z.object({ x: z.number(), y: z.number() }),
        }),
        execute: async ({ from, to }) => {
          await client.interactions.swipe({ from, to });
          return `Swiped from (${from.x}, ${from.y}) to (${to.x}, ${to.y}).`;
        },
      }),
      { replay: 'none', mutates: true, secrets: false },
    ),
    alert: defineTool(
      tool({
        description: 'Read or dismiss a system alert. Use action "get" to read, "accept" or "dismiss" to act.',
        inputSchema: z.object({ action: z.enum(['get', 'accept', 'dismiss']) }),
        execute: async ({ action }) => {
          const result = await client.command.alert({ action });
          return JSON.stringify(result);
        },
      }),
      { replay: 'none', mutates: true, secrets: false },
    ),
    screenshot: defineTool(
      tool({
        description:
          'Look at the actual screen pixels. Use when the observation tree is sparse or contradicts what you expect.',
        inputSchema: z.object({}),
        execute: async () => {
          const shot = (await client.capture.screenshot({ path: `/tmp/e2e-${options.session}.png` })) as {
            path?: string;
          };
          return { path: shot.path ?? `/tmp/e2e-${options.session}.png` };
        },
        toModelOutput: ({ output }: { output: unknown }) => {
          const shotPath = (output as { path?: string }).path;
          if (shotPath === undefined) return { type: 'text', value: 'screenshot failed' };
          const data = readFileSync(shotPath).toString('base64');
          return {
            type: 'content',
            value: [{ type: 'file', data, mediaType: 'image/png' }],
          };
        },
      } as never) as never,
      { replay: 'none', mutates: false, secrets: false },
    ),
  };

  return { backend, tools };
}
