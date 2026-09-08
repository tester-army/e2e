/** The `e2e init` step that writes the `## e2e` section of a project's `AGENTS.md`. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const AGENTS_FILE = 'AGENTS.md';

const START_MARKER = '<!-- e2e:start -->';
const END_MARKER = '<!-- e2e:end -->';

/**
 * Where agents that do not read `AGENTS.md` expect the same text. Printed
 * after the write so the user knows where to copy the section.
 */
export const AGENTS_SECTION_COPIES = ['CLAUDE.md', '.cursor/rules/e2e.mdc'] as const;

/**
 * The section itself. It is the shortest text that lets an agent write and
 * run a test without the skill files: where the config and tests live, the
 * commands, how to read a run, and what the cache is. Everything longer is
 * in the skill, which the last line points at.
 */
export const AGENTS_SECTION = `## e2e

End-to-end tests run with [e2e](https://e2e.docs.buildwithfern.com), the
\`@e2edev/e2e\` runner. Tests are TypeScript under the \`tests\` glob of
\`e2e.config.ts\` (default \`tests/**/*.e2e.ts\`).

- Run the CLI as \`npx --no-install e2e ...\`, never \`npx e2e\`.
- Write deterministic steps first (\`screen\`, \`app\`, \`web\`, \`expect\`);
  use one \`agent.act\` per goal only where the flow varies, and follow it
  with an \`expect\`. Never add a sleep: queries poll, actions wait, \`expect\`
  retries.
- Run one file while iterating: \`npx --no-install e2e run tests/<feature>.e2e.ts\`.
  Agent steps need \`E2E_MODEL=provider/model-id\` and \`E2E_MODEL_API_KEY\`.
- Read a failing run from \`.e2e/report.json\`, or run with \`--reporter json\`
  to get the same document on stdout: \`run.status\`, \`run.errors[]\`, and
  \`run.results[].attempts[]\` with \`steps[]\`, \`error\`, and \`artifacts[]\`.
- \`.e2e/\` is output. \`.e2e/cache/\` replays passing \`agent.act\` steps
  without model calls; pass \`--no-cache\` to rule it out of a failure, and
  never edit it by hand.
- Secrets never appear in tests: declare \`credentials\` in the config and
  resolve them with \`credentials.user(name)\`.

The full guide is the \`e2e\` skill in \`.agents/skills/e2e/\` or
\`.claude/skills/e2e/\`; without it, \`npx --no-install e2e guide [topic]\`
prints the same text.
`;

const BLOCK = `${START_MARKER}\n${AGENTS_SECTION}${END_MARKER}\n`;

export interface AgentsSectionWrite {
  /** True when `AGENTS.md` already existed and the section is appended or refreshed. */
  readonly existing: boolean;
  /** True when an older section between the markers is being replaced. */
  readonly refresh: boolean;
  readonly content: string;
}

/**
 * Plans the `AGENTS.md` write. A missing file is created with the section
 * alone; a file without the markers gets the section appended after its
 * last line; a file whose marked section differs from the current text has
 * only that section replaced. A file already carrying the current section
 * needs nothing. Text outside the markers is never touched.
 */
export function planAgentsSection(cwd: string): AgentsSectionWrite | undefined {
  const file = path.join(cwd, AGENTS_FILE);
  if (!existsSync(file)) return { existing: false, refresh: false, content: BLOCK };
  const current = readFileSync(file, 'utf8');
  const start = current.indexOf(START_MARKER);
  const end = current.indexOf(END_MARKER, start);
  if (start !== -1 && end !== -1) {
    const tail = end + END_MARKER.length;
    const afterMarker = current.startsWith('\n', tail) ? tail + 1 : tail;
    const replaced = `${current.slice(0, start)}${BLOCK}${current.slice(afterMarker)}`;
    return replaced === current ? undefined : { existing: true, refresh: true, content: replaced };
  }
  const separator = current === '' ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  return { existing: true, refresh: false, content: `${current}${separator}${BLOCK}` };
}
