/**
 * Minimal HTTP fixture for engine-level integration tests.
 *
 * Engine tests assert on the engine's own behaviour: pooling, attempt
 * lifecycle, navigation, location, state, artifacts. They need a reachable
 * origin and a few stable pages, not the runner's full multi-page fixture app.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const HOME = `<!doctype html>
<html>
<head><title>Fixture Home</title></head>
<body>
<h1>Home</h1>
<input id="readonly" readonly>
<div id="class-card" class="card active" data-extra="node-only">Card</div>
</body>
</html>`;

const FORM = `<!doctype html>
<html>
<head><title>Fixture Form</title></head>
<body>
<h1>Form</h1>
<label>First <input name="first" value="alpha"></label>
<label>Second <input name="second" value="beta"></label>
<label>Third <input name="third" value="alpha"></label>
</body>
</html>`;

/** Three controls share one value; the last shares it as a textarea. */
const VALUES = `<!doctype html>
<html>
<head><title>Fixture Values</title></head>
<body>
<h1>Values</h1>
<label>First <input name="first" value="shared"></label>
<label>Second <input name="second" value="shared"></label>
<label>Third <textarea name="third">shared</textarea></label>
<label>Other <input name="other" value="different"></label>
</body>
</html>`;

const LOGIN = `<!doctype html>
<html>
<head><title>Fixture Login</title></head>
<body style="margin:0;background:#fff">
<h1>Login</h1>
<label>User <input name="user" value="ada" style="width:200px;height:40px;background:#fff;border:1px solid #fff"></label>
<label>Password <input type="password" name="password" style="width:200px;height:40px;background:#fff;border:1px solid #fff"></label>
</body>
</html>`;

/**
 * A checkout control rendered the way third-party storefront widgets render
 * theirs: inside a closed shadow root, invisible to `shadowRoot` and to
 * Playwright's own locators. Clicking it writes into the light DOM.
 */
const CLOSED_SHADOW = `<!doctype html>
<html>
<head><title>Fixture Closed Shadow</title></head>
<body>
<h1 id="status">Cart</h1>
<x-checkout></x-checkout>
<script>
  const host = document.querySelector('x-checkout');
  const root = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  button.textContent = 'Checkout';
  button.addEventListener('click', () => { document.getElementById('status').textContent = 'Checked out'; });
  root.appendChild(button);
</script>
</body>
</html>`;

/**
 * A gate form inside a closed shadow root, with every query kind represented:
 * a hint paragraph and its hidden twin, a placeholder input carrying a test id,
 * a labelled input with a value, an input named by `aria-labelledby`, a named
 * button and its hidden twin, and two `Twin` buttons beside a third in the
 * light DOM. Below the form an open root nests inside the closed one, with a
 * button and a second `aria-labelledby` input, and a closed root inside that;
 * a second host in the light DOM nests a closed root inside an open one.
 * Submitting writes the verdict into the light DOM.
 */
const CLOSED_FORM = `<!doctype html>
<html>
<head><title>Fixture Closed Form</title></head>
<body>
<h1>Access</h1>
<button type="button" data-testid="twin-light">Twin</button>
<x-access></x-access>
<x-side></x-side>
<p id="status">locked</p>
<script>
  const root = document.querySelector('x-access').attachShadow({ mode: 'closed' });
  root.innerHTML = [
    '<p data-testid="hint">Access code hint: SHADOW-42</p>',
    '<p hidden data-testid="hint-ghost">Access code hint: SHADOW-42</p>',
    '<input placeholder="Access code" data-testid="code">',
    '<label>Nickname <input name="nickname" value="ada"></label>',
    '<span id="pin-label">PIN</span><input aria-labelledby="pin-label" data-testid="pin">',
    '<button type="button" data-testid="submit">Submit</button>',
    '<button type="button" hidden data-testid="submit-ghost">Submit</button>',
    '<button type="button" data-testid="twin-a">Twin</button>',
    '<button type="button" data-testid="twin-b">Twin</button>',
    '<section aria-label="Advanced"><x-inner></x-inner></section>',
  ].join('');
  const submit = () => {
    const code = root.querySelector('input').value;
    document.getElementById('status').textContent = code === 'SHADOW-42' ? 'granted' : 'denied';
  };
  root.querySelector('[data-testid="submit"]').addEventListener('click', submit);
  root.querySelector('input').addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
  const inner = root.querySelector('x-inner').attachShadow({ mode: 'open' });
  inner.innerHTML = '<button type="button">Open inside closed</button><span id="tone-label">Tone</span><input aria-labelledby="tone-label" data-testid="tone"><x-deep></x-deep>';
  const deep = inner.querySelector('x-deep').attachShadow({ mode: 'closed' });
  deep.innerHTML = '<button type="button">Closed inside open</button>';
  const side = document.querySelector('x-side').attachShadow({ mode: 'open' });
  side.innerHTML = '<x-side-closed></x-side-closed>';
  const sideClosed = side.querySelector('x-side-closed').attachShadow({ mode: 'closed' });
  sideClosed.innerHTML = '<button type="button">Sidecar</button>';
</script>
</body>
</html>`;

