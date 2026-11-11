import { Document, LineCounter, Scalar, isAlias, isCollection, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml';
import { canonicalJson } from '../internal/ids.ts';
import { DESCRIPTOR_FIELDS, TRACE_SCHEMA_VERSION, type RecordedAction } from './trace.ts';
import { readTraceEntry } from './trace-read.ts';
import type { ReplayTest, ReplayStep } from './test-file.ts';

const TARGET_FIELDS = new Set<string>([...DESCRIPTOR_FIELDS, 'position', 'states']);
const TARGET_VERBS = new Set(['tap', 'doubleTap', 'longPress', 'secondaryTap', 'hover', 'scrollTo', 'type', 'typeSecret', 'press', 'select', 'check', 'upload', 'drag']);
const DIGEST = /^[a-f0-9]{64}$/u;

/** Reads a mapping without accepting arrays, prototypes or implicit coercion. */
function mapping(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a mapping');
  return value as Record<string, unknown>;
}

/** Rejects metadata typos rather than silently discarding them. */
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown field ${key}`);
}

/** Projects one action into the compact, human-facing YAML vocabulary. */
function actionValue(action: RecordedAction): Record<string, unknown> {
  const { name, summary: _summary, ...input } = action;
  if (name === 'tool') return { tool: { name: action.summary.replace(/^tool /u, ''), ...input } };
  if (name === 'pressKey') return { press: action.key };
  const fields = mapping(orderedData(input));
  if (TARGET_VERBS.has(name) && 'target' in fields) {
    const { target, ...args } = fields;
    const descriptor = mapping(target);
    const targetValue = descriptor['value'];
    const rest = Object.fromEntries([...DESCRIPTOR_FIELDS.filter((key) => key !== 'value'), 'position', 'states'].filter((key) => descriptor[key] !== undefined).map((key) => [key, descriptor[key]]));
    return { [name === 'typeSecret' ? 'type' : name]: { ...rest, ...(targetValue === undefined ? {} : { targetValue }), ...args } };
  }
  return { [name]: fields };
}

/** Restores the exact replay action; display syntax never substitutes weaker runtime behavior. */
function actionFrom(value: unknown, summary: unknown): unknown {
  const row = mapping(value);
  if (Object.keys(row).length !== 1 || typeof summary !== 'string') throw new Error('expected exactly one action verb');
  const [verb, input] = Object.entries(row)[0]!;
  if (verb === 'press' && typeof input === 'string') return { name: 'pressKey', key: input, summary };
  const fields = mapping(input);
  if (verb === 'tool') { const { name: _name, ...gap } = fields; return { ...gap, name: 'tool', summary }; }
  if (!TARGET_VERBS.has(verb)) return { ...fields, name: verb, summary };
  const target: Record<string, unknown> = {};
  const args: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(fields)) {
    if (key === 'targetValue') target['value'] = item;
    else if (TARGET_FIELDS.has(key) && key !== 'value') target[key] = item;
    else args[key] = item;
  }
  return { name: verb === 'type' && 'secret' in fields ? 'typeSecret' : verb, summary, ...args, ...(Object.keys(target).length === 0 ? {} : { target }) };
}

/** Parses bounded core-schema YAML, rejecting aliases, tags and ambiguous object forms before conversion. */
export function readReplayYaml(source: string, filename = '<cache>'): ReplayTest {
  const lines = new LineCounter();
  const fail = (message: string, offset = 0): never => { throw new Error(`${filename}:${lines.linePos(offset).line}: ${message}`); };
  if (Buffer.byteLength(source) > 1_048_576) fail('recording exceeds 1 MiB');
  const doc = (() => {
    try { return parseDocument(source, { schema: 'core', lineCounter: lines, uniqueKeys: true, strict: true }); }
    catch { return fail('invalid YAML or excessive nesting'); }
  })();
  const issue = doc.errors[0] ?? doc.warnings[0];
  if (issue !== undefined) fail(issue.message, issue.pos[0]);
  visit(doc, (_key, node, ancestors) => {
    if (ancestors.length > 64) fail('recording exceeds 64 nesting levels', isNode(node) ? node.range?.[0] : 0);
    if (isAlias(node) || (isNode(node) && (node.tag !== undefined || ('anchor' in node && node.anchor !== undefined)))) fail('tags, anchors and aliases are forbidden', isNode(node) ? node.range?.[0] : 0);
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || ['__proto__', 'prototype', 'constructor', '<<'].includes(pair.key.value)) fail('invalid mapping key', isNode(pair.key) ? pair.key.range?.[0] : 0);
    }
    if (isScalar(node) && typeof node.value === 'number' && !Number.isFinite(node.value)) fail('non-finite numbers are forbidden', node.range?.[0]);
  });
  try {
    const raw = mapping(doc.toJS({ maxAliasCount: 0 }));
    keys(raw, ['test', 'file', 'recordedWith', 'acts', 'identity']);
    if (typeof raw['test'] !== 'string' || typeof raw['file'] !== 'string' || typeof raw['identity'] !== 'object' || !Array.isArray(raw['acts'])) throw new Error('expected test, file, identity and acts');
    const identity = mapping(raw['identity']);
    keys(identity, ['id', 'testId']);
    const { id, testId } = identity;
    if (typeof id !== 'string' || !DIGEST.test(id) || typeof testId !== 'string' || testId.length === 0 || testId.length > 8192 || raw['acts'].length > 4096) throw new Error('invalid test identity or act count');
    const [file, ...titles] = testId.split('::');
    if (raw['file'] !== file || raw['test'] !== titles.map(displayTitle).join(' › ')) throw new Error('test and file must match identity');
    const header = doc.get('recordedWith', true);
    let environment: Record<string, unknown>;
    try {
      environment = mapping(raw['recordedWith']);
      keys(environment, ['engine', 'platform', 'app', 'contextDigest']);
      if (typeof environment['engine'] !== 'number' || !Number.isSafeInteger(environment['engine']) || environment['engine'] < 1
        || typeof environment['platform'] !== 'string' || environment['platform'].length === 0
        || typeof environment['app'] !== 'string' || !DIGEST.test(environment['app'])
        || typeof environment['contextDigest'] !== 'string' || !DIGEST.test(environment['contextDigest'])) {
        throw new Error('expected engine, platform, app and contextDigest');
      }
    } catch (cause) { return fail(`invalid recordedWith: ${(cause as Error).message}`, isNode(header) ? header.range?.[0] : 0); }
    const seen = new Set<string>();
    const steps: ReplayStep[] = raw['acts'].map((item: unknown, index: number) => {
      const location = doc.getIn(['acts', index], true);
      try {
        const act = mapping(item);
        keys(act, ['instruction', 'params', 'steps', 'replay']);
        if (typeof act['instruction'] !== 'string' || act['instruction'].length > 65536 || !Array.isArray(act['steps'])) throw new Error('expected instruction and steps');
        const metadata = mapping(act['replay']);
        keys(metadata, ['key', 'order', 'variant', 'checks', 'summaries', 'instructionUnavailable']);
        const { key, order, variant: variantRaw, checks, summaries } = metadata;
        if (typeof key !== 'string' || !DIGEST.test(key) || typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0) throw new Error('invalid act key or order');
        const variant = mapping(variantRaw);
        keys(variant, ['project', 'target', 'agent']);
        if (!['project','target','agent'].every((name) => typeof variant[name] === 'string' && variant[name].length <= 8192)) throw new Error('invalid variant');
        const rows = act['steps'].map(mapping);
        const waitIndex = rows.findIndex((row) => 'wait' in row || 'waitGone' in row);
        const actionRows = waitIndex < 0 ? rows : rows.slice(0, waitIndex);
        const waits = waitIndex < 0 ? [] : rows.slice(waitIndex);
        const endAnchors: unknown[] = [], goneAnchors: unknown[] = [];
        for (const row of waits) {
          if (Object.keys(row).length !== 1 || (!('wait' in row) && !('waitGone' in row))) throw new Error('outcome waits must follow all actions');
          if ('wait' in row) endAnchors.push(row['wait']); else goneAnchors.push(row['waitGone']);
        }
        if (!Array.isArray(summaries) || summaries.length !== actionRows.length) throw new Error('action summaries must match steps');
        if (metadata['instructionUnavailable'] !== undefined && metadata['instructionUnavailable'] !== true) throw new Error('invalid instruction availability');
        const context = mapping(checks);
        keys(context, ['executor', 'recordedFor', 'recordedBy', 'summary', 'startPath', 'endPath', 'endWaitMs', 'truncated', 'keyedBy']);
        const payload = { ...context, ...(endAnchors.length === 0 ? {} : { endAnchors }), ...(goneAnchors.length === 0 ? {} : { goneAnchors }), ...(metadata['instructionUnavailable'] === true ? {} : { instruction: act['instruction'] }), ...(act['params'] === undefined ? {} : { params: act['params'] }), actions: actionRows.map((action, i) => actionFrom(action, summaries[i])) };
        const entry = readTraceEntry({ schemaVersion: TRACE_SCHEMA_VERSION, createdAt: '1970-01-01T00:00:00.000Z', payload });
        if (entry === undefined || canonicalJson(entry.payload) !== canonicalJson(payload)) throw new Error('invalid replay action or verification metadata');
        if (entry.payload.keyedBy === undefined) throw new Error('replay checks must include keyedBy validity metadata');
        if (canonicalJson(entry.payload.actions.map(actionValue)) !== canonicalJson(actionRows)) throw new Error('unknown action fields or verb');
        const actIdentity = canonicalJson([variant, key]);
        if (seen.has(actIdentity)) throw new Error('duplicate act key');
        seen.add(actIdentity);
        if (entry.payload.recordedFor !== undefined && entry.payload.recordedFor.testId !== testId) throw new Error('act belongs to another test');
        return { key, order, variant: { project: variant['project'] as string, target: variant['target'] as string, agent: variant['agent'] as string }, trace: entry.payload };
      } catch (cause) { return fail((cause as Error).message, isNode(location) ? location.range?.[0] : 0); }
    });
    if (canonicalJson(environment) !== canonicalJson(recordedWith(steps))) return fail('recordedWith must match replay validity metadata', isNode(header) ? header.range?.[0] : 0);
    return { id, testId, steps };
  } catch (cause) {
    if ((cause as Error).message.startsWith(filename + ':')) throw cause;
    return fail((cause as Error).message);
  }
}

/** Emits deterministic YAML with flow-style actions and blank lines between act calls. */
export function emitReplayYaml(recording: ReplayTest): string {
  const [file, ...titles] = recording.testId.split('::');
  const ordered = recording.steps.toSorted((a, b) => canonicalJson(a.variant).localeCompare(canonicalJson(b.variant)) || a.order - b.order || a.key.localeCompare(b.key));
  const acts = ordered.map(({ key, order, variant, trace }) => {
    const { actions, instruction, params, endAnchors, goneAnchors, ...checks } = trace;
    return { instruction: instruction ?? '(instruction unavailable)', ...(params === undefined ? {} : { params: orderedData(params) }), steps: [...actions.map(actionValue), ...(endAnchors ?? []).map((target) => ({ wait: descriptorValue(target) })), ...(goneAnchors ?? []).map((target) => ({ waitGone: descriptorValue(target) }))], replay: { key, order, variant: orderedData(variant), ...(instruction === undefined ? { instructionUnavailable: true } : {}), checks: orderedData(checks), summaries: actions.map((action) => action.summary) } };
  });
  const doc = new Document({ test: titles.map(displayTitle).join(' › '), file, recordedWith: recordedWith(ordered), acts, identity: { id: recording.id, testId: recording.testId } }, { schema: 'core', aliasDuplicateObjects: false });
  visit(doc, (_key, node) => {
    if (isScalar(node) && typeof node.value === 'string' && /^(?:(?:y|n|yes|no|on|off|true|false|null|~)$|[-+.]?\d)|[\r\n\u2028\u2029]/iu.test(node.value)) node.type = Scalar.QUOTE_DOUBLE;
  });
  if (isMap(doc.contents)) {
    const key = doc.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === 'acts')?.key;
    if (isScalar(key)) key.spaceBefore = true;
  }
  const actNodes = doc.get('acts', true);
  if (isSeq(actNodes)) for (const [index, act] of actNodes.items.entries()) {
    if (!isMap(act)) continue;
    if (index > 0) act.spaceBefore = true;
    const actions = act.get('steps', true);
    if (isSeq(actions)) for (const action of actions.items) {
      if (isMap(action)) for (const pair of action.items) if (isCollection(pair.value) && (!isScalar(pair.key) || pair.key.value !== 'tool')) pair.value.flow = true;
    }
  }
  return doc.toString({ lineWidth: 0 });
}

/** Gives the first variant's environment a readable header; every variant retains its own validity. */
function recordedWith(steps: readonly ReplayStep[]): Record<string, unknown> {
  const first = steps[0]?.trace.keyedBy;
  if (first === undefined) throw new Error('recordedWith requires replay keyedBy validity metadata');
  return { engine: first.engineSpiVersion, platform: first.platform, app: first.appIdentity, contextDigest: first.agentContextDigest };
}

/** Refuses a lossy encoding before the store publishes any bytes. */
export function encodeReplayYaml(recording: ReplayTest): string {
  const source = emitReplayYaml(recording);
  const normalized = readReplayYaml(source);
  const expected = { ...recording, steps: recording.steps.toSorted((a, b) => canonicalJson(a.variant).localeCompare(canonicalJson(b.variant)) || a.order - b.order || a.key.localeCompare(b.key)) };
  if (canonicalJson(normalized) !== canonicalJson(expected)) throw new Error('YAML recording failed round-trip validation');
  return source;
}

/** Sorts nested data keys without assigning a type to unvalidated parsed data. */
function orderedData(value: unknown): unknown { return JSON.parse(canonicalJson(value)); }

/** Provenance may end mid-percent-escape after the recorder caps a long title. */
function displayTitle(title: string): string {
  try { return decodeURIComponent(title); } catch { return title; }
}

/** Uses the same readable field order for outcome targets regardless of object insertion order. */
function descriptorValue(value: unknown): Record<string, unknown> {
  const descriptor = mapping(orderedData(value));
  return Object.fromEntries([...DESCRIPTOR_FIELDS, 'position', 'states'].filter((key) => descriptor[key] !== undefined).map((key) => [key, descriptor[key]]));
}
