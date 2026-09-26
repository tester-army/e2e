/** The home page and the plain control pages most suites open. */

import { constant, type PageRenderer } from './page.ts';

export const HOME_PAGES: Record<string, PageRenderer> = {
  '/': constant(`<!doctype html>
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

  <label for="readonly">Readonly</label>
  <input id="readonly" readonly value="read-only value" />

  <div id="class-card" class="card active" data-extra="node-only" constructor="own">Card</div>
  <img id="fixture-image" src="/fixture.png" alt="Fixture" />

  <label for="focus-target">Focus target</label>
  <input id="focus-target" />

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
  <fieldset disabled>
    <legend>Fenced <button>Legend action</button></legend>
    <button>Fenced action</button>
  </fieldset>
  <div hidden>Hidden content</div>
  <svg data-testid="hidden-svg" width="40" height="40" style="visibility:hidden"><rect width="40" height="40"></rect></svg>
  <div data-testid="zero-box" style="width:0;height:0;overflow:hidden"><span>Clipped away</span></div>
  <details><summary>Folded</summary><button>Inside folded details</button></details>
  <div data-testid="empty-contents" style="display:contents"></div>
  <div data-testid="painted-contents" style="display:contents"><span>Laid out by contents</span></div>
  <button aria-expanded="false" id="menu" onclick="this.setAttribute('aria-expanded', this.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')">Menu</button>

  <ul data-testid="items">
    <li data-testid="item">Item Alpha</li>
    <li data-testid="item">Item Beta</li>
    <li data-testid="item">Item Gamma</li>
  </ul>
  <span>Duplicated</span>
  <span>Duplicated</span>

  <input id="prefilled" aria-label="Prefilled" value="hello-value" />
  <textarea id="notes" aria-label="Notes">line1

line2  </textarea>

  <script>
    setTimeout(() => {
      const late = document.createElement('button');
      late.textContent = 'Late arrival';
      document.body.appendChild(late);
    }, 400);
  </script>
</body>
</html>`),
  // Composite widgets under the roles a ported Playwright test names.
  '/roles': constant(`<!doctype html>
<html>
<head><title>Roles</title></head>
<body>
  <h1>Roles</h1>
  <img id="logo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40" alt="Fixture logo" />
  <div role="img" aria-label="Sales chart" style="width:80px;height:40px;background:#ccc"></div>
  <div role="tablist" aria-label="Filter">
    <button role="tab" aria-selected="true" aria-controls="all-panel" id="all-tab">All</button>
    <button role="tab" aria-selected="false" aria-controls="open-panel" id="open-tab">Open</button>
  </div>
  <div role="tabpanel" id="all-panel" aria-labelledby="all-tab">Everything</div>
  <div role="toolbar" aria-label="Formatting">
    <button aria-pressed="false" onclick="this.setAttribute('aria-pressed', this.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')">Bold</button>
    <input type="number" aria-label="Font size" value="12" />
  </div>
  <button aria-haspopup="menu" aria-expanded="false" onclick="document.getElementById('view-menu').hidden = false; this.setAttribute('aria-expanded', 'true')">View</button>
  <div role="menu" id="view-menu" aria-label="View" hidden>
    <div role="menuitem" tabindex="0">Zoom in</div>
    <div role="menuitemcheckbox" aria-checked="true" tabindex="0">Show grid</div>
  </div>
  <progress aria-label="Upload" value="4" max="10"></progress>
  <fieldset><legend>Notifications</legend><input type="checkbox" aria-label="Email" /></fieldset>
  <form aria-label="Sign in"><input aria-label="User" /></form>
  <hr />
  <article aria-label="First post"><p>Body</p></article>
  <div role="switch" aria-checked="false" tabindex="0">Dark mode</div>
  <table><tr><th scope="col">Plan</th><td>Monthly</td></tr></table>
  <x-button role="button" tabindex="0"></x-button>
  <input type="reset" value="Clear form" />
  <input type="reset" />
  <script>
    document.querySelector('x-button').attachShadow({ mode: 'open' }).innerHTML = '<span>Shadow action</span>';
  </script>
</body>
</html>`),
  // Class assertions: a node that arrives late, duplicates, and the two
  // shapes of an empty class. Its own page so the late node never lands in
  // another suite's screen diff.
  '/classes': constant(`<!doctype html>
<html>
<head><title>Classes</title></head>
<body>
  <h1>Classes</h1>
  <span class="dup">Duplicated</span>
  <span class="dup">Duplicated</span>
  <div id="blank-card" class="">Blank</div>
  <ul data-testid="items"><li>Item</li></ul>
  <script>
    setTimeout(() => {
      const card = document.createElement('div');
      card.id = 'late-card';
      card.className = 'card late';
      card.textContent = 'Late card';
      document.body.appendChild(card);
    }, 600);
  </script>
</body>
</html>`),
  '/about': constant(`<!doctype html>
<html>
<head><title>About page</title></head>
<body>
  <h1>About</h1>
  <a href="/">Home</a>
</body>
</html>`),
  '/storage': constant(`<!doctype html>
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
</html>`),
  '/verbs': constant(`<!doctype html>
<html>
<head><title>Verbs playground</title></head>
<body>
  <h1>Verbs</h1>

  <label for="search">Search</label>
  <input id="search" type="search" onkeydown="if (event.key === 'Enter') document.getElementById('submitted').textContent = 'submitted:' + this.value" />
  <output id="submitted" aria-label="Submitted"></output>

  <label for="city">City</label>
  <input id="city" autocomplete="off" />
  <output id="keys" aria-label="Keys">0</output>
  <ul id="cities" aria-label="Cities"></ul>
  <script>
    // Suggestions render on key events only: a value set without keystrokes leaves the list empty.
    const CITIES = ['Warsaw', 'Wroclaw', 'Gdansk'];
    const city = document.getElementById('city');
    let keys = 0;
    city.addEventListener('keydown', () => {
      keys += 1;
      document.getElementById('keys').textContent = String(keys);
    });
    city.addEventListener('keyup', () => {
      const typed = city.value.toLowerCase();
      const list = document.getElementById('cities');
      list.replaceChildren();
      if (typed === '') return;
      for (const name of CITIES.filter((candidate) => candidate.toLowerCase().startsWith(typed))) {
        const item = document.createElement('li');
        item.textContent = name;
        list.appendChild(item);
      }
    });
  </script>

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
</html>`),
  // Rich-text editors: a bare contenteditable host named through
  // aria-labelledby, and one that also carries the explicit role Playwright's
  // role selector needs to find it.
  '/editor': constant(`<!doctype html>
<html>
<head><title>Editor</title></head>
<body>
  <h1>Editor</h1>
  <span id="notes-label">Notes</span>
  <div id="notes" contenteditable aria-labelledby="notes-label" data-testid="notes"><p><br></p></div>
  <span id="message-label">Message</span>
  <div id="message" contenteditable role="textbox" aria-labelledby="message-label" data-testid="message"><p><br></p></div>
  <span id="code-label">Code</span>
  <div id="code" contenteditable style="white-space: pre-wrap" aria-labelledby="code-label" data-testid="code">  keep spaces  </div>
</body>
</html>`),
  '/dialog': constant(`<!doctype html>
<html>
<head><title>Dialog page</title></head>
<body>
  <h1>Dialog</h1>
  <button onclick="document.getElementById('answer').textContent = confirm('Proceed?') ? 'accepted' : 'dismissed'">Ask</button>
  <output id="answer" aria-label="Answer"></output>
</body>
</html>`),
  '/flags': constant(`<!doctype html>
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
</html>`),
  // One `value` attribute on a password input, the same on a text input, and
  // a text input without one.
  '/value-attributes': constant(`<!doctype html>
<html>
<head><title>Value attributes</title></head>
<body>
  <input aria-label="Secret" type="password" value="marker-5e0c" />
  <input aria-label="Plain" type="text" value="marker-5e0c" />
  <input aria-label="Blank" type="text" />
</body>
</html>`),
  '/downloads': constant(
    '<!doctype html><html><head><title>Downloads</title></head><body><h1>Downloads</h1>' +
      '<a href="/report.csv" download>Download report</a></body></html>',
  ),
  // An export that carries what the form was filled with: the link downloads
  // a CSV echoing the key field, the way an app's export includes its data.
  '/exports': constant(`<!doctype html><html><head><title>Exports</title></head><body>
  <h1>Exports</h1>
  <label for="export-key">Export key</label>
  <input id="export-key" type="password" autocomplete="off" />
  <a id="export" href="/echo.csv" download>Download export</a>
  <script>
    document.getElementById('export').addEventListener('click', () => {
      const key = document.getElementById('export-key').value;
      document.getElementById('export').href = '/echo.csv?value=' + encodeURIComponent(key);
    });
  </script>
</body></html>`),
};
