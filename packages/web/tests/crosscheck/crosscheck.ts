/**
 * Differential check of the engine's semantic tree against Chrome's own
 * accessibility tree on the same live page, read over CDP through the BiDi
 * mapper. Every node the engine's reader reports is tagged in the DOM, then
 * looked up in Chrome's tree; every interactive node Chrome exposes that the
 * engine left out is reported too. A second oracle is the engine's own
 * locate: a role and name read off the tree must locate the element.
 *
 * The result is a list of disagreements keyed without node ids, so a list
 * can be committed as the expected state of a page and diffed on the next
 * run (`expectations.ts`).
 */

import { OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT, type SemanticNode } from 'e2e/engine';
import { readerInstallCall } from '../../src/in-page/readers.ts';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT, CLOSED_SHADOW_ROOTS_KEY } from '../../src/in-page/closed-shadow.ts';
import { readSemanticsFunction } from '../../src/in-page/read-semantics.ts';
import { assembleTree } from '../../src/observation.ts';
import { SECURE_FIELD_SELECTOR, type RawObservedNode } from '../../src/in-page/read-node.ts';
import { openBidiPage, type BidiPage } from '../helpers/bidi-page.ts';

/** One field on which the engine and an oracle read a node differently. */
export interface Disagreement {
  readonly oracle: 'chrome' | 'axe' | 'engine';
  /** `role`, `name`, a state name, `level`, `missing` (Chrome has the node, the engine does not), or `unknown` (the other way). */
  readonly field: string;
  readonly ours: string;
  readonly theirs: string;
  /** `role "name"` as the engine reads it, or as Chrome does for a node the engine left out. */
  readonly node: string;
}

export interface CrossCheckResult {
  /** Engine nodes compared against at least one oracle; zero means the page checked nothing. */
  readonly compared: number;
  readonly disagreements: readonly Disagreement[];
}

/** Engine roles never compared: structure and text the tree keeps for the model, with no ARIA counterpart. */
const STRUCTURAL_ROLES = new Set(['document', 'text', 'generic', 'none', 'presentation']);

/*
 * Deliberate differences. Each is a choice the tree makes for the model, kept
 * here with its reason rather than repeated per page in `expected.txt`, so
 * the file lists only what nobody has decided yet.
 */

/**
 * Roles the tree names from content where accname, Chrome, and Playwright's
 * getByRole leave them unnamed (`ROW_CONTENT_ROLES` in
 * `src/in-page/read-semantics.ts`): a list row or a status message is read
 * by what it says, and located by its text rather than that name.
 */
const ENGINE_NAMED_ROLES = new Set(['listitem', 'status', 'alert']);

/**
 * Roles accname or HTML-AAM names (a row from content, a figure by its
 * figcaption) where Chrome's tree leaves the name empty.
 */
const CHROME_UNNAMED_ROLES = new Set(['row', 'figure']);

/**
 * Chrome's own role names where the vocabulary uses ARIA's, or where ARIA
 * has none: a date or colour input reads as `textbox` to the engine.
 */
const CHROME_ROLES: Readonly<Record<string, readonly string[]>> = {
  image: ['image'],
  iframe: ['Iframe'],
  textbox: ['textbox', 'Date', 'DateTime', 'InputTime', 'ColorWell'],
};

/** Engine roles Chrome may ignore: a row group keeps a table's controls in their section. */
const CHROME_IGNORES = new Set(['rowgroup']);

/**
 * Engine roles with no Chrome counterpart: `box` is a visible empty element
 * the tree lists so a drag or a click has something to aim at.
 */
const ENGINE_ONLY_ROLES = new Set(['box']);

/**
 * An unnamed inline svg: Chrome's tree ignores it or leaves it out, while
 * the tree lists it as an image, so an icon-only control a person sees
 * reaches the model even when nothing names it.
 */
function isUnnamedSvg(node: SemanticNode, facts: ElementFacts): boolean {
  return facts.svgRoot && node.role === 'image' && (node.name ?? '') === '';
}

