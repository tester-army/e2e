/**
 * A scripted agent-device client: every nested method call is recorded as
 * `namespace.method` with its first argument and answered by the responder
 * registered under that name (or an empty object). Tests assert on the
 * command stream the engine produced, which is the whole of what the
 * engine owes agent-device.
 */

import type { AgentDeviceClient } from '../../src/options.ts';
import type { RawNode } from '../../src/nodes.ts';

export type Responder = (args: unknown) => unknown;

export interface RecordedCall {
  readonly method: string;
  readonly args: unknown;
}

export interface FakeClient {
  readonly client: AgentDeviceClient;
  readonly calls: RecordedCall[];
  /** Registers or replaces the responder for one `namespace.method`. */
  respond(method: string, responder: Responder): void;
  /** Methods called so far, in order. */
  methods(): string[];
  /** The recorded argument of the last call to one method. */
  lastArgs(method: string): unknown;
}

export function createFakeClient(initial: Readonly<Record<string, Responder>> = {}): FakeClient {
  const responders = new Map<string, Responder>(Object.entries(initial));
  const calls: RecordedCall[] = [];
  const node = (path: readonly string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) => {
        if (typeof property === 'symbol' || property === 'then') return undefined;
        return node([...path, property]);
      },
      apply: (_target, _self, args: unknown[]) => {
        const method = path.join('.');
        calls.push({ method, args: args[0] });
        const responder = responders.get(method);
        return Promise.resolve().then(() => (responder === undefined ? {} : responder(args[0])));
      },
    });
  return {
    client: node([]) as AgentDeviceClient,
    calls,
    respond: (method, responder) => {
      responders.set(method, responder);
    },
    methods: () => calls.map((call) => call.method),
    lastArgs: (method) => calls.findLast((call) => call.method === method)?.args,
  };
}

const rect = (y: number, height = 44): { x: number; y: number; width: number; height: number } => ({
  x: 0,
  y,
  width: 390,
  height,
});

/** An iOS Settings-like screen: app root, a titled navigation bar, a cell, a switch, two fields, a hidden button. */
export const SETTINGS_NODES: readonly RawNode[] = [
  { ref: '@e1', index: 0, depth: 0, type: 'application', label: 'Settings', rect: { x: 0, y: 0, width: 390, height: 844 } },
  { ref: '@e2', index: 1, parentIndex: 0, depth: 1, type: 'navigation-bar', label: 'General', identifier: 'General', rect: rect(47, 44) },
  { ref: '@e3', index: 2, parentIndex: 1, depth: 2, type: 'button', label: 'Back', identifier: 'BackButton', rect: rect(47) },
  { ref: '@e2t', index: 3, parentIndex: 1, depth: 2, type: 'static-text', label: 'General', rect: rect(47) },
  { ref: '@e4', index: 4, parentIndex: 0, depth: 1, type: 'cell', label: 'About', identifier: 'ABOUT', rect: rect(120) },
  { ref: '@e5', index: 5, parentIndex: 4, depth: 2, type: 'static-text', label: 'About', rect: rect(120) },
  { ref: '@e6', index: 6, parentIndex: 0, depth: 1, type: 'switch', label: 'Airplane Mode', value: '0', rect: rect(170) },
  { ref: '@e7', index: 7, parentIndex: 0, depth: 1, type: 'text-field', label: 'Search', value: 'wifi', rect: rect(220) },
  { ref: '@e8', index: 8, parentIndex: 0, depth: 1, type: 'secure-text-field', label: 'Password', value: 'hunter2', rect: rect(270) },
  { ref: '@e9', index: 9, parentIndex: 0, depth: 1, type: 'button', label: 'Hidden', visibleToUser: false, enabled: false, rect: rect(900) },
  { ref: '@e10', index: 10, parentIndex: 0, depth: 1, type: 'cell', label: 'Scroller', rect: rect(320, 400) },
];

export const SETTINGS_SNAPSHOT = {
  nodes: SETTINGS_NODES,
  appName: 'Settings',
  appBundleId: 'com.apple.Preferences',
  truncated: false,
};

/** The package of the app in `ANDROID_ID_SNAPSHOT`. */
export const ANDROID_APP_PACKAGE = 'dev.e2e.examples.maui';

/**
 * An Android screen whose resource ids carry package prefixes, as UIAutomator
 * reports them: the framework's content frame, the app's own views (the way a
 * .NET MAUI AutomationId or a native `android:id` reads), a view another
 * package owns, and one bare id the app set itself (React Native's `testID`).
 */
export const ANDROID_ID_NODES: readonly RawNode[] = [
  { ref: '@e1', index: 0, depth: 0, type: 'android.widget.FrameLayout', identifier: 'android:id/content', rect: { x: 0, y: 0, width: 390, height: 844 } },
  { ref: '@e2', index: 1, parentIndex: 0, depth: 1, type: 'android.view.ViewGroup', identifier: `${ANDROID_APP_PACKAGE}:id/form`, rect: rect(100, 300) },
  { ref: '@e3', index: 2, parentIndex: 1, depth: 2, type: 'android.widget.EditText', identifier: `${ANDROID_APP_PACKAGE}:id/name`, label: 'Ada Lovelace', hintShowing: true, rect: rect(120) },
  { ref: '@e4', index: 3, parentIndex: 1, depth: 2, type: 'android.widget.Button', identifier: `${ANDROID_APP_PACKAGE}:id/greet`, label: 'Greet', rect: rect(180) },
  { ref: '@e5', index: 4, parentIndex: 0, depth: 1, type: 'android.widget.TextView', identifier: 'com.example.other:id/banner', label: 'Elsewhere', rect: rect(420) },
  { ref: '@e6', index: 5, parentIndex: 0, depth: 1, type: 'android.widget.TextView', identifier: 'greeting', label: 'Hello, Ada!', rect: rect(480) },
];

export const ANDROID_ID_SNAPSHOT = {
  nodes: ANDROID_ID_NODES,
  appName: 'with-maui',
  appBundleId: ANDROID_APP_PACKAGE,
  truncated: false,
};
