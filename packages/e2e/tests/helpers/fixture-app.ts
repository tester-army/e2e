/** Static multi-page fixture app served over HTTP for integration tests. */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A drawn map with two pins, and a Reset button under it when the tree should have one listed control. */
function canvasMap(options: { readonly reset: boolean }): string {
  const button = options.reset
    ? `  <button id="reset" style="position:fixed;left:0;top:260px;width:100px;height:30px">Reset</button>
  <input id="note" aria-label="Note" style="position:fixed;left:0;top:300px;width:200px;height:30px;margin:0;padding:0;border:1px solid #000">
  <div id="pad" role="application" aria-label="Pad" tabindex="0" style="position:fixed;left:0;top:380px;width:200px;height:30px;border:1px solid #000"></div>
  <select id="tint" aria-label="Tint" style="position:fixed;left:0;top:340px;width:200px;height:30px;margin:0">
    <option>plain</option><option>warm</option><option>cool</option>
  </select>
  <script>
    document.getElementById('reset').addEventListener('click', () => {
      document.getElementById('hit').textContent = 'reset';
    });
    document.getElementById('note').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') document.getElementById('hit').textContent = 'note: ' + event.target.value;
    });
    document.getElementById('tint').addEventListener('change', (event) => {
      document.getElementById('hit').textContent = 'tint: ' + event.target.value;
    });
    // A listed but unfillable widget: focusable, with its own key handling.
    let padText = '';
    document.getElementById('pad').addEventListener('keydown', (event) => {
      event.preventDefault();
      if (event.key === 'Enter') document.getElementById('hit').textContent = 'pad: ' + padText;
      else if (event.key.length === 1) padText += event.key;
    });
    // A drawn field: the canvas takes focus on click and collects keystrokes
    // itself, the way a canvas-rendered text input does. Nothing in the tree
    // is editable, so only the keyboard path can reach it.
    const map = document.getElementById('map');
    map.tabIndex = 0;
    map.contentEditable = 'true';
    map.style.outline = 'none';
    let drawn = '';
    map.addEventListener('keydown', (event) => {
      event.preventDefault();
      if (event.key === 'Enter') document.getElementById('hit').textContent = 'drawn: ' + drawn;
      else if (event.key.length === 1) drawn += event.key;
    });
  </script>
`
    : '';
  return `<!doctype html>
<html>
<head><title>${options.reset ? 'Canvas map' : 'Bare canvas map'}</title></head>
<body style="margin:0">
  <canvas id="map" width="400" height="200" style="position:fixed;left:0;top:0"></canvas>
  <output id="hit" role="status" aria-label="Hit" style="position:fixed;left:0;top:220px">none</output>
${button}  <script>
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
</html>`;
}

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

  <label for="readonly">Readonly</label>
  <input id="readonly" readonly value="read-only value" />

  <div id="class-card" class="card active" data-extra="node-only">Card</div>
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
</html>`,
  // Composite widgets under the roles a ported Playwright test names.
  '/roles': `<!doctype html>
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
</html>`,
  '/frame': `<!doctype html>
<html>
<head><title>Frame host</title></head>
<body>
  <h1>Frame host</h1>
  <iframe id="child" src="/child" title="child"></iframe>
</body>
</html>`,
  // The frame-scoping trap: the control the agent wants is inside the frame, and
  // the outer document holds one element with the same role and the same `name`
  // attribute. A selector derived for the inner control resolves against the
  // outer document unless it is scoped to the frame, and the identity check
  // cannot tell them apart — neither has a name or text to compare.
  // Drag geometry. The near zone starts below the fold but can share a viewport
  // with the source once something scrolls; the far zone never can. A pointer
  // drag has to scroll for the first and refuse the second, because a pointer can
  // only be put at a coordinate that is on screen.
  '/drag-scroll': `<!doctype html>
<html>
<head><title>Drag scroll</title></head>
<body style="margin:0">
  <output id="drops" role="status" aria-label="Drops" style="position:fixed;right:0;top:0">none</output>
  <img id="chip" data-testid="chip" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7"
       width="80" height="30" draggable="true" style="position:absolute;left:20px;top:200px"
       ondragstart="event.dataTransfer.setData('text', 'chip')" />
  <div id="near" style="position:absolute;left:20px;top:800px;width:200px;height:40px;border:1px solid #333"></div>
  <div id="far" style="position:absolute;left:20px;top:5000px;width:200px;height:40px;border:1px solid #333"></div>
  <div style="height:5200px"></div>
  <script>
    for (const id of ['near', 'far']) {
      const zone = document.getElementById(id);
      zone.addEventListener('dragover', (event) => event.preventDefault());
      zone.addEventListener('drop', (event) => {
        event.preventDefault();
        zone.appendChild(document.getElementById(event.dataTransfer.getData('text')));
        document.getElementById('drops').textContent = 'dropped on ' + id;
      });
    }
  </script>
