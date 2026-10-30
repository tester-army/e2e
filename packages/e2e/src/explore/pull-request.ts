/**
 * The pull request a CI job explores, when the job says which one: its title
 * and description, for the planner to read beside the change. GitHub Actions
 * names it in the `pull_request` event's payload, GitLab CI in its merge
 * request variables; any other CI, or a run outside one, has none. The text
 * is the author's, so it is cut to a budget and read as a claim, never as
 * instructions.
 */

import { readFileSync } from 'node:fs';
import { isPlainObject } from '../internal/options.ts';

/** Characters of the title kept. */
const MAX_TITLE_CHARS = 200;
/** Bytes of the description kept, in whole lines. */
const DESCRIPTION_BUDGET_BYTES = 1_500;
/** Bytes one description line may take, well under the budget: a pasted log or table says little at full length. */
const MAX_LINE_BYTES = 600;

/** A pull request's text as the brief shows it. */
export interface PullRequestText {
  /** `#12` on GitHub, `!12` on GitLab, as each names its own. */
  readonly ref: string;
  readonly title: string;
  /** Undefined when it has none, or only template comments. */
  readonly description: string | undefined;
  /** Whether the description was cut to fit. */
  readonly cut: boolean;
}

/**
 * The pull request the environment names, or undefined. Only GitHub's
 * `pull_request` event counts: `pull_request_target` runs with the base
 * branch's secrets on a fork's code, where nothing should explore.
 */
export function readPullRequest(env: NodeJS.ProcessEnv): PullRequestText | undefined {
  if (env['GITHUB_ACTIONS'] === 'true') {
    if (env['GITHUB_EVENT_NAME'] !== 'pull_request' || !env['GITHUB_EVENT_PATH']) return undefined;
    const pull = githubPullRequest(env['GITHUB_EVENT_PATH']);
    return pull === undefined ? undefined : text(`#${pull.number}`, pull.title, pull.body);
  }
  if (env['GITLAB_CI'] === 'true' && env['CI_MERGE_REQUEST_IID']) {
    return text(`!${env['CI_MERGE_REQUEST_IID']}`, env['CI_MERGE_REQUEST_TITLE'] ?? '', env['CI_MERGE_REQUEST_DESCRIPTION']);
  }
  return undefined;
}

/** The event payload's pull request, or undefined when the file is unreadable or holds none. */
function githubPullRequest(eventPath: string): { number: number; title: string; body: string | undefined } | undefined {
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    return undefined;
  }
  const pull = isPlainObject(event) ? event['pull_request'] : undefined;
  if (!isPlainObject(pull) || typeof pull['number'] !== 'number' || typeof pull['title'] !== 'string') return undefined;
  return { number: pull['number'], title: pull['title'], body: typeof pull['body'] === 'string' ? pull['body'] : undefined };
}

/** The title on one line within its cap; the description without template comments, cut to whole lines within its budget. */
function text(ref: string, title: string, body: string | undefined): PullRequestText {
  const flat = title.replaceAll(/\s+/gu, ' ').trim();
  const cleaned = (body ?? '')
    .replaceAll(/<!--[\s\S]*?(?:-->|$)/gu, '')
    .replaceAll(/\r\n?/gu, '\n')
    .replaceAll(/\n{3,}/gu, '\n\n')
    .trim();
  const kept: string[] = [];
  let used = 0;
  const lines = cleaned === '' ? [] : cleaned.split('\n');
  for (const raw of lines) {
    const capped = capBytes(raw, MAX_LINE_BYTES);
    // The line, the two spaces the brief indents it by, and its newline.
    const size = Buffer.byteLength(capped) + 3;
    if (used + size > DESCRIPTION_BUDGET_BYTES) break;
    kept.push(capped);
    used += size;
  }
  const cut = kept.length < lines.length || kept.some((line, index) => line !== lines[index]);
  return {
    ref,
    title: flat.length <= MAX_TITLE_CHARS ? flat : `${flat.slice(0, MAX_TITLE_CHARS - 1)}…`,
    description: kept.length === 0 ? undefined : kept.join('\n'),
    cut,
  };
}

/** `line` within `bytes` of UTF-8, cut between characters and marked with `…` when cut. */
function capBytes(line: string, bytes: number): string {
  if (Buffer.byteLength(line) <= bytes) return line;
  let kept = '';
  let used = Buffer.byteLength('…');
  for (const character of line) {
    used += Buffer.byteLength(character);
    if (used > bytes) break;
    kept += character;
  }
  return `${kept}…`;
}
