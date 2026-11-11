import { canonicalJson } from '../internal/ids.ts';
import type { ActionTrace, TraceEntry } from './trace.ts';
import { buildTraceEntry, TRACE_SCHEMA_VERSION } from './trace.ts';
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

/** Validates a recording and its emitted round trip before the store publishes it. */
export function encodeReplayCode(payload: ActionTrace): string {
  const expected = readTraceEntry(buildTraceEntry(payload));
  if (expected === undefined) throw new Error('cannot encode an invalid recording');
  const source = emitReplayCode(expected.payload);
  if (canonicalJson(readReplayCode(source).payload) !== canonicalJson(expected.payload)) throw new Error('code recording failed round-trip validation');
  return source;
}

/** Names an entry consistently in stores, diagnostics and trace pages. */
export function cacheFileName(keyHash: string): string {
  return `${keyHash}.replay.ts`;
}

/** Recognizes only digest-named replay declarations, never legacy JSON or sidecars. */
export function cacheFileKey(name: string): string | undefined {
  return /^([a-f0-9]{64})\.replay\.ts$/u.exec(name)?.[1];
}