/**
 * A form that generates no box of its own, the way Shopify's one-page checkout
 * form is styled: `getClientRects()` is empty for it while every field paints.
 */
const CONTENTS = `<!doctype html>
<html>
<head><title>Fixture Contents</title></head>
<body>
<h1>Checkout</h1>
<form id="checkout" style="display:contents">
  <label>Email <input name="email"></label>
  <label>First name <input name="first"></label>
</form>
</body>
</html>`;

/** `/login` with the password field inside a closed shadow root, as embedded auth widgets render it. */
const CLOSED_LOGIN = `<!doctype html>
<html>
<head><title>Fixture Closed Login</title></head>
<body style="margin:0;background:#fff">
<h1>Login</h1>
<label>User <input name="user" value="ada" style="width:200px;height:40px;background:#fff;border:1px solid #fff"></label>
<x-auth></x-auth>
<script>
  const root = document.querySelector('x-auth').attachShadow({ mode: 'closed' });
  root.innerHTML = '<label>Password <input type="password" name="password" style="width:200px;height:40px;background:#fff;border:1px solid #fff"></label>';
</script>
</body>
</html>`;

/** Shows the stored token; `?set=<value>` stores one first. */
const STATE = `<!doctype html>
<html>
<head><title>Fixture State</title></head>
<body>
<h1 id="token">none</h1>
<script>
  const params = new URLSearchParams(location.search);
  if (params.has('set')) localStorage.setItem('token', params.get('set'));
  document.getElementById('token').textContent = localStorage.getItem('token') ?? 'none';
</script>
</body>
</html>`;

/**
 * Every node of interest twice: a hidden copy first, then the copy a person
 * sees, the way a framework keeps a prerendered segment around after a reload.
 * The paragraph pair and the panel pair are hidden only by `aria-hidden`,
 * which Playwright's own visibility filter does not see.
 */
const TWINS = `<!doctype html>
<html>
<head><title>Fixture Twins</title></head>
<body>
<h1>Twins</h1>
<section id="stale" style="display:none">
  <p>No memories yet</p>
  <input aria-label="Memory search" placeholder="Search memory..." value="alpha">
  <span data-testid="memory-empty">empty</span>
  <button>Save</button>
</section>
<section id="live">
  <p>No memories yet</p>
  <input aria-label="Memory search" placeholder="Search memory..." value="alpha">
  <span data-testid="memory-empty">empty</span>
  <button>Save</button>
</section>
<p aria-hidden="true">Decorative twin</p>
<label for="required-name">Display name<span aria-hidden="true">*</span></label>
<input id="required-name">
<label for="infix-name">Team <span aria-hidden="true">&bull;</span> name</label>
<input id="infix-name">
<label for="mixed-name">Mixed<span style="display:none">secret</span><span aria-hidden="true">*</span></label>
<input id="mixed-name">
<label for="overridden">Visible label</label>
<input id="overridden" aria-label="Override">
<label for="two-labels">First label</label>
<label for="two-labels">Second label</label>
<input id="two-labels">
<label for="labeled-button">Run the check</label>
<button id="labeled-button">Go</button>
<label for="score">Score</label>
<meter id="score" value="0.5"></meter>
<button id="insert-field" onclick="const l=document.createElement('label');l.textContent='Inserted';const i=document.createElement('input');i.id='inserted';l.htmlFor='inserted';document.body.prepend(i);document.body.prepend(l);">Insert a field</button>
<p>Decorative twin</p>
<div data-testid="memory-panel" aria-hidden="true"><span>Open</span></div>
<div data-testid="memory-panel"><span>Open</span></div>
</body>
</html>`;

/** Shows the `x-fixture-header` request header, or `none`; see `headersPage`. */
function headersPage(value: string | undefined): string {
  return `<!doctype html>
<html>
<head><title>Fixture Headers</title></head>
<body>
<h1>${value ?? 'none'}</h1>
</body>
</html>`;
}

const PROTECTED = `<!doctype html>
<html>
<head><title>Fixture Protected</title></head>
<body>
<h1>Protected</h1>
</body>
</html>`;

const UNAUTHORIZED = `<!doctype html>
<html>
<head><title>Fixture Unauthorized</title></head>
<body>
<h1>Unauthorized</h1>
</body>
</html>`;

