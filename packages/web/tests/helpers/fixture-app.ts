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
 * Three frames of one child document: one the embedding document marks
 * aria-hidden, one it collapses, one it shows. The child document sees none
 * of that, so a frame-scoped read has to carry the boundary's state in.
 */
const FRAMES = `<!doctype html>
<html>
<head><title>Fixture Frames</title></head>
<body>
<h1>Frames</h1>
<iframe id="hidden-frame" title="Hidden frame" aria-hidden="true" src="/frame-child"></iframe>
<iframe id="collapsed-frame" title="Collapsed frame" style="display:none" src="/frame-child"></iframe>
<iframe id="shown-frame" title="Shown frame" src="/frame-child"></iframe>
</body>
</html>`;

const FRAME_CHILD = `<!doctype html>
<html>
<head><title>Frame child</title></head>
<body>
<button>Save</button>
</body>
</html>`;

/**
 * Two shadow hosts, each holding a "Save" button; the first host is
 * aria-hidden. Playwright's text engine lists shadow matches in host order,
 * so the hidden one comes first, and no XPath run on a match can see its host.
 */
const SHADOW_TWINS = `<!doctype html>
<html>
<head><title>Fixture Shadow Twins</title></head>
<body>
<h1>Shadow twins</h1>
<div id="stale" aria-hidden="true"></div>
<div id="live"></div>
<script>
  document.getElementById('stale').attachShadow({ mode: 'open' }).innerHTML = '<button>Save</button>';
  const live = document.getElementById('live').attachShadow({ mode: 'open' });
  live.innerHTML = '<button>Save</button>';
  live.querySelector('button').addEventListener('click', (event) => { event.target.textContent = 'Saved'; });
</script>
</body>
</html>`;

/**
 * Two outer frames of one middle document, which holds an aria-hidden inner
 * frame and a shown one: every pairing of a shown or collapsed outer with a
 * hidden or shown inner, for the depth at which the outermost boundary rules.
 */
const NESTED_FRAMES = `<!doctype html>
<html>
<head><title>Fixture Nested Frames</title></head>
<body>
<h1>Nested frames</h1>
<iframe id="shown-outer" title="Shown outer" src="/frame-middle"></iframe>
<iframe id="collapsed-outer" title="Collapsed outer" style="display:none" src="/frame-middle"></iframe>
</body>
</html>`;

const FRAME_MIDDLE = `<!doctype html>
<html>
<head><title>Frame middle</title></head>
<body>
<iframe id="hidden-inner" title="Hidden inner" aria-hidden="true" src="/frame-child"></iframe>
<iframe id="shown-inner" title="Shown inner" src="/frame-child"></iframe>
</body>
</html>`;

/**
 * Two cards of the same test id and text in the light DOM, the first under
 * an aria-hidden wrapper that paints as usual: what a visible query composed
 * as a scope or a `has` filter must leave out by selector alone.
 */
const ARIA_HIDDEN_CARDS = `<!doctype html>
<html>
<head><title>Fixture Aria Hidden Cards</title></head>
<body>
<h1>Cards</h1>
<div aria-hidden="true"><section data-testid="card"><p>Save</p></section></div>
<section data-testid="card"><p>Save</p></section>
</body>
</html>`;

const PAGES: Readonly<Record<string, string>> = {
  '/': HOME,
  '/frames': FRAMES,
  '/frame-child': FRAME_CHILD,
  '/nested-frames': NESTED_FRAMES,
  '/frame-middle': FRAME_MIDDLE,
  '/aria-hidden-cards': ARIA_HIDDEN_CARDS,
  '/shadow-twins': SHADOW_TWINS,
  '/pointer': POINTER,
  '/closed-shadow': CLOSED_SHADOW,
  '/contents': CONTENTS,
  '/closed-login': CLOSED_LOGIN,
  '/form': FORM,
  '/values': VALUES,
  '/login': LOGIN,
  '/state': STATE,
  '/twins': TWINS,
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
