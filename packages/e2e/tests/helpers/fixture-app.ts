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
