/**
 * The screen as Jev sees it: the harness's node lines, split into the
 * candidates a choice question can name.
 *
 * The observation text is one node per line, `#id role "name" ...`, already
 * secret-redacted. Jev never generates a node id; it picks one from a map of
 * id to line, so every answer is an element that exists on this screen.
 */

/** One line of the observation that a pointer verb can address. */
export interface Candidate {
  readonly id: string;
  readonly role: string;
  readonly line: string;
}

/**
 * The roles the harness treats as interactive (`INTERACTIVE_ROLES` in
 * e2e/agent/observation.ts). Kept in step by the unit test, not by import:
 * the runner does not export it.
 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
  'listbox',
  'treeitem',
]);

/** Roles that accept typed text. */
const TEXT_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

const LINE = /^\s*#(\S+)(?: (\S+))?(.*)$/;

/** Splits the observation text into the interactive candidates, in document order. */
export function candidatesOf(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const raw of text.split('\n')) {
    const match = LINE.exec(raw);
    if (match === null) continue;
    const [, id, role] = match;
    if (id === undefined || role === undefined || !INTERACTIVE_ROLES.has(role)) continue;
    if (/\[[^\]]*\bdisabled\b[^\]]*\]\s*$/.test(raw)) continue;
    out.push({ id, role, line: raw.trim() });
  }
  return out;
}

/** True for a candidate a `type` action can fill. */
export function acceptsText(candidate: Candidate): boolean {
  return TEXT_ROLES.has(candidate.role);
}

/** True for a candidate that is a password or otherwise secure field. */
export function isSecure(candidate: Candidate): boolean {
  return /value=<secure>|purpose=password/.test(candidate.line);
}

/**
 * The screen with node ids and focus removed: two looks at a screen that has
 * not moved compare equal, so a repeated action can be seen to have done
 * nothing.
 */
export function shapeOf(text: string): string {
  return text
    .replaceAll(/(^|\n)(\s*)#\S+/g, '$1$2')
    .replaceAll(/ \[([^\]]*)\]/g, (_match, states: string) => {
      const stable = states.split(' ').filter((state) => state !== 'focused');
      return stable.length === 0 ? '' : ` [${stable.join(' ')}]`;
    });
}

/** What one action did to the screen: the node lines that appeared and went away. */
export interface ScreenDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

const MAX_DIFF_LINES = 40;

/**
 * The difference between two screen shapes, as node lines. The model holds
 * no memory of the previous screen, so the effect of its last action is
 * spelled out: what a tap made appear, what it made disappear.
 */
export function diffShapes(before: string, after: string): ScreenDiff {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line !== '') map.set(line, (map.get(line) ?? 0) + 1);
    }
    return map;
  };
  const was = count(before);
  const now = count(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [line, n] of now) for (let i = (was.get(line) ?? 0); i < n && added.length < MAX_DIFF_LINES; i++) added.push(line);
  for (const [line, n] of was) for (let i = (now.get(line) ?? 0); i < n && removed.length < MAX_DIFF_LINES; i++) removed.push(line);
  return { added, removed };
}

/** Roles (or the absence of one) that mark a node as a scrollable region a scroll can target. */
const CONTAINER_ROLES: ReadonlySet<string> = new Set(['main', 'region', 'list', 'table', 'grid', 'feed', 'listbox', 'tree', 'group', 'article', 'dialog']);

/**
 * Nodes a scroll can target: landmarks and lists, and role-less nodes the
 * page tagged with a test id (a feed, a scroll container). The page itself is
 * always an option too; the executor adds it.
 */
export function scrollTargetsOf(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const raw of text.split('\n')) {
    const match = LINE.exec(raw);
    if (match === null) continue;
    const [, id, token] = match;
    if (id === undefined || id === 'root') continue;
    const role = token === undefined || token.includes('=') ? '' : token;
    const tagged = role === '' && /(^|\s)testid=/.test(raw);
    if (!CONTAINER_ROLES.has(role) && !tagged) continue;
    out.push({ id, role, line: raw.trim() });
  }
  return out;
}

/** Cuts a candidate list into pages a choice question can hold; Jev takes at most 255 options. */
export function pagesOf<T>(items: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += size) pages.push(items.slice(index, index + size));
  return pages;
}
