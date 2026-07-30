/** Static multi-page fixture app served over HTTP for integration tests. */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const PAGES: Record<string, string> = {
  '/': `<!doctype html>
<html>
<head><title>Fixture Home</title></head>
<body>
  <h1>Home</h1>
  <a href="/about">About</a>
  <a href="/about?token=super-secret-token#frag">About with token</a>
  <button id="increment" onclick="document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1)">Increment</button>
  <output id="count" role="status" aria-label="Counter">0</output>

  <label for="email">Email</label>
  <input id="email" type="email" placeholder="you@example.test" autocomplete="username" />

  <label for="password">Password</label>
  <input id="password" type="password" autocomplete="current-password" />

  <label for="notifications">Notifications</label>
  <input id="notifications" type="checkbox" />

  <label for="plan">Plan</label>
  <select id="plan">
    <option value="free">Free</option>
    <option value="pro">Pro</option>
    <option value="team">Team</option>
  </select>

  <button disabled>Disabled action</button>
  <div hidden>Hidden content</div>
  <button aria-expanded="false" id="menu" onclick="this.setAttribute('aria-expanded', this.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')">Menu</button>

  <ul data-testid="items">
    <li data-testid="item">Item Alpha</li>
    <li data-testid="item">Item Beta</li>
    <li data-testid="item">Item Gamma</li>
  </ul>
  <span>Duplicated</span>
  <span>Duplicated</span>

  <input id="prefilled" aria-label="Prefilled" value="hello-value" />

  <script>
    setTimeout(() => {
      const late = document.createElement('button');
      late.textContent = 'Late arrival';
      document.body.appendChild(late);
    }, 400);
  </script>
</body>
</html>`,
  '/about': `<!doctype html>
<html>
<head><title>About page</title></head>
<body>
  <h1>About</h1>
  <a href="/">Home</a>
</body>
</html>`,
  '/storage': `<!doctype html>
<html>
<head><title>Storage</title></head>
<body>
  <h1>Storage</h1>
  <button onclick="localStorage.setItem('marker', 'saved'); document.cookie = 'fixture=cookie-value; path=/'; render()">Save marker</button>
  <output id="marker" aria-label="Marker"></output>
  <script>
    function render() {
      document.getElementById('marker').textContent = localStorage.getItem('marker') ?? 'empty';
    }
    render();
  </script>
</body>
</html>`,
  '/verbs': `<!doctype html>
<html>
<head><title>Verbs playground</title></head>
<body>
  <h1>Verbs</h1>

  <label for="search">Search</label>
  <input id="search" type="search" onkeydown="if (event.key === 'Enter') document.getElementById('submitted').textContent = 'submitted:' + this.value" />
  <output id="submitted" aria-label="Submitted"></output>

  <div id="hover-zone" onmouseenter="document.getElementById('reveal').hidden = false">Hover zone</div>
  <button id="reveal" hidden>Revealed action</button>

  <ul aria-label="Board">
    <li id="card" draggable="true">Card One</li>
  </ul>
  <div id="dropzone" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.getElementById('drop-state').textContent = 'dropped'">Drop zone</div>
  <output id="drop-state" aria-label="Drop state"></output>

  <label for="avatar">Avatar</label>
  <input id="avatar" type="file" onchange="document.getElementById('file-name').textContent = this.files[0] ? this.files[0].name : ''" />
  <output id="file-name" aria-label="File name"></output>
</body>
</html>`,
  '/frame': `<!doctype html>
<html>
<head><title>Frame host</title></head>
<body>
  <h1>Frame host</h1>
  <iframe id="child" src="/child" title="child"></iframe>
</body>
</html>`,
  '/child': `<!doctype html>
<html>
<head><title>Child frame</title></head>
<body>
  <button onclick="this.textContent = 'Frame clicked'">Frame button</button>
</body>
</html>`,
  '/dialog': `<!doctype html>
<html>
<head><title>Dialog page</title></head>
<body>
  <h1>Dialog</h1>
  <button onclick="document.getElementById('answer').textContent = confirm('Proceed?') ? 'accepted' : 'dismissed'">Ask</button>
  <output id="answer" aria-label="Answer"></output>
</body>
</html>`,
  // A surface with no accessibility semantics at all: the pins exist only as
  // pixels, so the semantic tree cannot name either one and pointing is the
  // only way to reach them.
  '/canvas': `<!doctype html>
<html>
<head><title>Canvas map</title></head>
<body style="margin:0">
  <canvas id="map" width="400" height="200" style="position:fixed;left:0;top:0"></canvas>
  <output id="hit" role="status" aria-label="Hit" style="position:fixed;left:0;top:220px">none</output>
  <script>
    const canvas = document.getElementById('map');
    const context = canvas.getContext('2d');
    context.fillStyle = '#dddddd';
    context.fillRect(0, 0, 400, 200);
    const pins = [
      { name: 'red', x: 300, y: 60, color: '#ff0000' },
      { name: 'blue', x: 80, y: 140, color: '#0000ff' },
    ];
    for (const pin of pins) {
      context.fillStyle = pin.color;
      context.beginPath();
      context.arc(pin.x, pin.y, 14, 0, Math.PI * 2);
      context.fill();
    }
    canvas.addEventListener('click', (event) => {
      const box = canvas.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      const pin = pins.find((candidate) => Math.hypot(candidate.x - x, candidate.y - y) <= 18);
      document.getElementById('hit').textContent =
        pin ? pin.name : 'miss at ' + Math.round(x) + ',' + Math.round(y);
    });
  </script>
</body>
</html>`,
  // Two controls the tree cannot tell apart: every query derived from either one
  // matches both, so a tree-only locate strands on LOCATOR_AMBIGUOUS. Only the
  // pixels distinguish them.
  // Two "Pick" buttons stacked at one rect, so no derived query and no index can
  // separate them: role, name, and geometry are all shared. That is what strands
  // a tree-only locate for good, rather than merely making it ambiguous.
  '/twins': `<!doctype html>
<html>
<head><title>Twins</title></head>
<body style="margin:0">
  <canvas id="left" width="120" height="60" style="position:fixed;left:0;top:0"></canvas>
  <canvas id="right" width="120" height="60" style="position:fixed;left:200px;top:0"></canvas>
  <button style="position:fixed;left:0;top:80px;width:90px;height:24px">Pick</button>
  <button style="position:fixed;left:0;top:80px;width:90px;height:24px">Pick</button>
  <output id="picked" role="status" aria-label="Picked">none</output>
  <script>
    for (const [id, label] of [['left', 'L'], ['right', 'R']]) {
      const context = document.getElementById(id).getContext('2d');
      context.fillStyle = id === 'left' ? '#ff0000' : '#0000ff';
      context.fillRect(0, 0, 120, 60);
      context.fillStyle = '#ffffff';
      context.font = '32px sans-serif';
      context.fillText(label, 50, 42);
    }
    document.addEventListener('click', (event) => {
      const box = event.target.getBoundingClientRect();
      document.getElementById('picked').textContent = box.left < 100 ? 'left' : 'right';
    });
  </script>
</body>
</html>`,
  // Repeated cross-sell rows: several buttons share role, name, and test id, so
  // every derived query is ambiguous and only position tells them apart. The
  // last row is a deliberate dead end — two buttons stacked at the same rect.
  '/rows': `<!doctype html>
<html>
<head><title>Rows</title></head>
<body>
  <output id="picked" role="status" aria-label="Picked">none</output>
  <div id="rows"></div>
  <div style="position:relative;height:30px">
    <button data-testid="buy" style="position:absolute;left:0;top:0;width:80px;height:30px">Twin</button>
    <button data-testid="buy" style="position:absolute;left:0;top:0;width:80px;height:30px">Twin</button>
  </div>
  <script>
    const host = document.getElementById('rows');
    for (const hotel of ['Alpha', 'Beta', 'Gamma']) {
      const row = document.createElement('div');
      const label = document.createElement('span');
      label.textContent = hotel;
      const button = document.createElement('button');
      button.textContent = 'Kup teraz';
      button.setAttribute('data-testid', 'buy');
      button.addEventListener('click', () => {
        document.getElementById('picked').textContent = hotel;
      });
      row.append(label, button);
      host.append(row);
    }
  </script>
</body>
</html>`,
  '/flags': `<!doctype html>
<html>
<head><title>Flags</title></head>
<body>
  <h1>Flags</h1>
  <output id="flags" aria-label="Flags">loading</output>
  <script>
    fetch('/api/flags')
      .then((response) => response.json())
      .then((flags) => {
        document.getElementById('flags').textContent = flags.betaBoard ? 'beta on' : 'beta off';
      })
      .catch(() => {
        document.getElementById('flags').textContent = 'error';
      });
  </script>
</body>
</html>`,
};

