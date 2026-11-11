import { canonicalJson, sha256Hex } from '../internal/ids.ts';
import type { ReplayTest, ReplayStep } from './test-file.ts';
import type { ActionTrace, TraceEntry } from './trace.ts';
import { TRACE_SCHEMA_VERSION } from './trace.ts';
import { readTraceEntry } from './trace-read.ts';
import { parseReplaySource } from './code-parse.ts';

/** Emits formatted replay declarations, preserving the order of actions and outcome evidence. */
export function emitReplayCode(trace: ActionTrace): string {
  const { actions, ...context } = trace;
  const pretty = (value: unknown, depth: number) => JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)
    .replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029')
    .replace(/\n/gu, `\n${' '.repeat(depth)}`);
  const calls = actions.map(({ name, ...input }) => `    replay.${name}(${pretty(input, 4)}),`).join('\n');
  return `// e2e replay code-1\nimport { replay } from 'e2e/replay';\n\nexport default replay.define(\n  ${pretty(context, 2)},\n  [\n${calls}\n  ],\n);\n`;
}

/** Parses declarations as data. The legacy adapter date is never serialized into code. */
export function readReplayCode(source: string): TraceEntry {
  const payload = parseReplaySource(source);
  const entry = readTraceEntry({ schemaVersion: TRACE_SCHEMA_VERSION, createdAt: '1970-01-01T00:00:00.000Z', payload });
  if (entry === undefined) throw new Error('replay payload does not satisfy trace-1');
  return entry;
}

/** Names an entry consistently in stores, diagnostics and trace pages. */
export function cacheFileName(testId: string): string {
  return `${sha256Hex(testId)}.replay.ts`;
}

/** Recognizes only digest-named replay declarations, never legacy JSON or sidecars. */
export function cacheFileKey(name: string): string | undefined {
  return /^([a-f0-9]{64})\.replay\.ts$/u.exec(name)?.[1];
}

/** Validates the complete test container and every step using the replay contract. */
export function readTestReplayCode(source: string): ReplayTest {
  const raw = parseReplaySource(source) as Partial<ReplayTest> | null;
  if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.id) || typeof raw.testId !== 'string' || raw.testId.length === 0 || raw.testId.length > 8192 || !Array.isArray(raw.steps) || raw.steps.length > 4096) throw new Error('invalid replay test');
  const seen = new Set<string>();
  const steps: ReplayStep[] = raw.steps.map((step: ReplayStep) => {
    if (step === null || typeof step !== 'object' || typeof step.key !== 'string' || !/^[a-f0-9]{64}$/u.test(step.key) || !Number.isSafeInteger(step.order) || step.order < 0 || step.variant === null || typeof step.variant !== 'object') throw new Error('invalid replay step');
    const { project, target, agent } = step.variant;
    if (![project, target, agent].every((part) => typeof part === 'string' && part.length <= 8192)) throw new Error('invalid replay variant');
    const variant = { project, target, agent };
    const identity = canonicalJson([variant, step.key]);
    if (seen.has(identity)) throw new Error('duplicate replay step');
    seen.add(identity);
    const entry = readTraceEntry({ schemaVersion: TRACE_SCHEMA_VERSION, createdAt: '1970-01-01T00:00:00.000Z', payload: step.trace });
    if (entry === undefined || (entry.payload.recordedFor !== undefined && entry.payload.recordedFor.testId !== raw.testId)) throw new Error('invalid replay step trace');
    return { key: step.key, variant, order: step.order, trace: entry.payload };
  });
  return { id: raw.id, testId: raw.testId, steps };
}

/** Emits a deterministic test file, grouped by variant and ordered by executed act calls. */
export function emitTestReplayCode(recording: ReplayTest): string {
  const sorted = recording.steps.toSorted((a, b) => {
    const left = canonicalJson(a.variant), right = canonicalJson(b.variant);
    return (left < right ? -1 : left > right ? 1 : 0) || a.order - b.order || a.key.localeCompare(b.key);
  });
  const steps = sorted.map(({ trace, ...metadata }) => {
    const source = emitReplayCode(trace);
    const declaration = source.slice(source.indexOf('export default ') + 'export default '.length).trim().replace(/;$/u, '');
    return `  replay.step(\n    ${JSON.stringify(JSON.parse(canonicalJson(metadata)), null, 2).replace(/\n/gu, '\n    ')},\n    ${declaration.replace(/\n/gu, '\n    ')}\n  ),`;
  }).join('\n');
  const source = `// e2e replay test-1\nimport { replay } from 'e2e/replay';\n\nexport default replay.test(\n  ${JSON.stringify({ id: recording.id, testId: recording.testId })},\n  [\n${steps}\n  ],\n);\n`.replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
  return source;
}

/** Checks serialization against validated replay semantics before any file is published. */
export function encodeTestReplayCode(recording: ReplayTest): string {
  const normalized = readTestReplayCode(emitTestReplayCode(recording));
  const source = emitTestReplayCode(normalized);
  if (canonicalJson(readTestReplayCode(source)) !== canonicalJson(normalized)) throw new Error('test recording failed round-trip validation');
  return source;
}
