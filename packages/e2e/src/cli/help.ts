/**
 * The pieces every command's help text is built from.
 */

import picocolors from 'picocolors';
import { DOCS_URL } from './docs-url.ts';

/**
 * Help text always carries color; commander strips it when the stream it
 * writes to has none (not a TTY, `NO_COLOR`), so the decision is made once,
 * per stream, by the writer.
 */
export const pc = picocolors.createColors(true);

/** A titled block indented like commander's own help sections. */
export function helpSection(title: string, lines: readonly string[]): string {
  return [pc.bold(title), ...lines.map((line) => `  ${line}`)].join('\n');
}

/** The `Examples:` block of a command's help, one shell line each. */
export function examples(commands: readonly string[]): string {
  return helpSection(
    'Examples:',
    commands.map((command) => `${pc.dim('$')} ${command}`),
  );
}

/** The `Docs:` line pointing at a page of the documentation site. */
export function docsLine(path = ''): string {
  return `Docs: ${pc.underline(`${DOCS_URL}${path}`)}`;
}
