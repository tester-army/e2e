/**
 * Differential check of the engine's semantic tree against two oracles on
 * the same live page: Chrome's own accessibility tree over CDP, and
 * Playwright's `getByRole` resolution. Every node the engine reports is
 * tagged in the DOM, then looked up in both; every interactive node Chrome
 * exposes that the engine left out is reported too.
 *
 * The result is a list of disagreements keyed without node ids, so a list
 * can be committed as the expected state of a page and diffed on the next
 * run (`expectations.ts`).
 */

import type { ElementHandle, Page } from 'playwright';
import type { SemanticNode } from 'e2e/engine';
import { captureDocument } from '../../src/observation.ts';

/** One field on which the engine and an oracle read a node differently. */
export interface Disagreement {
  readonly oracle: 'chrome' | 'playwright' | 'axe';
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

/** The vocabulary spells a few ARIA roles its own way. */
const ARIA_ROLE: Readonly<Record<string, string>> = { image: 'img' };

/*
 * Deliberate differences. Each is a choice the tree makes for the model, kept
 * here with its reason rather than repeated per page in `expected.txt`, so
 * the file lists only what nobody has decided yet.
 */

/**
 * Roles the tree names from content where accname, Chrome, and Playwright
 * leave them unnamed (`NAME_FROM_CONTENT_ROLES` in `src/in-page/read-semantics.ts`):
 * a list row or a status message is read by what it says.
 */
const ENGINE_NAMED_ROLES = new Set(['listitem', 'status', 'alert']);

/**
 * Roles accname or HTML-AAM names (a row from content, a figure by its
 * figcaption) where Chrome's tree leaves the name empty. Playwright agrees
 * with the engine on these.
 */
const CHROME_UNNAMED_ROLES = new Set(['row', 'figure']);

/**
 * Chrome's own role names where the vocabulary uses ARIA's, or where ARIA
 * has none: a date or colour input reads as `textbox` to the engine and to
 * Playwright.
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
 * Playwright reads it as `img` and its aria snapshot lists it. The tree
 * lists it as Playwright does, so an icon-only control a person sees reaches
 * the model even when nothing names it.
 */
function isUnnamedSvg(node: SemanticNode, facts: ElementFacts): boolean {
  return facts.svgRoot && node.role === 'image' && (node.name ?? '') === '';
}

/** Engine roles ARIA does not define, so `getByRole` cannot be asked for them. */
const NON_ARIA_ROLES = new Set(['box', 'iframe']);

/** Chrome roles the engine is expected to report whenever Chrome exposes them. */
const INTERACTIVE_CHROME_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'option',
  'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
]);

/**
 * Icon-font glyphs, private-use code points, which the tree drops from a
 * name (`ICON_GLYPHS` in `src/in-page/read-semantics.ts`) and the engine's
 * role locator tolerates (`glyphTolerantName` in `src/locators.ts`). Removed
 * from Chrome's name before it is compared, and allowed around the words of
 * the name `getByRole` is asked for.
 */
const ICON_GLYPHS = /\p{Co}/gu;

/** A name as `getByRole` is asked for it: exact, with icon-font glyphs allowed wherever it has a space or begins or ends. */
function glyphTolerant(name: string): RegExp {
  const words = normalize(name).split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  return new RegExp(`^[\\s\\p{Co}]*${words.join('[\\s\\p{Co}]+')}[\\s\\p{Co}]*$`, 'u');
}

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

/** One capture through the engine's own reader, with the element behind each node id. */
export async function captureTagged(page: Page): Promise<{
  nodes: SemanticNode[];
  elements: Map<string, ElementHandle<Element>>;
  facts: Map<string, ElementFacts>;
}> {
  let nextId = 1;
  const elements = new Map<string, ElementHandle<Element>>();
  const { tree } = await captureDocument(
    {
      testIdAttribute: 'data-testid',
      site: undefined,
      reserveIds: (count) => {
        const first = nextId;
        nextId += count;
        return first;
      },
      commit: (id, element) => {
        elements.set(id, element);
      },
    },
    page,
    { framePath: [], budget: 5000, deadline: Date.now() + 30_000, signal: new AbortController().signal },
  );
  const facts = new Map<string, ElementFacts>();
  for (const [id, element] of elements) {
    facts.set(id, await element.evaluate((el, [attribute, value]) => {
      el.setAttribute(attribute!, value!);
      const root = el.getRootNode();
      const view = el.ownerDocument.defaultView;
      return {
        inChildFrame: view !== null && view !== view.top,
        inClosedShadow: root instanceof ShadowRoot && root.mode === 'closed',
        editingHost: el instanceof HTMLElement && el.isContentEditable,
        svgRoot: el instanceof SVGSVGElement,
      };
    }, [MARKER, id]));
  }
  return { nodes: flatten(tree), elements, facts };
}