/** Chrome roles the engine is expected to report whenever Chrome exposes them. */
const INTERACTIVE_CHROME_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'option',
  'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
]);

/**
 * Icon-font glyphs, private-use code points, which the tree drops from a
 * name (`ICON_GLYPHS` in `src/in-page/read-semantics.ts`). Removed from
 * Chrome's name before it is compared.
 */
const ICON_GLYPHS = /\p{Co}/gu;

/** The ARIA states compared, as Chrome's AX property names. */
const STATES = ['checked', 'disabled', 'expanded', 'selected', 'pressed'] as const;

/** The attribute each published element carries its node id in. */
export const MARKER = 'data-e2e-crosscheck';

function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function describe(role: string, name: string): string {
  return `${role} ${JSON.stringify(name)}`;
}

/**
 * Stops the page's clock before any of its scripts runs: `Date` reads the
 * moment the document started and no timer or animation frame ever fires.
 */
const PAUSED_CLOCK_SCRIPT = `
  const start = Date.now();
  const NativeDate = Date;
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length === 0 ? [start] : args)); }
    static now() { return start; }
  };
  let nextTimer = 1;
  const never = () => nextTimer++;
  globalThis.setTimeout = never;
  globalThis.setInterval = never;
  globalThis.requestAnimationFrame = never;
  globalThis.requestIdleCallback = never;
`;

/**
 * A page to cross-check, in a browser of its own: closed shadow roots are
 * recorded at creation, and the clock is paused before any document loads.
 * The engine and the oracle read the live page one after another, so a timer
 * that replaced an element between those reads would compare them on
 * different documents; with the clock stopped, a page reads as its load and
 * its network left it, the same for every reader.
 */
export function openCheckPage(): Promise<BidiPage> {
  return openBidiPage({ preloadScripts: [CLOSED_SHADOW_ROOTS_INIT_SCRIPT, PAUSED_CLOCK_SCRIPT] });
}

/** What the in-page capture hands back: the reader's walk, and where each walked element sits. */
interface TaggedRead {
  readonly nodes: RawObservedNode[];
  readonly ids: string[];
  readonly facts: ElementFacts[];
}

/**
 * Walks the document with the engine's reader, tags each walked element
 * with its node id under `MARKER`, and reads where it sits. Runs in the page.
 */
const TAG_DOCUMENT = `(options, marker) => {
  const observation = (${readSemanticsFunction.toString()})(document.documentElement, options);
  const facts = observation.elements.map((element, index) => {
    element.setAttribute(marker, observation.ids[index]);
    const root = element.getRootNode();
    const view = element.ownerDocument.defaultView;
    return {
      inChildFrame: view !== null && view !== view.top,
      inClosedShadow: root instanceof ShadowRoot && root.mode === 'closed',
      editingHost: element instanceof HTMLElement && element.isContentEditable,
      svgRoot: element instanceof SVGSVGElement,
    };
  });
  return JSON.stringify({ nodes: observation.nodes, ids: observation.ids, facts });
}`;

/** One capture through the engine's own reader, each node's element tagged with its id. */
export async function captureTagged(page: BidiPage): Promise<{
  nodes: SemanticNode[];
  facts: Map<string, ElementFacts>;
}> {
  const options = {
    testIdAttribute: 'data-testid',
    secureFieldSelector: SECURE_FIELD_SELECTOR,
    mode: { kind: 'tree', maxNodes: 5000, idSeed: 1, nameLimit: OBSERVED_NAME_LIMIT, textLimit: OBSERVED_TEXT_LIMIT },
  };
  // oxlint-disable-next-line e2e/no-unchecked-json -- the reader's own output in a page the test wrote
  const read = JSON.parse(String(await page.evaluate(TAG_DOCUMENT, options, MARKER))) as TaggedRead;
  const tree = assembleTree(read.nodes, read.ids, [], new Map());
  return { nodes: flatten(tree), facts: new Map(read.ids.map((id, index) => [id, read.facts[index]!])) };
}