/**
 * A page whose content changes on every request while its route stays put,
 * like a real listing with rotating prices and ordering. Used to prove the
 * cache survives content churn.
 */
let feedRequests = 0;

function renderFeed(): string {
  feedRequests += 1;
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

export interface FixtureApp {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Three identical controls with nothing that names them or any ancestor: no test
 * id, no form `name`, plain divs all the way to `body`. The sweep can still pin
 * one by index, but there is no selector worth storing for it — a path counted
 * from `body` is shifted by the widget this page appends, exactly as a chat
 * bubble does on a production page.
 */
const UNANCHORED_PAGE = `<!doctype html>
<html>
<head><title>Unanchored</title></head>
<body style="margin:0">
  <output id="picked" role="status" aria-label="Picked">none</output>
  <div>
    <div><span>Row one</span> <button onclick="pick('1')">Zarezerwuj</button></div>
    <div><span>Row two</span> <button onclick="pick('2')">Zarezerwuj</button></div>
    <div><span>Row three</span> <button onclick="pick('3')">Zarezerwuj</button></div>
  </div>
  <script>
    function pick(row) {
      document.getElementById('picked').textContent = row;
    }
    setTimeout(() => {
      const widget = document.createElement('div');
      widget.textContent = 'Chat with us';
      document.body.prepend(widget);
    }, 150);
  </script>
</body>
</html>`;

/**
 * A control repeated per row, as a listing repeats one reservation button. Every
 * query derived from any row matches all of them, so the sweep can only resolve
 * one by pinning an index.
 *
 * `?reverse=1` serves the same three offers in the opposite order. Cache route
 * identity drops the query, so both URLs are the same place and share a key —
 * which is how a warm run can replay an entry recorded against a page whose rows
 * have since reordered. An index would land on the wrong offer; a selector
 * anchored on the button's own name does not.
 *
 * The widget appended at body level is what a chat bubble, a consent frame, or a
 * React portal does, and it shifts every nth-child index under body.
 */
function renderRepeats(reverse: boolean): string {
  const offers = reverse ? ['C', 'B', 'A'] : ['A', 'B', 'C'];
  const rows = offers
    .map(
      (offer) =>
        `    <li><span>Offer ${offer}</span> <button name="reserve-${offer.toLowerCase()}" ` +
        `onclick="pick('${offer}')">Reserve now</button></li>`,
    )
    .join('\n');
  return `<!doctype html>
<html>
<head><title>Repeats</title></head>
<body style="margin:0">
  <output id="picked" role="status" aria-label="Picked">none</output>
  <ul style="list-style:none;padding:0">
${rows}
  </ul>
  <script>
    function pick(offer) {
      document.getElementById('picked').textContent = offer;
    }
    setTimeout(() => {
      const widget = document.createElement('div');
      widget.textContent = 'Chat with us';
      document.body.prepend(widget);
    }, 150);
  </script>
</body>
</html>`;
}

/** Starts the fixture app on an ephemeral loopback port. */
export async function startFixtureApp(): Promise<FixtureApp> {
  const server: Server = createServer((request, response) => {
    const requested = new URL(request.url ?? '/', 'http://localhost');
    const pathname = requested.pathname;
    if (pathname === '/unanchored') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(UNANCHORED_PAGE);
      return;
    }
    if (pathname === '/repeats') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(renderRepeats(requested.searchParams.get('reverse') === '1'));
      return;
    }
    if (pathname === '/api/flags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ betaBoard: false }));
      return;
    }
    if (pathname === '/feed') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(renderFeed());
      return;
    }
    const page = PAGES[pathname];
    if (page === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
