import { replay } from '../replay.ts';
import { readTraceEntry } from './trace-read.ts';
import type { ActionTrace, TraceEntry } from './trace.ts';

const HEADER = "// e2e replay code-1\nimport { replay } from 'e2e/replay';\n\nexport default replay.define(\n";
const FOOTER = '  ],\n);\n';
/** Code entries have no wall-clock provenance. The adapter supplies this sentinel only in memory. */
const NO_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/** Serializes object keys in a fixed order while preserving every array's semantic order. */
function literal(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

/** Emits code-1 replay syntax without executing source or discarding replay evidence. */
export function emitReplayCode(trace: ActionTrace): string {
  const { actions, ...context } = trace;
  const fields = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `    ${JSON.stringify(key)}: ${literal(value)},\n`);
  const calls = actions.map(({ name, ...input }) => `    replay.${name}(${literal(input)}),\n`);
  return `${HEADER}  {\n${fields.join('')}  },\n  [\n${calls.join('')}${FOOTER}`;
}

/** Reads only the generated replay grammar. Imports, expressions and arbitrary callbacks never execute. */
export function readReplayCode(source: string): TraceEntry | undefined {
  if (!source.startsWith(HEADER) || !source.endsWith(FOOTER)) return undefined;
  const lines = source.slice(HEADER.length, -FOOTER.length).split('\n');
  if (lines.shift() !== '  {') return undefined;
  const contextEnd = lines.indexOf('  },');
  if (contextEnd < 0) return undefined;
  const contextLines = lines.splice(0, contextEnd + 1).slice(0, -1);
  if (lines.shift() !== '  [' || lines.pop() !== '') return undefined;
  try {
    const context: unknown = JSON.parse(`{${contextLines.map((line) => {
      if (!line.startsWith('    ') || !line.endsWith(',')) throw new Error('Invalid context');
      return line.slice(4, -1);
    }).join(',')}}`);
    if (context === null || typeof context !== 'object' || Array.isArray(context) || 'actions' in context) return undefined;
    const actions = lines.map((line) => {
      const match = /^    replay\.([A-Za-z]+)\((.*)\),$/u.exec(line);
      if (match === null || match[1] === 'define' || !Object.hasOwn(replay, match[1]!)) throw new Error('Unknown replay call');
      const input: unknown = JSON.parse(match[2]!);
      if (input === null || typeof input !== 'object' || Array.isArray(input) || 'name' in input) throw new Error('Invalid replay input');
      return { ...input, name: match[1] };
    });
    return readTraceEntry({ schemaVersion: 'trace-1', createdAt: NO_TIMESTAMP, payload: { ...context, actions } });
  } catch {
    return undefined;
  }
}

/** Produces a deterministic unified replacement diff for a regenerated recording. */
export function replayCodeDiff(name: string, before: string, after: string): string {
  if (before === after) return '';
  const oldLines = before === '' ? [] : before.trimEnd().split('\n');
  const newLines = after === '' ? [] : after.trimEnd().split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-suffix - 1) === newLines.at(-suffix - 1)) suffix += 1;
  const lines = [
    ...oldLines.slice(0, prefix).map((line) => ` ${line}`),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((line) => `-${line}`),
    ...newLines.slice(prefix, newLines.length - suffix).map((line) => `+${line}`),
    ...oldLines.slice(oldLines.length - suffix).map((line) => ` ${line}`),
  ];
  return `--- ${before === '' ? '/dev/null' : `a/${name}`}\n+++ ${after === '' ? '/dev/null' : `b/${name}`}\n@@ -${oldLines.length === 0 ? 0 : 1},${oldLines.length} +${newLines.length === 0 ? 0 : 1},${newLines.length} @@\n${lines.join('\n')}\n`;
}
