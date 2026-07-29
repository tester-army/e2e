/**
 * An in-memory agent-device daemon.
 *
 * It lets the real `e2e/agent-device` driver run against the real runner with
 * no simulator: the driver still builds every request and parses every
 * response, so projection, resolution, actionability, and lifecycle are
 * exercised for real. Only the device is fake.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentDeviceTransport } from '../../src/agent-device/client.ts';
import { buildSnapshot, type NodeSpec } from './mobile-snapshot.ts';

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

export interface FakeDaemonOptions {
  /** Screen returned by `snapshot`, re-read on every capture. */
  screen?: () => readonly NodeSpec[];
  /** Devices returned by `devices`. */
  devices?: readonly {
    id: string;
    name: string;
    kind: 'simulator' | 'emulator' | 'device';
    booted?: boolean;
  }[];
  /** Fails the named command once, then succeeds. */
  failOnce?: Readonly<Record<string, { code: string; message: string }>>;
  /** Fails the named command every time. */
  failAlways?: Readonly<Record<string, { code: string; message: string }>>;
  /** Screenshot pixel geometry reported back to the driver. */
  screenshot?: { width: number; height: number; logicalWidth: number; logicalHeight: number };
}

export interface FakeDaemon {
  readonly transport: AgentDeviceTransport;
  readonly calls: readonly DaemonCall[];
  /** Commands seen, in order, for concise assertions. */
  commands(): readonly string[];
  /** Replaces the screen the next snapshot returns. */
  setScreen(screen: readonly NodeSpec[]): void;
  /** Bumps the ref-frame epoch, which makes outstanding refs stale. */
  bumpRefsGeneration(): void;
}

const DEFAULT_SCREENSHOT = {
  width: 750,
  height: 1334,
  logicalWidth: 375,
  logicalHeight: 667,
} as const;

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

export function createFakeDaemon(options: FakeDaemonOptions = {}): FakeDaemon {
  const calls: DaemonCall[] = [];
  const failedOnce = new Set<string>();
  let screen: readonly NodeSpec[] = options.screen?.() ?? [
    { type: 'XCUIElementTypeButton', label: 'Continue', rect: { x: 0, y: 0, width: 100, height: 40 } },
  ];
  let refsGeneration = 1;
  const geometry = options.screenshot ?? DEFAULT_SCREENSHOT;

  const devices = options.devices ?? [
    { id: 'SIM-1', name: 'iPhone 16', kind: 'simulator' as const, booted: true },
  ];

  const transport: AgentDeviceTransport = (request) => {
    const command = request.command;
    const positionals = request.positionals ?? [];
    const flags = (request.flags ?? {}) as Record<string, unknown>;
    calls.push({ command, positionals, flags });

    const always = options.failAlways?.[command];
    if (always !== undefined) {
      return Promise.resolve({ ok: false as const, error: { ...always } });
    }
    const once = options.failOnce?.[command];
    if (once !== undefined && !failedOnce.has(command)) {
      failedOnce.add(command);
      return Promise.resolve({ ok: false as const, error: { ...once } });
    }

    switch (command) {
      case 'devices':
        return ok({
          devices: devices.map((device) => ({
            platform: 'ios',
            target: 'mobile',
            kind: device.kind,
            id: device.id,
            name: device.name,
            booted: device.booted ?? false,
            identifiers: { udid: device.id },
            ios: { udid: device.id },
          })),
        });
      case 'snapshot': {
        const snapshot = buildSnapshot(options.screen?.() ?? screen, { refsGeneration });
        return ok({ ...snapshot, appName: 'Example' });
      }
      case 'screenshot': {
        const target = positionals[0];
        if (target !== undefined) {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, PNG_BYTES);
        }
        return ok({
          path: target,
          width: geometry.width,
          height: geometry.height,
          logicalWidth: geometry.logicalWidth,
          logicalHeight: geometry.logicalHeight,
          pixelDensity: geometry.width / geometry.logicalWidth,
        });
      }
      case 'open':
        return ok({ session: 'fake', appName: 'Example', appBundleId: 'com.example.app' });
      case 'install':
        return ok({
          app: 'com.example.app',
          bundleId: 'com.example.app',
          appPath: positionals[0] ?? '',
          platform: 'ios',
          identifiers: { appBundleId: 'com.example.app' },
        });
      case 'close':
        return ok({ session: 'fake' });
      default:
        // Every mutating command invalidates outstanding refs, exactly as a
        // real UI change would.
        if (MUTATORS.has(command)) refsGeneration += 1;
        return ok({ message: `${command} ok` });
    }
  };

  return {
    transport,
    calls,
    commands: () => calls.map((call) => call.command),
    setScreen: (next) => {
      screen = next;
      refsGeneration += 1;
    },
    bumpRefsGeneration: () => {
      refsGeneration += 1;
    },
  };
}

function ok(data: Record<string, unknown>) {
  return Promise.resolve({ ok: true as const, data });
}
