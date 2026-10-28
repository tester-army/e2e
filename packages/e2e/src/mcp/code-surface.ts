/**
 * What `run_code` may call, by receiver: the queries, actions, reads, and
 * matchers of the public test API (`types.ts`), each with the number of
 * arguments it takes. The table is closed and typed against the public
 * interfaces, in both directions: a name it does not list is refused while the
 * code is parsed, so the runner only ever reaches a fixture member by a name
 * listed here, and a public member it neither lists nor leaves out fails to
 * compile.
 * Fixtures an engine contributes are not in it: core names none of their
 * members.
 */

import type { App, AsyncExpectation, Locator, Screen } from '../types.ts';

/** Something a statement can call members on. */
export type Receiver = 'screen' | 'locator' | 'app' | 'locator-expectation';

/** How many arguments a call takes: the fewest and the most. */
export type Arity = readonly [min: number, max: number];

/**
 * One member: a query that leads to a locator, or a call that ends the
 * statement: an action, a read whose value the result shows, or a matcher.
 */
export type Member =
  | { readonly kind: 'query'; readonly args: Arity }
  | { readonly kind: 'action'; readonly args: Arity; readonly secretValue?: true }
  | { readonly kind: 'read'; readonly args: Arity }
  | { readonly kind: 'matcher'; readonly args: Arity };

const query = (min: number, max: number): Member => ({ kind: 'query', args: [min, max] });
const action = (min: number, max: number): Member => ({ kind: 'action', args: [min, max] });
const read = (min: number, max: number): Member => ({ kind: 'read', args: [min, max] });
const matcher = (min: number, max: number): Member => ({ kind: 'matcher', args: [min, max] });

/** Public members `run_code` leaves out on purpose; `LEFT_OUT` says why for each. */
type LeftOutName = 'debug' | 'all' | 'setInputFiles' | 'screenshot' | 'toHaveScreenshot' | 'startRecording' | 'stopRecording';

/** Public members that are not calls: `expect(...).not` the grammar reads itself, `app.baseUrl` a statement has no use for. */
type NotCalled = 'not' | 'baseUrl';

/**
 * A receiver's table: every public member of `T` listed, unless it is left out
 * on purpose or not a call, and no name `T` lacks. A member the API gains then
 * fails to compile here until it is listed or left out with a reason.
 */
type Covers<T> = { readonly [K in Exclude<keyof T & string, LeftOutName | NotCalled>]: Member } & {
  readonly [K in keyof T & string]?: Member;
};

function members(entries: Readonly<Record<string, Member | undefined>>): ReadonlyMap<string, Member> {
  return new Map(Object.entries(entries).filter((entry): entry is [string, Member] => entry[1] !== undefined));
}

const QUERIES = {
  getByRole: query(1, 3),
  getByLabel: query(1, 2),
  getByPlaceholder: query(1, 2),
  getByText: query(1, 2),
  getByDisplayValue: query(1, 2),
  getByTestId: query(1, 2),
} as const satisfies { readonly [K in keyof Screen]?: Member };

const SCREEN_ACTIONS = {
  tapAt: action(1, 2),
  swipe: action(1, 1),
  scrollUntilVisible: action(1, 2),
} as const satisfies { readonly [K in keyof Screen]?: Member };

const SCREEN = members({ ...QUERIES, ...SCREEN_ACTIONS, tree: read(0, 1) } satisfies Covers<Screen>);

const LOCATOR = members({
  ...QUERIES,
  ...SCREEN_ACTIONS,
  filter: query(1, 1),
  or: query(1, 1),
  first: query(0, 0),
  last: query(0, 0),
  nth: query(1, 1),
  tap: action(0, 1),
  click: action(0, 1),
  doubleTap: action(0, 1),
  dblclick: action(0, 1),
  secondaryTap: action(0, 1),
  longPress: action(0, 1),
  fill: { kind: 'action', args: [1, 2], secretValue: true },
  pressSequentially: action(1, 2),
  clear: action(0, 1),
  press: action(1, 2),
  check: action(0, 1),
  uncheck: action(0, 1),
  selectOption: action(1, 2),
  focus: action(0, 1),
  hover: action(0, 1),
  dragTo: action(1, 2),
  scrollIntoView: action(0, 1),
  waitFor: action(0, 1),
  textContent: read(0, 0),
  inputValue: read(0, 0),
  getAttribute: read(1, 1),
  isVisible: read(0, 0),
  isHidden: read(0, 0),
  isEnabled: read(0, 0),
  isDisabled: read(0, 0),
  isChecked: read(0, 0),
  boundingBox: read(0, 0),
  count: read(0, 0),
  allTextContents: read(0, 0),
} satisfies Covers<Locator>);

const APP = members({
  open: action(0, 1),
  restart: action(0, 0),
  clearState: action(0, 0),
  back: action(0, 0),
} satisfies Covers<App>);

const LOCATOR_MATCHERS = members({
  toBeVisible: matcher(0, 1),
  toBeHidden: matcher(0, 1),
  toBeAttached: matcher(0, 1),
  toBeEnabled: matcher(0, 1),
  toBeDisabled: matcher(0, 1),
  toBeChecked: matcher(0, 1),
  toBeSelected: matcher(0, 1),
  toBeExpanded: matcher(0, 1),
  toBeFocused: matcher(0, 1),
  toHaveText: matcher(1, 2),
  toContainText: matcher(1, 2),
  toHaveValue: matcher(1, 2),
  toHaveAttribute: matcher(1, 3),
  toHaveCount: matcher(1, 2),
  toHaveAccessibleName: matcher(1, 2),
} satisfies Covers<AsyncExpectation>);

/** Every receiver's members. */
export const SURFACE: Readonly<Record<Receiver, ReadonlyMap<string, Member>>> = {
  screen: SCREEN,
  locator: LOCATOR,
  app: APP,
  'locator-expectation': LOCATOR_MATCHERS,
};

/** A receiver as a message names it. */
export const RECEIVER_LABELS: Readonly<Record<Receiver, string>> = {
  screen: 'screen',
  locator: 'a locator',
  app: 'app',
  'locator-expectation': 'expect(locator)',
};

/**
 * Public members `run_code` leaves out on purpose, with why. Each would
 * print where nobody reads, read files, write pixels the session withholds,
 * or need a test file.
 */
export const LEFT_OUT: ReadonlyMap<string, string> = new Map(
  Object.entries({
    debug: "prints to the server's own output; read the screen with screen.tree() or the observe tool",
    all: 'returns locators, not a result; use count() or nth(i)',
    setInputFiles: 'reads files from disk; attach files with the upload tool, which checks the paths',
    screenshot: 'writes an unmasked screenshot file; use the screenshot tool, which withholds pixels after a secret fill',
    toHaveScreenshot: 'compares against screenshots kept beside a test file, so it runs only in a test; look with the screenshot tool',
    startRecording: 'records into a test attempt; use the start_recording tool',
    stopRecording: 'records into a test attempt; use the stop_recording tool',
  } satisfies Record<LeftOutName, string>),
);