</body>
</html>`,
  '/frame-twin': `<!doctype html>
<html>
<head><title>Frame twin</title></head>
<body>
  <h1>Frame twin</h1>
  <output id="outer" role="status" aria-label="Outer">untouched</output>
  <table><tr><td>Decoy:</td><td>
    <input name="pin" type="text" oninput="document.getElementById('outer').textContent = 'outer typed'" />
  </td></tr></table>
  <iframe id="inner" src="/frame-twin-child" title="inner"></iframe>
</body>
</html>`,
  '/frame-twin-child': `<!doctype html>
<html>
<head><title>Frame twin child</title></head>
<body>
  <output id="inside" role="status" aria-label="Inside">untouched</output>
  <table><tr><td>Pin:</td><td>
    <input name="pin" type="text" oninput="document.getElementById('inside').textContent = 'inner typed'" />
  </td></tr></table>
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
  '/canvas': canvasMap({ reset: true }),
  // The same map with nothing the tree can act on: no button, no link. A
  // screen like this is "thin" to the agent, which then opens with a screenshot.
  '/canvas-bare': canvasMap({ reset: false }),
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
  // every derived query is ambiguous and nothing in the query vocabulary can
  // separate them. Only the reference the model selected can.
  '/rows': `<!doctype html>
<html>
<head><title>Rows</title></head>
<body>
  <output id="picked" role="status" aria-label="Picked">none</output>
  <div id="rows"></div>
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
  // Two identically named fields on a page whose layout keeps moving, the way a
  // lazily-loaded banner or an expanding summary shifts a booking form under the
  // cursor. Every node keeps its identity while its rectangle drifts between the
  // observation and the sweep that follows it, which is precisely what geometry
  // cannot survive: the coordinates the model saw name nothing by the time the
  // queries run.
  '/drift': `<!doctype html>
<html>
<head><title>Drift</title></head>
<body style="margin:0">
  <div id="pad" style="height:40px"></div>
  <label>Nazwisko <input data-testid="surname" id="one"></label>
  <div style="height:900px"></div>
  <label>Nazwisko <input data-testid="surname" id="two"></label>
  <script>
    // Bounded: the layout keeps moving across the observation and the sweep that
    // follows it, then settles, so what the assertion reads afterwards is a page
    // at rest rather than one still shifting under the matcher.
    let height = 40;
    const drift = setInterval(() => {
      height += 7;
      document.getElementById('pad').style.height = height + 'px';
      if (height > 600) clearInterval(drift);
    }, 40);
  </script>