/** Where an element sits, for the policies above and the oracles' reach. */
interface ElementFacts {
  /** The oracle reads no child frame from the top page. */
  readonly inChildFrame: boolean;
  /** Inside a closed root, which the engine records at creation. */
  readonly inClosedShadow: boolean;
  /** An editor's host, which the tree reads as the `textbox` it is. Chrome calls it `generic`. */
  readonly editingHost: boolean;
  /** An inline `<svg>`, which Chrome ignores unless something names it. */
  readonly svgRoot: boolean;
}

/** The fields of CDP's `Accessibility.AXNode` the check reads. */
interface AXNode {
  readonly ignored: boolean;
  readonly role?: { readonly value?: unknown };
  readonly name?: { readonly value?: unknown };
  readonly properties?: readonly { readonly name: string; readonly value: { readonly value?: unknown } }[];
  readonly backendDOMNodeId?: number;
}

/** Chrome's AX node for every tagged element, and the AX nodes whose element carries no tag. */
async function chromeTree(page: BidiPage): Promise<{ byId: Map<string, AXNode>; untagged: AXNode[] }> {
  await page.cdp('DOM.enable');
  await page.cdp('Accessibility.enable');
  const { nodes } = (await page.cdp('Accessibility.getFullAXTree')) as { nodes: readonly AXNode[] };
  const byId = new Map<string, AXNode>();
  const untagged: AXNode[] = [];
  for (const node of nodes) {
    if (node.backendDOMNodeId === undefined) continue;
    const { object } = (await page.cdp('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId })) as { object: { objectId?: string } };
    if (object.objectId === undefined) continue;
    const { result } = (await page.cdp('Runtime.callFunctionOn', {
      objectId: object.objectId,
      // A node inside a form control's own shadow tree (a date input's
      // day field) is the browser's, not the page's: reported as tagged
      // with no id so it never counts as missing.
      functionDeclaration: `function () {
        let node = this;
        while (node !== null && !(node instanceof ShadowRoot)) node = node.parentNode;
        if (node !== null && node.host.matches('input, select, textarea, video, audio')) return '';
        return this.nodeType === 1 ? this.getAttribute(${JSON.stringify(MARKER)}) : null;
      }`,
      returnByValue: true,
    })) as { result: { value?: unknown } };
    if (typeof result.value !== 'string') untagged.push(node);
    else if (result.value !== '') byId.set(result.value, node);
  }
  return { byId, untagged };
}

function property(node: AXNode, name: string): unknown {
  return node.properties?.find((entry) => entry.name === name)?.value.value;
}

/** A state as a comparable string: Chrome reports `true`, `false`, `mixed`, or leaves it out for `false`. */
function chromeState(node: AXNode, state: (typeof STATES)[number]): string {
  const value = property(node, state);
  return value === undefined ? 'false' : String(value);
}

function compareWithChrome(node: SemanticNode, ax: AXNode, facts: ElementFacts, into: Disagreement[]): void {
  const role = node.role!;
  const ours = node.name ?? '';
  const label = describe(role, ours);
  const chromeRole = String(ax.role?.value ?? '');
  if (ENGINE_ONLY_ROLES.has(role) || (role === 'textbox' && facts.editingHost)) return;
  if (ax.ignored) {
    if (!CHROME_IGNORES.has(role)) into.push({ oracle: 'chrome', field: 'role', ours: role, theirs: `ignored (${chromeRole})`, node: label });
    return;
  }
  const accepted = CHROME_ROLES[role] ?? [role];
  if (!accepted.includes(chromeRole)) into.push({ oracle: 'chrome', field: 'role', ours: role, theirs: chromeRole, node: label });
  const theirs = normalize(String(ax.name?.value ?? '').replace(ICON_GLYPHS, ' '));
  const cut = ours.length >= 250 && theirs.startsWith(ours.slice(0, 200));
  const unnamedByChrome = theirs === '' && (ENGINE_NAMED_ROLES.has(role) || CHROME_UNNAMED_ROLES.has(role));
  if (normalize(ours) !== theirs && !cut && !unnamedByChrome) into.push({ oracle: 'chrome', field: 'name', ours, theirs, node: label });
  for (const state of STATES) {
    const chrome = chromeState(ax, state);
    const engine = String(node.states?.[state] === true);
    // The engine has no `mixed`; a mixed control reads as not checked.
    if ((chrome === 'mixed' ? 'false' : chrome) !== engine) into.push({ oracle: 'chrome', field: state, ours: engine, theirs: chrome, node: label });
  }
  const level = property(ax, 'level');
  if (role === 'heading' && level !== undefined && Number(level) !== node.level) {
    into.push({ oracle: 'chrome', field: 'level', ours: String(node.level), theirs: String(level), node: label });
  }
}

/**
 * Locates each `[id, expression]` with the engine's `locate` reader and
 * answers the ids whose tagged element is not among the matches. Runs in
 * the page.
 */
const UNLOCATED = `(checks, options, key, marker) => {
  const locate = ${readerInstallCall('locate')};
  return checks.filter(([id, expression]) => !locate(options, expression, [], false, key)[1].some((element) => element.getAttribute(marker) === id)).map(([id]) => id);
}`;

/**
 * The engine oracle: every named node a role query could name, located by
 * `getByRole(role, { name, exact: true })` with what the tree reads. The
 * roles the tree names from content and Playwright's getByRole leaves
 * unnamed (`ENGINE_NAMED_ROLES`) are left out, as is a name the tree cut.
 */
async function unlocated(page: BidiPage, nodes: readonly SemanticNode[], facts: ReadonlyMap<string, ElementFacts>): Promise<Disagreement[]> {
  const named = nodes.filter((node) => {
    const fact = facts.get(node.ref.id);
    return node.role !== undefined && !STRUCTURAL_ROLES.has(node.role) && !ENGINE_NAMED_ROLES.has(node.role) && !ENGINE_ONLY_ROLES.has(node.role) &&
      (node.name ?? '') !== '' && node.name!.length < OBSERVED_NAME_LIMIT && node.states?.hidden !== true && fact !== undefined && !fact.inChildFrame;
  });
  const checks = named.map((node) => [node.ref.id, JSON.stringify({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: node.role, exact: true }, name: { kind: 'string', value: node.name, exact: true } } })]);
  const options = { testIdAttribute: 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR };
  const missed = new Set(await page.evaluate(UNLOCATED, checks, options, CLOSED_SHADOW_ROOTS_KEY, MARKER) as string[]);
  return named.filter((node) => missed.has(node.ref.id)).map((node) => ({ oracle: 'engine', field: 'getByRole', ours: node.name!, theirs: 'no match', node: describe(node.role!, node.name!) }));
}

