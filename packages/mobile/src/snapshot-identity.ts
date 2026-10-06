import type { CaptureSnapshotResult } from 'agent-device';
import type { SemanticNode } from 'e2e/engine';
import { isWithin, projectSnapshot, type ProjectedNode, type ProjectedSnapshot } from './nodes.ts';

/** Current capture facts, never the app remembered from an earlier launch. */
export type IdentityCapture = Partial<Pick<CaptureSnapshotResult, 'nodes' | 'appBundleId' | 'refsGeneration' | 'truncated' | 'snapshotQuality'>>;

const LAYOUT_ROLES = new Set(['group', 'other', 'scroll-view', 'scroll-area', 'view', 'frame-layout']);
const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'switch', 'radio', 'slider', 'spinbutton', 'tab', 'menuitem', ...INPUT_ROLES]);
const ROW_ROLES = new Set(['listitem', 'row']);
const COLLECTION_ROLES = new Set(['list', 'table', 'grid', 'collection-view']);

/** A display value can change without moving the controls around it to a new identity. */
function readout(entry: ProjectedNode): boolean {
  return entry.node.testId !== undefined && ['text', 'status', 'progressbar', 'timer'].includes(entry.node.role ?? '');
}

/** App namespace supplied by this capture, or by its own unanimous non-system node packages. */
function appOf(raw: IdentityCapture): string | undefined {
  const packages = new Set((raw.nodes ?? []).map((node) => node.bundleId).filter((id) => id !== undefined && id !== 'com.android.systemui'));
  if (packages.size === 1) return packages.values().next().value;
  return raw.appBundleId || undefined;
}

/** Context facts are computed once; row data and inherited readouts do not require whole-tree scans per node. */
function contexts(index: readonly ProjectedNode[]): {
  rows: ReadonlyMap<ProjectedNode, string>;
  echoes: ReadonlyMap<ProjectedNode, string>;
} {
  const texts = new Map<ProjectedNode, (readonly (string | undefined)[])[]>();
  const echoes = new Map<ProjectedNode, string>();
  for (const entry of index) {
    if (entry.node.states?.secure === true || INPUT_ROLES.has(entry.node.role ?? '')) continue;
    for (let parent = entry.parent; parent !== undefined; parent = parent.parent) {
      if (INTERACTIVE_ROLES.has(parent.node.role ?? '') || parent.node.states?.secure === true) break;
      if (readout(entry) && (entry.node.name === parent.node.name || entry.node.text === parent.node.name) && entry.node.testId !== undefined) echoes.set(parent, entry.node.testId);
      if ((ROW_ROLES.has(parent.node.role ?? '') || COLLECTION_ROLES.has(parent.parent?.node.role ?? '')) && ['text', 'heading'].includes(entry.node.role ?? '')) {
        const values = texts.get(parent) ?? [];
        values.push([entry.node.role, entry.node.name, entry.node.text]);
        texts.set(parent, values);
      }
    }
  }
  const rows = new Map([...texts].map(([entry, values]) => [entry, JSON.stringify(values.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))]));
  return { rows, echoes };
}

/** Native title evidence is independent of the reporting helper's back-button title. */
function screenOf(index: readonly ProjectedNode[]): string {
  const bar = index.find((entry) => entry.kind === 'navigation-bar');
  if (bar !== undefined) {
    const title = index.find((entry) => entry.node.role === 'text' && isWithin(entry, bar));
    return title?.node.name ?? title?.node.text ?? bar.node.testId ?? bar.node.name ?? '';
  }
  const up = index.find((entry) => entry.node.role === 'button' && ['Navigate up', 'Navigate back'].includes(entry.node.name ?? ''));
  if (up?.parent !== undefined) {
    const title = index.find((entry) => entry.parent === up.parent && entry.node.role === 'text');
    if (title !== undefined) return title.node.name ?? title.node.text ?? '';
  }
  return JSON.stringify(index.filter((entry) => ['heading', 'dialog', 'alert'].includes(entry.node.role ?? '') && entry.node.name !== undefined)
    .map((entry) => [entry.node.role, entry.node.name]));
}

/** Meaningful labels remain identity even when an app reuses the test id. */
function keyOf(entry: ProjectedNode, context: ReturnType<typeof contexts>): string {
  const node = entry.node;
  const layout = LAYOUT_ROLES.has(node.role ?? '');
  const row = ROW_ROLES.has(node.role ?? '') || COLLECTION_ROLES.has(entry.parent?.node.role ?? '');
  const echo = layout ? context.echoes.get(entry) : undefined;
  const name = INPUT_ROLES.has(node.role ?? '') && (node.name === entry.raw.value || node.name === node.attributes?.['placeholder']) ? undefined : node.name;
  return JSON.stringify([
    row ? 'row' : layout ? 'layout' : node.role,
    node.testId,
    readout(entry) ? undefined : echo === undefined ? name : ['readout', echo],
    INPUT_ROLES.has(node.role ?? '') ? node.attributes?.['placeholder'] : undefined,
    node.inputPurpose,
    row ? context.rows.get(entry) ?? '[]' : undefined,
  ]);
}

