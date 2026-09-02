/**
 * agent-device as an RFC0002 backend: the typed, model-free body of an iOS
 * target. It contributes
 *
 * - observation (accessibility snapshot) and the tap/type/scroll grammar, so
 *   `agent.act` and the judgment tier run over the simulator;
 * - a contributed `device` fixture — deterministic device management the
 *   harness records and bounds like any other step: network, permissions,
 *   location, appearance, home. This is the primitive that must NOT live in
 *   core: it is defined here, on the backend, and core never learns it.
 *
 * Everything a model plans through beyond the grammar (swipe, alerts,
 * screenshots) is an agent-side tool in `agentDeviceTools`.
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
 * Deterministic device management exposed to tests as `device`. Not an agent
 * tool — no model plans these; a test calls them directly to arrange or assert
 * device state, and the harness records each as a `device.<method>` step.
 */
export interface Device {
  /** Toggles the simulator's network condition. */
  setNetwork(state: 'online' | 'offline'): Promise<void>;
  /** Grants, denies, or resets one app permission. Requires an app open. */
  setPermission(
    permission: 'camera' | 'location' | 'notifications' | 'contacts' | 'photos',
    state: 'grant' | 'deny' | 'reset',
  ): Promise<void>;
  /** Sets the simulator's location. */
  setLocation(coordinates: { latitude: number; longitude: number }): Promise<void>;
  /** Sets the system appearance. */
  setAppearance(mode: 'light' | 'dark'): Promise<void>;
  /** Sends the device to its home screen. */
  home(): Promise<void>;
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
      // screen is the honest answer, and the model's next move is the open tool.
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

/** The RFC0002 integration convention: one factory, `{ backend, tools }`. */
export function agentDevice(options: AgentDeviceOptions): {
  backend: ReturnType<typeof defineBackend>;
  tools: Readonly<Record<string, DefinedTool>>;
} {
  const client = createAgentDeviceClient({ session: options.session });

  const PERMISSION_MAP = {
    camera: 'camera',
    location: 'location',
    notifications: 'notifications',
    contacts: 'contacts',
    photos: 'photos',
  } as const;

  const backend = defineBackend({
    name: 'agent-device',
    spiVersion: 1,
    async init() {
      // Boot the simulator once per worker, outside every step budget, so
      // device-global commands (network, appearance, location) work from the
      // first step. App-scoped commands still need an app opened first.
      await client.devices.boot({ platform: options.platform });
    },
    async dispose() {
      await client.sessions.close().catch(() => undefined);
    },
    async observe() {
      return toBackendSnapshot(await snapshotWithRetry(client));
    },
    actions: {
      async tap(target) {
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
    fixtures: {
      // Returns a Device (see the interface); the object literal also
      // structurally satisfies the contract's fixture-factory record type.
      device: () => ({
        async setNetwork(state: 'online' | 'offline') {
          await client.settings.update({ setting: 'wifi', state: state === 'offline' ? 'off' : 'on' });
        },
        async setPermission(
          permission: 'camera' | 'location' | 'notifications' | 'contacts' | 'photos',
          state: 'grant' | 'deny' | 'reset',
        ) {
          await client.settings.update({ setting: 'permission', permission: PERMISSION_MAP[permission], state });
        },
        async setLocation({ latitude, longitude }: { latitude: number; longitude: number }) {
          await client.settings.update({ setting: 'location', state: 'set', latitude, longitude });
        },
        async setAppearance(mode: 'light' | 'dark') {
          await client.settings.update({ setting: 'appearance', state: mode });
        },
        async home() {
          await client.command.home({});
        },
      }),
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
          return { type: 'content', value: [{ type: 'file', data, mediaType: 'image/png' }] };
        },
      } as never) as never,
      { replay: 'none', mutates: false, secrets: false },
    ),
  };

  return { backend, tools };
}
