/** A GitHub REST API that records calls and answers from a script, and the Actions environment a job sees. */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/**
 * A fetch that records calls and answers from a script keyed by
 * `METHOD /path?query`, then `METHOD /path`, then `METHOD *`.
 */
export function fakeGitHub(script: Record<string, (call: Call) => Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const call: Call = { url, method, headers, body };
    calls.push(call);
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    const parsed = new URL(url);
    const answer =
      script[`${method} ${parsed.pathname}${parsed.search}`] ?? script[`${method} ${parsed.pathname}`] ?? script[`${method} *`];
    if (answer === undefined) throw new Error(`unexpected request ${method} ${parsed.pathname}${parsed.search}`);
    return answer(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** What GitHub Actions sets for a `pull_request` job, event payload at `/event.json`. */
export const actionsEnv = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'octo/app',
  GITHUB_SHA: 'merge-sha',
  GITHUB_RUN_ID: '99',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_EVENT_PATH: '/event.json',
  GITHUB_WORKFLOW: 'e2e',
  GITHUB_JOB: 'test',
  GITHUB_STEP_SUMMARY: '/summary.md',
};

/** Event payloads by path, the way `readFile` hands them to `detectActions`. */
const events: Record<string, string> = {
  '/event.json': JSON.stringify({ pull_request: { number: 41, head: { sha: 'head-sha' } } }),
  '/event/comment.json': JSON.stringify({ issue: { number: 7, pull_request: { url: 'x' } } }),
  '/event/issue.json': JSON.stringify({ issue: { number: 8 } }),
  '/event/push.json': JSON.stringify({ ref: 'refs/heads/main' }),
  '/event/broken.json': '{not json',
};

export async function readEvent(file: string): Promise<string> {
  const text = events[file];
  if (text === undefined) throw new Error(`ENOENT ${file}`);
  return text;
}