/** The one credential `/protected` accepts, as the browser presents it. */
export const PROTECTED_CREDENTIAL = { username: 'ada', password: 'secret' } as const;
const PROTECTED_AUTHORIZATION = `Basic ${Buffer.from(
  `${PROTECTED_CREDENTIAL.username}:${PROTECTED_CREDENTIAL.password}`,
).toString('base64')}`;

/**
 * A heading with a level, a toggle button that reports `aria-pressed`, a
 * target that records a right click, and a plain area that records where
 * pointer events landed, for the pointer half of the contract.
 */
const POINTER = `<!doctype html>
<html>
<head><title>Fixture Pointer</title></head>
<body style="margin:0">
<h2>Pointer</h2>
<button id="toggle" aria-pressed="false" onclick="this.setAttribute('aria-pressed', this.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')">Mute</button>
<div id="menu-target" oncontextmenu="event.preventDefault(); this.textContent = 'context menu'">Right click me</div>
<div id="pad" style="position:absolute;left:100px;top:300px;width:400px;height:300px;background:#eee"></div>
<pre id="log"></pre>
<script>
  const log = document.getElementById('log');
  const pad = document.getElementById('pad');
  for (const type of ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'wheel']) {
    pad.addEventListener(type, (event) => {
      if (type === 'contextmenu') event.preventDefault();
      log.textContent += type + ':' + event.clientX + ',' + event.clientY + (type === 'wheel' ? ':' + event.deltaY : '') + String.fromCharCode(10);
    });
  }
</script>
</body>
</html>`;

/**
 * One closed root whose host precedes a light-DOM match of the same query, so
 * the reader's in-place order and the locators' light-first order differ.
 */
const CLOSED_ORDER = `<!doctype html>
<html>
<head><title>Fixture Closed Order</title></head>
<body>
<h1>Order</h1>
<x-widget></x-widget>
<button type="button">Beta</button>
<script>
  const root = document.querySelector('x-widget').attachShadow({ mode: 'closed' });
  root.innerHTML = '<button type="button">Alpha</button>';
</script>
</body>
</html>`;

/**
 * A list of rows, each one labelled control beside a Remove button, for
 * composing an exact label query as a `has` filter or a scope. The second
 * row's label carries an aria-hidden marker, which Playwright's own label
 * matching reads and the engine's reader drops; a third row has a label with
 * the characters a selector body has to carry unharmed.
 */
const ROWS = `<!doctype html>
<html>
<head><title>Fixture Rows</title></head>
<body>
<h1>Rows</h1>
<ul>
  <li data-testid="row-last-name"><label>Last Name <input name="last"></label><button type="button" onclick="this.parentElement.remove()">Remove</button></li>
  <li data-testid="row-name"><label for="name">Name<span aria-hidden="true">*</span></label><input id="name"><button type="button" onclick="this.parentElement.remove()">Remove</button></li>
  <li data-testid="row-quoted"><label>Say "hi" >> now <input name="quoted"></label><button type="button" onclick="this.parentElement.remove()">Remove</button></li>
</ul>
</body>
</html>`;

const PAGES: Readonly<Record<string, string>> = {
  '/': HOME,
  '/pointer': POINTER,
  '/closed-shadow': CLOSED_SHADOW,
  '/closed-form': CLOSED_FORM,
  '/closed-order': CLOSED_ORDER,
  '/contents': CONTENTS,
  '/closed-login': CLOSED_LOGIN,
  '/form': FORM,
  '/values': VALUES,
  '/login': LOGIN,
  '/state': STATE,
  '/twins': TWINS,
  '/rows': ROWS,
};

/** Delay before `/slow` answers, long enough for a caller to cancel first. */
const SLOW_RESPONSE_MS = 5_000;

export interface FixtureApp {
  readonly url: string;
  close(): Promise<void>;
}

/** Starts the fixture on an ephemeral port and resolves once it is listening. */
export function startFixtureApp(): Promise<FixtureApp> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.test');
    if (url.pathname === '/slow') {
      const timer = setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(HOME);
      }, SLOW_RESPONSE_MS);
      request.on('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname === '/sw.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end("self.addEventListener('fetch', () => {});");
      return;
    }
    if (url.pathname === '/headers') {
      const value = request.headers['x-fixture-header'];
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(headersPage(Array.isArray(value) ? value.join(',') : value));
      return;
    }
    if (url.pathname === '/protected') {
      if (request.headers.authorization === PROTECTED_AUTHORIZATION) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PROTECTED);
        return;
      }
      response.writeHead(401, {
        'content-type': 'text/html; charset=utf-8',
        'www-authenticate': 'Basic realm="fixture"',
      });
      response.end(UNAUTHORIZED);
      return;
    }
    const page = PAGES[url.pathname];
    if (page !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
