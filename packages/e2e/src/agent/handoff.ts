/**
 * What a step left on screen, for the steps after it (spec 10-determinism.md,
 * ledger). The model's summary is one account of a step; this is the runner's:
 * the text of nodes that were not there when the step began and are there
 * when it ends — a ticket code the app generated, an order line with its
 * total, a confirmation banner. Node ids are stable per element, so "new" is
 * exact, not a text diff.
 */

import type { SemanticNode } from '../backend/surface.ts';
import { sanitizeText } from '../internal/errors.ts';
import type { AgentObservation } from './observation.ts';

/** Most items quoted; the ledger is a hand-off, not a second observation. */
const MAX_APPEARED = 4;
/** Longest quoted item; a long paragraph is prose, not a fact. */
const MAX_ITEM_CHARS = 160;
/** Roles whose text is the app talking to the user: quoted first. */
const ANNOUNCING_ROLES = new Set(['status', 'alert', 'heading', 'dialog', 'alertdialog']);
/** Roles that describe controls, not outcomes. */
const CONTROL_ROLES = new Set(['button', 'link', 'textbox', 'combobox', 'option', 'checkbox', 'radio', 'menuitem', 'tab', 'slider', 'switch', 'searchbox', 'spinbutton']);

/**
 * Texts of nodes present at the end of a step but not at its start, or whose
 * own text changed over the step, best first: announcements (status, alert,
 * heading) before plain text, controls never — a new button is navigation,
 * not an outcome. Text a child already contributes is not repeated by its
 * container.
 */
export function appearedText(
  first: AgentObservation | undefined,
  last: AgentObservation | undefined,
  redact: (text: string) => string,
  options: { navigated?: boolean } = {},
): string[] {
  if (first === undefined || last === undefined || first === last) return [];
  // A new screen is not an outcome of the step: every node "appeared", and
  // the summary already says where the step went. A replaced document shows
  // as a new root; a client-side route change keeps the root, so the caller
  // says when the location moved. Either way only what the app announces
  // (a status or alert) is worth quoting.
  const firstRoot = first.nodes.keys().next().value;
  const lastRoot = last.nodes.keys().next().value;
  const newScreen = firstRoot !== lastRoot || options.navigated === true;
  const announcing: string[] = [];
  const plain: string[] = [];
  const seen = new Set<string>();
  for (const [id, node] of last.nodes) {
    const role = node.role ?? '';
    if (CONTROL_ROLES.has(role)) continue;
    const own = ownText(node);
    if (own === '') continue;
    // New to the screen, or the same node now saying something else: a
    // status line that went from "Generating…" to "Report ready" is the
    // outcome of the step every bit as much as a row that was added.
    const before = first.nodes.get(id);
    if (before !== undefined && ownText(before) === own) continue;
    const text = sanitizeText(redact(own)).replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS);
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    (ANNOUNCING_ROLES.has(role) ? announcing : plain).push(text);
  }
  // Dozens of new nodes are a re-rendered screen, not a result; on a new or
  // re-rendered screen only the announcements are quoted, and briefly.
  if (newScreen || announcing.length + plain.length > MAX_RERENDER_NODES) {
    return announcing.filter((text) => !HEADING_ONLY.test(text)).slice(0, 2);
  }
  const ordered = [...announcing, ...plain];
  if (ordered.length <= MAX_APPEARED) return ordered;
  return [...ordered.slice(0, MAX_APPEARED), `+${String(ordered.length - MAX_APPEARED)} more`];
}

/** Above this many new nodes the step re-rendered its screen rather than producing a fact. */
const MAX_RERENDER_NODES = 12;
/** A bare page title says nothing a later step can reuse. */
const HEADING_ONLY = /^[A-Za-z ]{1,24}$/;

/**
 * The text a node contributes on its own: its text, or its name when the name
 * is not assembled from children that will speak for themselves.
 */
function ownText(node: SemanticNode): string {
  const text = node.text?.trim() ?? '';
  if (text !== '') return text;
  const name = node.name?.trim() ?? '';
  if (name === '' || (node.children?.length ?? 0) > 0) return '';
  return name;
}
