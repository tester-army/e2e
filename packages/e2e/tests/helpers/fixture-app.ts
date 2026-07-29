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
  '/twins': `<!doctype html>
<html>
<head><title>Twins</title></head>
<body style="margin:0">
  <canvas id="left" width="120" height="60" style="position:fixed;left:0;top:0"></canvas>
  <canvas id="right" width="120" height="60" style="position:fixed;left:200px;top:0"></canvas>
  <button style="position:fixed;left:0;top:80px">Pick</button>
  <button style="position:fixed;left:200px;top:80px">Pick</button>
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

export interface FixtureApp {
  readonly url: string;
  close(): Promise<void>;
}

/** Starts the fixture app on an ephemeral loopback port. */
export async function startFixtureApp(): Promise<FixtureApp> {
  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/api/flags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ betaBoard: false }));
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
