/**
 * The few GitHub API calls the PR policy makes, over `fetch` with the
 * workflow's `GITHUB_TOKEN` against `GITHUB_REPOSITORY`.
 */

const API = 'https://api.github.com';

/** The token and `owner/name` from the Actions environment; exits when either is missing. */
function env(): { token: string; repo: string } {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    process.stderr.write('GITHUB_TOKEN and GITHUB_REPOSITORY are required\n');
    process.exit(2);
  }
  return { token, repo };
}

/** One authenticated request; throws on a non-2xx response. */
async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const { token } = env();
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

/** A REST call under `/repos/{owner}/{name}`. */
export function rest(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  return request(`/repos/${env().repo}${path}`, init);
}

/** A GraphQL query with `owner` and `name` bound to the repository. */
export async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const [owner, name] = env().repo.split('/');
  const result = (await request('/graphql', { method: 'POST', body: { query, variables: { owner, name, ...variables } } })) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (result.errors?.length) throw new Error(result.errors.map(({ message }) => message).join('; '));
  if (result.data === undefined) throw new Error('GraphQL response without data');
  return result.data;
}

export interface Comment {
  id: number;
  body: string;
  created_at: string;
}

/** Every comment on an issue or PR. */
export async function comments(number: number): Promise<Comment[]> {
  const all: Comment[] = [];
  for (let page = 1; ; page++) {
    const batch = (await rest(`/issues/${number}/comments?per_page=100&page=${page}`)) as Comment[];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

/** Adds a label; GitHub creates it on first use. */
export async function addLabel(number: number, label: string): Promise<void> {
  await rest(`/issues/${number}/labels`, { method: 'POST', body: { labels: [label] } });
}

/** Removes a label, ignoring one that is not there. */
export async function removeLabel(number: number, label: string): Promise<void> {
  try {
    await rest(`/issues/${number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' });
  } catch (error) {
    if (!String(error).includes(': 404 ')) throw error;
  }
}

/** Comments, then closes the PR. */
export async function closeWithComment(number: number, body: string): Promise<void> {
  await rest(`/issues/${number}/comments`, { method: 'POST', body: { body } });
  await rest(`/pulls/${number}`, { method: 'PATCH', body: { state: 'closed' } });
}
