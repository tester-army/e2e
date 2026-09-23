/** Pages of an app with a database: minted ids, created records, counted searches, kept todos. */

import { escapeHtml, type FixtureState, type PageRenderer } from './page.ts';

/**
 * One record's page under a minted id, served for `/records/<id>` and
 * `/drafts/<id>` alike. The id is whatever the caller put in the path, so a
 * test can open the "same" screen under a fresh id on every run, as a step
 * that edits the record a previous step created does. Trace cache route
 * identity must read both ids as one route and the two prefixes as two.
 * `?variant=renamed` relabels the only control, so a recording's first
 * action has nothing to re-find.
 */
export function renderRecord(kind: string, id: string, variant: string | null): string {
  return `<!doctype html>
<html>
<head><title>Record</title></head>
<body>
  <h1>${escapeHtml(kind)} ${escapeHtml(id)}</h1>
  <button onclick="document.getElementById('state').textContent = 'archived'">${variant === 'renamed' ? 'Retire' : 'Archive'}</button>
  <output id="state" role="status" aria-label="Record state">open</output>
</body>
</html>`;
}

/**
 * A create form whose submit navigates to the created record's page, the
 * name percent-encoded in the path. `?variant=renamed` relabels the submit
 * button, the shape of a UI change that lands mid-flow: the recorded typing
 * still replays, the recorded tap no longer finds its target.
 */
function renderCompanyForm(variant: string | null): string {
  const submit = variant === 'renamed' ? 'Save' : 'Create';
  return `<!doctype html>
<html>
<head><title>New company</title></head>
<body>
  <h1>New company</h1>
  <label for="company-name">Company name</label>
  <input id="company-name" />
  <button onclick="location.href = '/companies/' + encodeURIComponent(document.getElementById('company-name').value)">${submit}</button>
</body>
</html>`;
}

/** The page the company form navigates to: the name as the heading, a status the replay anchors on. */
export function renderCompany(name: string): string {
  return `<!doctype html>
<html>
<head><title>Company</title></head>
<body>
  <h1>${escapeHtml(name)}</h1>
  <output id="state" role="status" aria-label="Company state">created</output>
  <a href="/companies/new">New company</a>
</body>
</html>`;
}

/**
 * A search page whose results land in the query string as a form submission
 * spells it (`?q=E2E+abc`). The results carry the text that changes on every
 * visit: a record count that grows with the searches made so far, a timing in
 * milliseconds, and a bare-number badge, beside one stable status line.
 */
function renderSearch(query: string | null, searches: number): string {
  const results =
    query === null
      ? ''
      : `  <h2>Results for ${escapeHtml(query)}</h2>
  <p>${String(searches)} results in ${String(200 + ((searches * 137) % 700))}ms</p>
  <span role="status">${String(searches)}</span>
  <output role="status" aria-label="Search state">done</output>
`;
  return `<!doctype html>
<html>
<head><title>Search</title></head>
<body>
  <h1>Search</h1>
  <form action="/search" method="get">
    <label for="q">Query</label>
    <input id="q" name="q" />
    <button type="submit">Search</button>
  </form>
${results}</body>
</html>`;
}

/**
 * A page whose content changes on every request while its route stays put,
 * like a real listing with rotating prices and ordering. Used to prove the
 * cache survives content churn.
 */
function renderFeed(feedRequests: number): string {
  const items = [0, 1, 2].map(
    (offset) =>
      `<li><a href="/about">Offer ${String(((feedRequests + offset) % 97) + 1)} — ${String(
        1000 + ((feedRequests * 37 + offset * 13) % 9000),
      )} zl</a></li>`,
  );
  return `<!doctype html>
<html>
<head><title>Feed</title></head>
<body>
  <h1>Feed</h1>
  <button id="refresh" onclick="document.getElementById('mark').textContent = 'refreshed'">Refresh feed</button>
  <output id="mark" role="status" aria-label="Marker">idle</output>
  <ul>${items.join('')}</ul>
</body>
</html>`;
}

/**
 * A todo list the server keeps for the life of the fixture, the way an app
 * with a database shows the last run's data on the next run's first screen.
 * Adding one shows a status the page load owns, so every run has an effect
 * to anchor on even when the list already held the value.
 */
function renderTodos(todos: ReadonlySet<string>): string {
  const items = [...todos].map((todo) => `    <li>${todo}</li>`).join('\n');
  return `<!doctype html>
<html>
<head><title>Todos</title></head>
<body>
  <h1>Todos</h1>
  <label for="todo">New todo</label>
  <input id="todo" />
  <button id="add">Add</button>
  <output id="result" role="status" aria-label="Result"></output>
  <ul id="todos" aria-label="Todos">
${items}
  </ul>
  <script>
    document.getElementById('add').addEventListener('click', async () => {
      const response = await fetch('/api/todos', { method: 'POST', body: document.getElementById('todo').value });
      const todos = await response.json();
      document.getElementById('todos').replaceChildren(
        ...todos.map((todo) => Object.assign(document.createElement('li'), { textContent: todo })),
      );
      document.getElementById('result').textContent = 'added';
    });
  </script>
</body>
</html>`;
}

export const RECORD_PAGES: Record<string, PageRenderer> = {
  '/companies/new': (_state, url) => renderCompanyForm(url.searchParams.get('variant')),
  '/search': (state: FixtureState, url) => {
    const query = url.searchParams.get('q');
    if (query !== null) state.searches += 1;
    return renderSearch(query, state.searches);
  },
  '/feed': (state) => {
    state.feedRequests += 1;
    return renderFeed(state.feedRequests);
  },
  '/todos': (state) => renderTodos(state.todos),
};
