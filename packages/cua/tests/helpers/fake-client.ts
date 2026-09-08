/**
 * A scripted Cua Driver client: every tool call is recorded with its
 * arguments and answered by the responder registered under the tool's name
 * (or a plain success). Tests assert on the call stream the engine produced,
 * which is the whole of what the engine owes Cua Driver.
 */

import type { DriverClient, DriverToolResult } from '../../src/client.ts';
import type { RawElement, RawWindowState } from '../../src/nodes.ts';

export type Responder = (args: Readonly<Record<string, unknown>>) => DriverToolResult | Partial<DriverToolResult>;

export interface RecordedCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface FakeClient {
  readonly client: DriverClient;
  readonly calls: RecordedCall[];
  shutdowns: number;
  /** Registers or replaces the responder for one tool. */
  respond(name: string, responder: Responder): void;
  /** Tools called so far, in order. */
  names(): string[];
  /** The recorded arguments of the last call to one tool. */
  lastArgs(name: string): Readonly<Record<string, unknown>> | undefined;
}

/** A successful result carrying `structured` as its structured content. */
export function ok(structured?: unknown, extra: Partial<DriverToolResult> = {}): DriverToolResult {
  return {
    text: 'ok',
    images: [],
    isError: false,
    degraded: false,
    ...(structured === undefined ? {} : { structuredJson: JSON.stringify(structured) }),
    ...extra,
  };
}

/** An error result with Cua Driver's error code. */
export function failure(errorCode: string, text = errorCode): DriverToolResult {
  return { text, images: [], isError: true, errorCode, degraded: false };
}

/** An action result whose outcome record reports `effect`. */
export function acted(effect: string): DriverToolResult {
  return ok({ action: { effect } }, { action: { effect } });
}

export function createFakeClient(initial: Readonly<Record<string, Responder>> = {}): FakeClient {
  const responders = new Map<string, Responder>(Object.entries({ ...DEFAULT_RESPONDERS, ...initial }));
  const calls: RecordedCall[] = [];
  const fake: FakeClient = {
    calls,
    shutdowns: 0,
    client: {
      async call(name, args) {
        calls.push({ name, args });
        const responder = responders.get(name);
        const result = responder === undefined ? ok() : responder(args);
        return { ...ok(), ...result };
      },
      async shutdown() {
        fake.shutdowns += 1;
      },
    },
    respond: (name, responder) => {
      responders.set(name, responder);
    },
    names: () => calls.map((call) => call.name),
    lastArgs: (name) => calls.findLast((call) => call.name === name)?.args,
  };
  return fake;
}

export const PID = 4242;
export const WINDOW_ID = 7;
export const WINDOW = { window_id: WINDOW_ID, pid: PID, title: 'Untitled', app_name: 'TextEdit', is_on_screen: true, bounds: { x: 100, y: 50, width: 600, height: 400 } };

const px = (x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } => ({ x, y, w, h });

/** A TextEdit-like window at 2x: a toolbar with a button and a font pop-up, a text area, a secure field, a checkbox, static text, a hidden button, a radio, a search field. */
const ELEMENTS: readonly RawElement[] = [
  { element_index: 0, element_token: 's1:0', role: 'AXWindow', label: 'Untitled', depth: 0, frame: px(0, 0, 1200, 800), actions: ['AXRaise'] },
  { element_index: 1, element_token: 's1:1', role: 'AXToolbar', label: 'Toolbar', parent_index: 0, depth: 1, frame: px(0, 0, 1200, 60) },
  { element_index: 2, element_token: 's1:2', role: 'AXButton', label: 'Bold', identifier: 'bold', parent_index: 1, depth: 2, frame: px(20, 10, 60, 40), actions: ['AXPress'] },
  { element_index: 3, element_token: 's1:3', role: 'AXPopUpButton', label: 'Font', value: 'Helvetica', parent_index: 1, depth: 2, frame: px(100, 10, 200, 40), actions: ['AXPress', 'AXShowMenu'] },
  { element_index: 4, element_token: 's1:4', role: 'AXTextArea', label: 'Document', value: 'Hello', parent_index: 0, depth: 1, frame: px(0, 60, 1200, 640), focused: true },
  { element_index: 5, element_token: 's1:5', role: 'AXSecureTextField', label: 'Password', value: 'hunter2', parent_index: 0, depth: 1, frame: px(20, 720, 300, 40) },
  { element_index: 6, element_token: 's1:6', role: 'AXCheckBox', label: 'Wrap', value: 1, parent_index: 0, depth: 1, frame: px(400, 720, 100, 40), actions: ['AXPress'] },
  { element_index: 7, element_token: 's1:7', role: 'AXStaticText', label: 'Ready', parent_index: 0, depth: 1, frame: px(600, 720, 100, 40) },
  { element_index: 8, element_token: 's1:8', role: 'AXButton', label: 'Hidden', enabled: false, parent_index: 0, depth: 1, frame: px(0, 0, 0, 0) },
  { element_index: 9, element_token: 's1:9', role: 'AXRadioButton', label: 'Plain', value: 0, parent_index: 0, depth: 1, frame: px(800, 720, 100, 40), actions: ['AXPress'] },
  { element_index: 10, element_token: 's1:10', role: 'AXTextField', label: 'Search', value: '', parent_index: 0, depth: 1, frame: px(1000, 720, 180, 40) },
];

export const WINDOW_STATE: RawWindowState = {
  snapshot_id: 's1',
  window_bounds: { x: 100, y: 50, width: 600, height: 400 },
  screenshot_scale: 2,
  screenshot_width: 1200,
  screenshot_height: 800,
  elements: ELEMENTS,
};

const DEFAULT_RESPONDERS: Readonly<Record<string, Responder>> = {
  check_permissions: () => ok({ accessibility: true, screen_recording: true }),
  launch_app: () => ok({ pid: PID, bundle_id: 'com.apple.TextEdit', name: 'TextEdit', windows: [WINDOW], launch_state: 'window_ready' }),
  list_windows: () => ok({ windows: [WINDOW] }),
  get_window_state: () => ok(WINDOW_STATE),
  kill_app: () => ok({ terminated: true }),
  click: () => acted('confirmed'),
  double_click: () => acted('confirmed'),
  set_value: () => acted('confirmed'),
  press_key: () => acted('unverifiable'),
  hotkey: () => acted('unverifiable'),
  scroll: () => acted('confirmed'),
  drag: () => acted('confirmed'),
  move_cursor: () => acted('confirmed'),
  invoke_menu: () => acted('confirmed'),
};