</body>
</html>`,
  // Controls a real page routinely ships and no query vocabulary can name: the
  // label is a sibling table cell rather than a `<label for>`, so every control
  // here has a role but no accessible name, no test id, no placeholder, and no
  // text. Derived queries come back empty, which used to fail the locate before
  // the reference or the platform selector ever got a turn.
  //
  // The three form controls carry a `name`, as a real form does, so the driver
  // derives an anchored selector for them and they resolve to locators. The
  // badge image carries nothing anchorable, so it can only be reached through
  // the observation's reference — the two rungs of the fallback, on one page.
  //
  // `#zone` is the other case: an empty painted rectangle, which no role, name,
  // or text can describe. `#spacer` is the same size with nothing painted, and
  // must stay out of the tree — otherwise the rule that admits drop zones admits
  // every layout div.
  '/unnamed': `<!doctype html>
<html>
<head><title>Unnamed</title></head>
<body>
  <output id="state" role="status" aria-label="State">idle</output>
  <!-- A separate signal: the pointer drag ends with a click on the drop zone,
       so a shared output would report the tap and hide the drop. -->
  <output id="drops" role="status" aria-label="Drops">none</output>
  <table>
    <tr><td>Nickname:</td><td><input id="nickname" name="nickname" type="text" /></td></tr>
    <tr><td>Plan choice:</td><td>
      <select id="tier" name="tier" onchange="document.getElementById('state').textContent = this.value">
        <option value="free">Free tier</option>
        <option value="pro">Pro tier</option>
      </select>
    </td></tr>
    <tr><td>Pre-checked:</td><td><input id="flag" name="flag" type="checkbox" checked /></td></tr>
  </table>
  <div id="zone" style="width:200px;height:40px;border:1px solid #333"
       onclick="document.getElementById('state').textContent = 'zone tapped'"></div>
  <div id="spacer" style="width:200px;height:40px"></div>
  <img id="ticket" data-testid="ticket" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7"
       width="80" height="30" draggable="true"
       ondragstart="event.dataTransfer.setData('text', 'ticket')" />
  <img id="badge" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7"
       width="80" height="30" draggable="true"
       onclick="document.getElementById('state').textContent = 'badge tapped'"
       ondragstart="event.dataTransfer.setData('text', 'badge')" />
  <script>
    const zone = document.getElementById('zone');
    zone.addEventListener('dragover', (event) => event.preventDefault());
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.appendChild(document.getElementById(event.dataTransfer.getData('text')));
      document.getElementById('drops').textContent = 'dropped';
    });
  </script>
</body>
</html>`,
  // An open shadow root: the panel and its button exist only in the shadow tree,
  // so a walk over light-DOM children alone cannot see them, while the slotted
  // heading is light DOM the component merely renders.
  '/shadow': `<!doctype html>
<html>
<head><title>Shadow</title></head>
<body>
  <output id="picked" role="status" aria-label="Picked">none</output>
  <my-panel><h2 slot="title">Slotted title</h2></my-panel>
  <script>
    customElements.define('my-panel', class extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML =
          '<div id="panel"><slot name="title"></slot>' +
          '<button id="inner">Shadow action</button></div>';
        root.getElementById('inner').addEventListener('click', () => {
          document.getElementById('picked').textContent = 'shadow';
        });
      }
    });
  </script>
</body>
</html>`,
  // A frame the page writes itself. Its document has no network origin, so an
  // origin allowlist has nothing to match and used to exclude it — leaving the
  // agent a boundary node and no way in.
  '/data-frame': `<!doctype html>
<html>
<head><title>Data frame</title></head>
<body>
  <h1>Data frame host</h1>
  <iframe id="inline" title="inline" src="data:text/html,<body><label for=%22ok%22>Confirm</label><input id=%22ok%22 type=%22checkbox%22 /></body>"></iframe>
</body>
</html>`,
  // A screen that changes a beat after the click, the way a client-side route
  // swaps the body once its fetch lands. The result of the tap has to show the
  // second view, not the first one the click was resolved against. The list
  // stays put so the change reads as a diff rather than a whole new screen.
  '/delayed': `<!doctype html>
<html>
<head><title>Delayed</title></head>
<body>
  <h1>Delayed</h1>
  <ul>
    <li>Alpha</li><li>Beta</li><li>Gamma</li><li>Delta</li><li>Epsilon</li><li>Zeta</li><li>Eta</li><li>Theta</li>
  </ul>
  <div id="view">
    <p>First view</p>
    <button id="go">Continue</button>
    <button id="dead">Dead end</button>
  </div>
  <output id="mark" role="status" aria-label="Mark">idle</output>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      setTimeout(() => {
        const view = document.getElementById('view');
        view.replaceChildren();
        const heading = document.createElement('h2');
        heading.textContent = 'Second view';
        const finish = document.createElement('button');
        finish.textContent = 'Finish';
        finish.addEventListener('click', () => {
          document.getElementById('mark').textContent = 'finished';
        });
        view.append(heading, finish);
      }, 700);
    });
  </script>
</body>
</html>`,
  // A list that remounts and rotates its rows the first time the pointer enters
  // them after every render, the way a live-updating list re-renders under
  // the cursor. Every tap on a handle from the last observation therefore
  // lands on a detached node once; the control itself, "Tap me", stays on
  // screen under a new element. Re-armed by each successful tap so all three
  // taps exercise the relocation. The trigger is the rows, not the document,
  // so a stray pointer move at the origin cannot disarm it before the tap.
  '/churn': `<!doctype html>
<html>
<head><title>Churn</title></head>
<body>
  <h1>Churn</h1>
  <output id="progress" role="status" aria-label="Progress">0 / 3</output>
  <ul id="rows"></ul>
  <script>
    let armed = true;
    let rotation = 0;
    let taps = 0;
    const labels = ['Decoy one', 'Tap me', 'Decoy two'];
    function render() {
      const rows = document.getElementById('rows');
      rows.replaceChildren();
      for (let i = 0; i < labels.length; i += 1) {
        const label = labels[(i + rotation) % labels.length];
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.textContent = label;
        if (label === 'Tap me') {
          button.addEventListener('click', () => {
            taps += 1;
            armed = true;
            document.getElementById('progress').textContent = taps + ' / 3';
          });
        }
        li.append(button);
        rows.append(li);
      }
    }
    document.getElementById('rows').addEventListener('mouseover', () => {
      if (!armed) return;
      armed = false;
      rotation += 1;
      render();
    });
    render();
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
    if (pathname === '/downloads') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html><head><title>Downloads</title></head><body><h1>Downloads</h1>' +
          '<a href="/report.csv" download>Download report</a></body></html>',
      );
      return;
    }
    if (pathname === '/report.csv') {
      response.writeHead(200, {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="report.csv"',
      });
      response.end('id,total\n1,42\n');
      return;
    }
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
    if (pathname === '/hang') {
      // Never responds: exercises operation timeouts on a page that never
      // settles. The socket stays open until the client gives up.
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
