/**
 * Writing pinned actions into a test file, the way `toMatchInlineSnapshot`
 * writes a snapshot: the runner finds the `agent.act()` call a step ran
 * from by the line and column its stack named, and replaces the array in
 * the call's `steps` option with the recorded actions, as data. Nothing
 * else in the file moves.
 *
 * Only an array literal is replaced. A `steps` option that is a variable or
 * a spread is the test's own code, and is left alone.
 */

import type { CallExpression, ObjectExpression, ObjectProperty } from 'oxc-parser';
import { oxcParser } from '../config/typescript.ts';

/** One call's new actions, at the position its step's stack named (one-based): JSON values, as a recording holds them. */
export interface InlineEdit {
  readonly line: number;
  readonly column: number;
  readonly steps: readonly object[];
}

/** A call with a `steps: [...]` option, as the rewrite finds it. */
interface StepsCall {
  /** One-based lines the call spans up to its first argument: a stack names one of them. */
  readonly firstLine: number;
  readonly lastLine: number;
  /** Where the called member's name starts, the column a stack names for a method call. */
  readonly calleeColumn: number;
  readonly calleeLine: number;
  /** The array literal's span, replaced whole. */
  readonly start: number;
  readonly end: number;
}

/**
 * Applies the edits to one file's source. Returns the new source and the
 * edits that found no call: no `agent.act()` with a `steps: [...]` option at
 * that position.
 */
export function rewriteInlineSteps(file: string, source: string, edits: readonly InlineEdit[]): { readonly code: string; readonly missed: readonly InlineEdit[] } {
  const { program, errors } = oxcParser().parseSync(file, source, { lang: languageOf(file), sourceType: 'module' });
  if (errors.length > 0) return { code: source, missed: edits };
  const lines = lineStarts(source);
  const calls = stepsCalls(program, lines);
  const missed: InlineEdit[] = [];
  const replacements = new Map<StepsCall, InlineEdit>();
  for (const edit of edits) {
    const call = nearestCall(calls, edit);
    if (call === undefined) missed.push(edit);
    else replacements.set(call, edit);
  }
  let code = source;
  for (const [call, edit] of [...replacements].toSorted(([a], [b]) => b.start - a.start)) {
    const indent = indentAt(source, lines, call.start);
    code = `${code.slice(0, call.start)}${formatSteps(edit.steps, indent)}${code.slice(call.end)}`;
  }
  return { code, missed };
}

/** The call a stack position names: on one of its lines, nearest by the column of the called member. */
function nearestCall(calls: readonly StepsCall[], edit: InlineEdit): StepsCall | undefined {
  const onLine = calls.filter((call) => edit.line >= call.firstLine && edit.line <= call.lastLine);
  const distance = (call: StepsCall) => (call.calleeLine === edit.line ? Math.abs(call.calleeColumn - edit.column) : Number.MAX_SAFE_INTEGER);
  return onLine.toSorted((a, b) => distance(a) - distance(b))[0];
}

function languageOf(file: string): 'ts' | 'tsx' | 'js' | 'jsx' {
  if (file.endsWith('x')) return file.endsWith('.tsx') ? 'tsx' : 'jsx';
  return /\.[cm]?ts$/u.test(file) ? 'ts' : 'js';
}

/** Whether an AST node is a call. */
function isCall(node: object): node is CallExpression {
  return (node as { readonly type?: unknown }).type === 'CallExpression';
}

/** Every call whose second argument is an object with a `steps` property holding an array literal. */
function stepsCalls(root: unknown, lines: readonly number[]): StepsCall[] {
  const found: StepsCall[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    if (isCall(node)) {
      const call = node;
      const options = call.arguments[1];
      const steps = options?.type === 'ObjectExpression' ? stepsProperty(options) : undefined;
      if (steps !== undefined && steps.value.type === 'ArrayExpression') {
        const callee = call.callee.type === 'MemberExpression' ? call.callee.property : call.callee;
        const calleeAt = position(lines, callee.start);
        found.push({
          firstLine: position(lines, call.start).line,
          lastLine: position(lines, call.arguments[0]?.start ?? call.start).line,
          calleeLine: calleeAt.line,
          calleeColumn: calleeAt.column,
          start: steps.value.start,
          end: steps.value.end,
        });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'parent' && typeof value === 'object' && value !== null) visit(value);
    }
  };
  visit(root);
  return found;
}

/** The plain `steps: <value>` property of an options object, if it has one. */
function stepsProperty(options: ObjectExpression): ObjectProperty | undefined {
  for (const property of options.properties) {
    if (property.type !== 'Property' || property.computed || property.shorthand || property.kind !== 'init') continue;
    const key = property.key;
    if ((key.type === 'Identifier' && key.name === 'steps') || (key.type === 'Literal' && key.value === 'steps')) return property;
  }
  return undefined;
}

/** The offset each line starts at. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/** One-based line and column of an offset. */
function position(lines: readonly number[], offset: number): { readonly line: number; readonly column: number } {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lines[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - lines[low]! + 1 };
}

/** The whitespace the line holding `offset` starts with. */
function indentAt(source: string, lines: readonly number[], offset: number): string {
  const start = lines[position(lines, offset).line - 1]!;
  return /^[ \t]*/u.exec(source.slice(start))?.[0] ?? '';
}

/** The array literal: one action per line, indented one level past the line it starts on. */
function formatSteps(steps: readonly object[], indent: string): string {
  if (steps.length === 0) return '[]';
  const step = indent.includes('\t') ? '\t' : '  ';
  return `[\n${steps.map((item) => `${indent}${step}${literal(item)},\n`).join('')}${indent}]`;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** A JSON value as a TypeScript literal: single-quoted strings, unquoted keys where they can be. */
function literal(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return quote(value);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([key, item]) => `${IDENTIFIER.test(key) ? key : quote(key)}: ${literal(item)}`).join(', ')} }`;
}

function quote(text: string): string {
  let out = "'";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === "'" || char === '\\') out += `\\${char}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return `${out}'`;
}
