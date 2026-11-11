import { canonicalJson } from '../internal/ids.ts';
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
