import { readTraceEntry } from '../src/cache/trace-read.ts';
import type { TraceTargetDescriptor } from '../src/cache/trace.ts';

/** Emits a standalone web test for a deliberately narrow, validated trace subset. */
export function emitTest(input: unknown, title: string): string {
  const entry = readTraceEntry(input);
  if (entry === undefined) throw new Error('Invalid trace-1 entry');
  const trace = entry.payload;
  if (trace.truncated || trace.startPath === undefined || trace.endPath !== trace.startPath || !/^\/[a-z/-]*$/u.test(trace.startPath)) {
    throw new Error('Prototype requires a complete flow on one static web path');
  }
  if (JSON.stringify(trace).includes('{{param:') || JSON.stringify(trace).includes('<secret:')) {
    throw new Error('Prototype does not lower parameter or secret placeholders');
  }
  const appeared = trace.endAnchors ?? [];
  const gone = trace.goneAnchors ?? [];
  if (appeared.length === 0) throw new Error('Prototype requires an observable postcondition');
  const statements = [`await app.open(${JSON.stringify(trace.startPath)});`];
  // Require a fresh effect rather than accepting a pre-existing success message.
  for (const anchor of appeared) statements.push(`await expect(${locator(anchor)}).not.toBeVisible();`);
  for (const anchor of gone) statements.push(`await expect(${locator(anchor)}).toBeVisible();`);
  for (const action of trace.actions) {
    if (action.name !== 'tap' && action.name !== 'type') throw new Error(`Unsupported action: ${action.name}`);
    if ('modifiers' in action && action.modifiers !== undefined) throw new Error('Unsupported tap modifiers');
    const target = locator(action.target);
    statements.push(action.name === 'type' ? `await ${target}.fill(${JSON.stringify(action.value)});` : `await ${target}.tap();`);
  }
  for (const anchor of appeared) statements.push(`await expect(${locator(anchor)}).toBeVisible();`);
  for (const anchor of gone) statements.push(`await expect(${locator(anchor)}).not.toBeVisible();`);
  statements.push(`await expect(browser).toHaveURL(${JSON.stringify(trace.endPath)});`);
  return `import { test } from '@e2e-dev/web';\nimport { expect } from 'e2e';\n\ntest(${JSON.stringify(title)}, async ({ app, screen, browser }) => {\n${statements.map((line) => `  ${line}`).join('\n')}\n});\n`;
}

/** Keeps every supported descriptor constraint, rejecting fields that need replay-specific semantics. */
function locator(target: TraceTargetDescriptor): string {
  const unsupported = Object.keys(target).filter((key) => !['role', 'name', 'text'].includes(key));
  if (unsupported.length > 0) throw new Error(`Unsupported descriptor fields: ${unsupported.join(', ')}`);
  if (target.role !== undefined && target.name !== undefined) {
    const base = `screen.getByRole(${JSON.stringify(target.role)}, ${JSON.stringify(target.name)}, { exact: true })`;
    return target.text === undefined ? base : `${base}.filter({ hasText: ${exactPattern(target.text)} })`;
  }
  if (target.role === undefined && target.name === undefined && target.text !== undefined) {
    return `screen.getByText(${JSON.stringify(target.text)}, { exact: true })`;
  }
  throw new Error('Prototype requires role and name, or text alone');
}

/** Emits an anchored literal regex without allowing recorded text to become source code. */
function exactPattern(text: string): string {
  return `new RegExp(${JSON.stringify(`^${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`)})`;
}
