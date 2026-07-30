/**
 * Minimal in-memory agent-device daemon for runner-level mobile tests.
 *
 * Mobile integration tests here assert on the runner's behaviour — target
 * gating, fixtures, artifacts, and `report-1` provenance — through the real
 * `@e2edev/agent-device` driver, so they need a device that answers, not a
 * device that can be provoked. The driver's own suites own the exhaustive
 * daemon (failure injection, ref-frame invalidation, session reclamation) and
 * live beside the driver.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentDeviceTransport } from '@e2edev/agent-device';

/**
 * One recorded daemon call. The typed client serializes options into
 * `positionals` and `flags`, so assertions read the same wire shape a real
 * daemon receives.
 */
export interface DaemonCall {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, unknown>>;
}

/** A node in the screen a test declares, nested the way a view hierarchy is. */
export interface NodeSpec {
  readonly type?: string;
  readonly label?: string;
  readonly value?: string;
  readonly identifier?: string;
  readonly rect?: { x: number; y: number; width: number; height: number };
  readonly children?: readonly NodeSpec[];
}

export interface FakeDaemonOptions {
  /** Screen returned by `snapshot`, re-read on every capture. */
  screen?: () => readonly NodeSpec[];
  /**
   * Points the content moves per scroll gesture. With it set, the daemon models
   * a scrollable screen: geometry shifts so a node below the fold can actually
   * be reached, which is what a scrolling loop needs in order to terminate.
   */
  scrollStep?: number;
}

export interface FakeDaemon {
  readonly transport: AgentDeviceTransport;
  readonly calls: readonly DaemonCall[];
  /** Commands seen, in order, for concise assertions. */
  commands(): readonly string[];
  /** How far the content has scrolled, in points. */
  scrollOffset(): number;
}

/** iPhone-sized screen in points, matching a real iOS snapshot root rect. */
const SCREEN_RECT = { x: 0, y: 0, width: 402, height: 874 } as const;

const SCREENSHOT = { width: 750, height: 1334, logicalWidth: 375, logicalHeight: 667 } as const;

/** Commands that move a scrollable screen's content. */
const SCROLLERS: ReadonlySet<string> = new Set(['scroll', 'swipe', 'gesture']);

/** Commands that change the UI, and therefore invalidate outstanding refs. */
const MUTATORS: ReadonlySet<string> = new Set([
  'click',
  'press',
  'longpress',
  'fill',
  'type',
  'scroll',
  'gesture',
  'swipe',
  'back',
  'home',
  'focus',
]);

/** A minimal PNG so artifact reads observe real bytes on disk. */
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

/**
 * Flattens a nested screen into the backend's flat `index`/`parentIndex` wire
 * shape, so the driver performs the same projection it performs on a device.
 */
function buildSnapshot(
  roots: readonly NodeSpec[],
  refsGeneration: number,
  scrollOffset: number,
): Record<string, unknown> {
  const nodes: Record<string, unknown>[] = [];
  let next = 1;

  const walk = (
    spec: NodeSpec,
    parentIndex: number | undefined,
    depth: number,
    parentRect: { x: number; y: number; width: number; height: number },
  ): void => {
    const index = next++;
    // The root is the device screen and does not move; its content does.
    const own = spec.rect ?? parentRect;
    const rect =
      parentIndex === undefined ? own : { ...own, y: own.y - scrollOffset };
    nodes.push({
      index,
      ref: `@e${index}`,
      depth,
      rect,
      ...(parentIndex !== undefined ? { parentIndex } : {}),
      ...(spec.type !== undefined ? { type: spec.type } : {}),
      ...(spec.label !== undefined ? { label: spec.label } : {}),
      ...(spec.value !== undefined ? { value: spec.value } : {}),
      ...(spec.identifier !== undefined ? { identifier: spec.identifier } : {}),
    });
    for (const child of spec.children ?? []) walk(child, index, depth + 1, rect);
  };

  for (const root of roots) walk(root, undefined, 0, { ...SCREEN_RECT });
  return { nodes, truncated: false, identifiers: {}, refsGeneration };
}

export function createFakeDaemon(options: FakeDaemonOptions = {}): FakeDaemon {
  const calls: DaemonCall[] = [];
  const fallbackScreen: readonly NodeSpec[] = [
    {
      type: 'XCUIElementTypeButton',
      label: 'Continue',
      rect: { x: 0, y: 0, width: 100, height: 40 },
    },
  ];
  let refsGeneration = 1;
  let scrolled = 0;

  const transport: AgentDeviceTransport = (request) => {
    const command = request.command;
    const positionals = request.positionals ?? [];
    const flags = (request.flags ?? {}) as Record<string, unknown>;
    calls.push({ command, positionals, flags });

    switch (command) {
      case 'devices':
        return ok({
          devices: [
            {
              platform: 'ios',
              target: 'mobile',
              kind: 'simulator',
              id: 'SIM-1',
              name: 'iPhone 16',
              booted: true,
              identifiers: { udid: 'SIM-1' },
              ios: { udid: 'SIM-1' },
            },
          ],
        });
      case 'snapshot':
        return ok({
          ...buildSnapshot(options.screen?.() ?? fallbackScreen, refsGeneration, scrolled),
          appName: 'Example',
        });
      case 'screenshot': {
        const target = positionals[0];
        if (target !== undefined) {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, PNG_BYTES);
        }
        return ok({
          path: target,
          ...SCREENSHOT,
          pixelDensity: SCREENSHOT.width / SCREENSHOT.logicalWidth,
        });
      }
      case 'open':
        // A launch replaces the running instance, so the screen is back at the
        // top. Without this a scrolled test would leak its position into the
        // next one, which is exactly the state a fixture must not carry.
        scrolled = 0;
        refsGeneration += 1;
        return ok({ session: 'fake', appName: 'Example', appBundleId: 'com.example.app' });
      case 'close':
        return ok({ session: 'fake' });
      case 'session_list':
        return ok({ sessions: [] });
      default:
        // Every mutating command invalidates outstanding refs, exactly as a
        // real UI change would.
        if (MUTATORS.has(command)) refsGeneration += 1;
        if (options.scrollStep !== undefined && SCROLLERS.has(command)) {
          scrolled += options.scrollStep;
        }
        return ok({ message: `${command} ok` });
    }
  };

  return {
    transport,
    calls,
    commands: () => calls.map((call) => call.command),
    scrollOffset: () => scrolled,
  };
}

function ok(data: Record<string, unknown>) {
  return Promise.resolve({ ok: true as const, data });
}