/** Cross-checks the page as it is now, on a page from `openCheckPage`; the page keeps the marker attributes afterwards. */
export async function crossCheck(page: BidiPage): Promise<CrossCheckResult> {
  const { nodes, facts } = await captureTagged(page);
  const chrome = await chromeTree(page);
  const disagreements: Disagreement[] = await unlocated(page, nodes, facts);
  let compared = 0;
  for (const node of nodes) {
    const fact = facts.get(node.ref.id);
    if (node.role === undefined || STRUCTURAL_ROLES.has(node.role) || fact === undefined || fact.inChildFrame) continue;
    if (isUnnamedSvg(node, fact)) continue;
    compared += 1;
    const ax = chrome.byId.get(node.ref.id);
    if (ax === undefined) disagreements.push({ oracle: 'chrome', field: 'unknown', ours: node.role, theirs: 'no AX node', node: describe(node.role, node.name ?? '') });
    else compareWithChrome(node, ax, fact, disagreements);
  }
  for (const ax of chrome.untagged) {
    const role = String(ax.role?.value ?? '');
    if (ax.ignored || !INTERACTIVE_CHROME_ROLES.has(role)) continue;
    disagreements.push({ oracle: 'chrome', field: 'missing', ours: 'no node', theirs: role, node: describe(role, normalize(String(ax.name?.value ?? ''))) });
  }
  return { compared, disagreements };
}