/** Unnamed layout wrappers do not make an extra backend layer a new control. */
function transparent(entry: ProjectedNode): boolean {
  return LAYOUT_ROLES.has(entry.node.role ?? '') && entry.node.testId === undefined && entry.node.name === undefined;
}

/** The nearest meaningful ancestor defines the matching namespace. */
function ownerOf(entry: ProjectedNode): ProjectedNode | undefined {
  let parent = entry.parent;
  while (parent !== undefined && transparent(parent)) parent = parent.parent;
  return parent;
}

/** Pins dense native refs to the capture that issued them, rather than a later positional frame. */
function nativeRef(ref: string, generation: number | undefined): string {
  if (ref === '' || generation === undefined) return ref;
  return `${ref.replace(/~s\d+$/, '')}~s${generation}`;
}

/**
 * Reconciles normalized semantic nodes within a current app/screen scope.
 * Only mutual unique matches survive; ambiguous identity never uses geometry.
 * The latest complete frame remains a comparison baseline across sparse captures,
 * while every returned action binding belongs to the current capture only.
 */
export class SnapshotIdentity {
  private previous: { app: string; screen: string; snapshot: ProjectedSnapshot } | undefined;

  constructor(private readonly mintId: () => string) {}

  /** A launch, close or reset replaces the native surface even when its labels are identical. */
  reset(): void {
    this.previous = undefined;
  }

  /** Normalizes once, reconciles identity, and returns one coherent tree and action index. */
  project(raw: IdentityCapture): ProjectedSnapshot {
    let provisional = 0;
    const next = projectSnapshot(raw.nodes ?? [], { mintId: () => `temporary${++provisional}` });
    const app = appOf(raw);
    const screen = screenOf(next.index);
    const before = this.previous;
    const prior = before !== undefined && app !== undefined && before.app === app && before.screen === screen ? before.snapshot.index : [];
    const priorContext = contexts(prior);
    const nextContext = contexts(next.index);
    const priorGroups = new Map<string | undefined, Map<string, ProjectedNode[]>>();
    for (const entry of prior) {
      const owner = ownerOf(entry)?.id;
      let group = priorGroups.get(owner);
      if (group === undefined) priorGroups.set(owner, (group = new Map()));
      const key = keyOf(entry, priorContext);
      const candidates = group.get(key);
      if (candidates === undefined) group.set(key, [entry]);
      else candidates.push(entry);
    }
    const counts = new Map<ProjectedNode | undefined, Map<string, number>>();
    const keys = new Map<ProjectedNode, string>();
    for (const entry of next.index) {
      const owner = ownerOf(entry);
      let group = counts.get(owner);
      if (group === undefined) counts.set(owner, (group = new Map()));
      const key = keyOf(entry, nextContext);
      keys.set(entry, key);
      group.set(key, (group.get(key) ?? 0) + 1);
    }
    const ids = new Map<ProjectedNode, string>();
    for (const entry of next.index) {
      const owner = ownerOf(entry);
      const key = keys.get(entry)!;
      const candidates = priorGroups.get(owner === undefined ? undefined : ids.get(owner))?.get(key);
      const unique = candidates?.length === 1 && counts.get(owner)?.get(key) === 1;
      ids.set(entry, (unique ? candidates?.[0]?.id : undefined) ?? this.mintId());
    }
    const entries = new Map<ProjectedNode, ProjectedNode>();
    const nodes = new Map<SemanticNode, SemanticNode>();
    const index: ProjectedNode[] = [];
    for (const entry of next.index) {
      const id = ids.get(entry)!;
      const parent = entry.parent === undefined ? undefined : entries.get(entry.parent);
      const projected: ProjectedNode = {
        id, ref: nativeRef(entry.ref, raw.refsGeneration), kind: entry.kind, raw: entry.raw, parent,
        get node() { return nodes.get(entry.node)!; },
      };
      entries.set(entry, projected);
      index.push(projected);
    }
    for (let position = next.index.length - 1; position >= 0; position -= 1) {
      const entry = next.index[position]!;
      const { children, ...fields } = entry.node;
      nodes.set(entry.node, {
        ...fields, ref: { id: ids.get(entry)!, revision: '' },
        ...(children === undefined ? {} : { children: children.map((child) => nodes.get(child)!) }),
      });
    }
    const snapshot: ProjectedSnapshot = { roots: next.roots.map((node) => nodes.get(node)!), index, viewport: next.viewport };
    if (app === undefined) this.previous = undefined;
    else if (raw.truncated !== true && raw.snapshotQuality?.state !== 'sparse') this.previous = { app, screen, snapshot };
    else if (before !== undefined && (before.app !== app || before.screen !== screen)) this.previous = undefined;
    return snapshot;
  }
}