/** Where an element sits, for the policies above and the oracles' reach. */
interface ElementFacts {
  /** Neither oracle reads a child frame from the top page. */
  readonly inChildFrame: boolean;
  /** Playwright cannot pierce a closed root; the engine records them at creation. */
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
async function chromeTree(page: Page): Promise<{ byId: Map<string, AXNode>; untagged: AXNode[] }> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const byId = new Map<string, AXNode>();
    const untagged: AXNode[] = [];
    for (const node of nodes as readonly AXNode[]) {
      if (node.backendDOMNodeId === undefined) continue;
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
      if (object.objectId === undefined) continue;
      const { result } = await cdp.send('Runtime.callFunctionOn', {
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
      });
      if (typeof result.value !== 'string') untagged.push(node);
      else if (result.value !== '') byId.set(result.value, node);
    }
    return { byId, untagged };
  } finally {
    await cdp.detach();
  }
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

/** Whether `getByRole(role, { name, exact })` finds the engine's element among its matches. */
async function compareWithPlaywright(page: Page, node: SemanticNode, into: Disagreement[]): Promise<void> {
  const name = node.name ?? '';
  const role = ARIA_ROLE[node.role!] ?? node.role!;
  const label = describe(node.role!, name);
  try {
    const found = await page
      // `includeHidden` also changes how Playwright computes names, so it is
      // set only for a node the tree itself reports hidden.
      .getByRole(role as Parameters<Page['getByRole']>[0], { name: glyphTolerant(name), includeHidden: node.states?.hidden === true })
      .evaluateAll((elements, [attribute, id]) => elements.some((element) => element.getAttribute(attribute!) === id), [MARKER, node.ref.id]);
    if (!found) into.push({ oracle: 'playwright', field: 'getByRole', ours: 'match', theirs: 'no match', node: label });
  } catch (error) {
    into.push({ oracle: 'playwright', field: 'getByRole', ours: 'match', theirs: `error: ${(error as Error).message.split('\n')[0]}`, node: label });
  }
}

/** Cross-checks the page as it is now; the page keeps the marker attributes afterwards. */
export async function crossCheck(page: Page): Promise<CrossCheckResult> {
  const { nodes, elements, facts } = await captureTagged(page);
  try {
    const chrome = await chromeTree(page);
    const disagreements: Disagreement[] = [];
    let compared = 0;
    for (const node of nodes) {
      const fact = facts.get(node.ref.id);
      if (node.role === undefined || STRUCTURAL_ROLES.has(node.role) || fact === undefined || fact.inChildFrame) continue;
      compared += 1;
      if (isUnnamedSvg(node, fact)) continue;
      const ax = chrome.byId.get(node.ref.id);
      if (ax === undefined) disagreements.push({ oracle: 'chrome', field: 'unknown', ours: node.role, theirs: 'no AX node', node: describe(node.role, node.name ?? '') });
      else compareWithChrome(node, ax, fact, disagreements);
      const playwrightReads = !fact.inClosedShadow && !ENGINE_NAMED_ROLES.has(node.role) && !NON_ARIA_ROLES.has(node.role) &&
        !(node.role === 'textbox' && fact.editingHost);
      if (node.name !== undefined && node.name !== '' && playwrightReads) await compareWithPlaywright(page, node, disagreements);
    }
    for (const ax of chrome.untagged) {
      const role = String(ax.role?.value ?? '');
      if (ax.ignored || !INTERACTIVE_CHROME_ROLES.has(role)) continue;
      disagreements.push({ oracle: 'chrome', field: 'missing', ours: 'no node', theirs: role, node: describe(role, normalize(String(ax.name?.value ?? ''))) });
    }
    return { compared, disagreements };
  } finally {
    await Promise.all([...elements.values()].map((element) => element.dispose()));
  }
}
