/** Playground app for dogfooding the e2e runner. No dependencies. */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4271);

const layout = (title, body) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 640px; }
    nav a { margin-right: 0.75rem; }
    li { margin: 0.25rem 0; }
    .done label { text-decoration: line-through; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <nav aria-label="Main">
    <a href="/">Home</a>
    <a href="/todos">Todos</a>
    <a href="/forms">Forms</a>
    <a href="/login">Login</a>
    <a href="/wizard">Wizard</a>
    <a href="/network">Network</a>
    <a href="/dialogs">Dialogs</a>
    <a href="/frames">Frames</a>
    <a href="/board">Board</a>
    <a href="/canvas">Canvas</a>
    <a href="/downloads">Downloads</a>
  </nav>
  ${body}
</body>
</html>`;

const pages = {
  '/': () =>
    layout(
      'Playground',
      `<h1>Playground</h1>
       <p>A tiny app exercised by the e2e dogfood suite.</p>`,
    ),

  '/todos': () =>
    layout(
      'Todos',
      `<h1>Todos</h1>
       <label for="new-todo">New todo</label>
       <input id="new-todo" placeholder="What needs doing?" />
       <button id="add">Add</button>

       <div role="tablist" aria-label="Filter">
         <button role="tab" aria-selected="true" data-filter="all">All</button>
         <button role="tab" aria-selected="false" data-filter="open">Open</button>
         <button role="tab" aria-selected="false" data-filter="done">Done</button>
       </div>

       <ul id="list" data-testid="todo-list"></ul>
       <output role="status" aria-label="Remaining"></output>

       <script>
         const load = () => JSON.parse(localStorage.getItem('todos') ?? '[]');
         const store = (todos) => localStorage.setItem('todos', JSON.stringify(todos));
         let filter = 'all';

         function render() {
           const todos = load();
           const list = document.getElementById('list');
           list.innerHTML = '';
           for (const [index, todo] of todos.entries()) {
             if (filter === 'open' && todo.done) continue;
             if (filter === 'done' && !todo.done) continue;
             const item = document.createElement('li');
             item.className = todo.done ? 'done' : '';
             item.setAttribute('data-testid', 'todo');
             const box = document.createElement('input');
             box.type = 'checkbox';
             box.id = 'todo-' + index;
             box.checked = todo.done;
             box.addEventListener('change', () => {
               const next = load();
               next[index].done = box.checked;
               store(next);
               render();
             });
             const label = document.createElement('label');
             label.htmlFor = box.id;
             label.textContent = todo.title;
             const remove = document.createElement('button');
             remove.textContent = 'Delete ' + todo.title;
             remove.addEventListener('click', () => {
               const next = load();
               next.splice(index, 1);
               store(next);
               render();
             });
             item.append(box, label, remove);
             list.append(item);
           }
           const open = load().filter((todo) => !todo.done).length;
           document.querySelector('output').textContent = open + ' remaining';
         }

         function add() {
           const input = document.getElementById('new-todo');
           const title = input.value.trim();
           if (title === '') return;
           store([...load(), { title, done: false }]);
           input.value = '';
           render();
         }

         document.getElementById('add').addEventListener('click', add);
         document.getElementById('new-todo').addEventListener('keydown', (event) => {
           if (event.key === 'Enter') add();
         });
         for (const tab of document.querySelectorAll('[role=tab]')) {
           tab.addEventListener('click', () => {
             for (const other of document.querySelectorAll('[role=tab]')) {
               other.setAttribute('aria-selected', String(other === tab));
             }
             filter = tab.dataset.filter;
             render();
           });
         }
         render();
       </script>`,
    ),

  '/forms': () =>
    layout(
      'Forms',
      `<h1>Forms</h1>
       <form id="profile">
         <label for="name">Full name</label>
         <input id="name" placeholder="Ada Lovelace" autocomplete="username" />

         <label for="bio">Bio</label>
         <textarea id="bio" placeholder="Tell us about yourself"></textarea>

         <label for="team">Team</label>
         <select id="team">
           <option value="platform">Platform</option>
           <option value="web">Web</option>
           <option value="mobile">Mobile</option>
         </select>

         <fieldset>
           <legend>Notifications</legend>
           <label for="email-notifications">Email notifications</label>
           <input id="email-notifications" type="checkbox" />
           <label for="digest">Weekly digest</label>
           <input id="digest" type="checkbox" checked />
         </fieldset>

         <button type="submit">Save profile</button>
       </form>
       <output role="status" aria-label="Save result"></output>
       <input aria-label="Prefilled field" value="prefilled-value" readonly />

       <script>
         document.getElementById('profile').addEventListener('submit', (event) => {
           event.preventDefault();
           const name = document.getElementById('name').value.trim();
           document.querySelector('output').textContent =
             name === '' ? 'Name is required' : 'Saved profile for ' + name;
         });
       </script>`,
    ),

  '/login': (request) =>
    layout(
      'Sign in',
      `<h1>Sign in</h1>
       ${request.failed === true ? '<p role="alert">Invalid credentials</p>' : ''}
       <form method="post" action="/login">
         <label for="username">Username</label>
         <input id="username" name="username" autocomplete="username" />
         <label for="password">Password</label>
         <input id="password" name="password" type="password" autocomplete="current-password" />
         <button type="submit">Sign in</button>
       </form>`,
    ),

  '/dashboard': (request) =>
    layout(
      'Dashboard',
      `<h1>Dashboard</h1>
       <p role="status" aria-label="Greeting">Welcome back, ${request.user}!</p>
       <a href="/logout">Sign out</a>`,
    ),

  '/wizard': () =>
    layout(
      'Wizard',
      `<h1>Workspace wizard</h1>
       <section id="step-1">
         <h2>Step 1: Name</h2>
         <label for="workspace">Workspace name</label>
         <input id="workspace" />
         <button data-next="2">Next</button>
       </section>
       <section id="step-2" hidden>
         <h2>Step 2: Plan</h2>
         <label for="plan">Plan</label>
         <select id="plan">
           <option>Free</option>
           <option>Pro</option>
         </select>
         <button data-next="3">Next</button>
       </section>
       <section id="step-3" hidden>
         <h2>Step 3: Confirm</h2>
         <button id="create">Create workspace</button>
         <output role="status" aria-label="Summary"></output>
       </section>

       <script>
         for (const button of document.querySelectorAll('[data-next]')) {
           button.addEventListener('click', () => {
             for (const section of document.querySelectorAll('section')) section.hidden = true;
             document.getElementById('step-' + button.dataset.next).hidden = false;
           });
         }
         document.getElementById('create').addEventListener('click', () => {
           const name = document.getElementById('workspace').value;
           const plan = document.getElementById('plan').value;
           document.querySelector('output').textContent =
             'Created "' + name + '" on the ' + plan + ' plan';
         });
       </script>`,
    ),

  '/network': () =>
    layout(
      'Network',
      `<h1>Network</h1>
       <button id="load">Load users</button>
       <ul id="users"></ul>
       <output role="status" aria-label="Network state">idle</output>

       <script>
         document.getElementById('load').addEventListener('click', async () => {
           const state = document.querySelector('output');
           state.textContent = 'loading';
           try {
             const response = await fetch('/api/users');
             if (!response.ok) throw new Error('HTTP ' + response.status);
             const users = await response.json();
             const list = document.getElementById('users');
             list.innerHTML = '';
             for (const user of users) {
               const item = document.createElement('li');
               item.textContent = user.name;
               list.append(item);
             }
             state.textContent = 'loaded ' + users.length;
           } catch {
             state.textContent = 'failed';
           }
         });
       </script>`,
    ),

  '/dialogs': () =>
    layout(
      'Dialogs',
      `<h1>Dialogs</h1>
       <button id="confirm">Delete everything</button>
       <output role="status" aria-label="Decision"></output>
       <script>
         document.getElementById('confirm').addEventListener('click', () => {
           const accepted = confirm('Really delete everything?');
           document.querySelector('output').textContent = accepted ? 'deleted' : 'kept';
         });
       </script>`,
    ),

  '/board': () =>
    layout(
      'Board',
      `<h1>Board</h1>

       <label for="board-search">Search cards</label>
       <input id="board-search" type="search" />
       <output aria-label="Search state">idle</output>

       <div id="card-menu">Card actions</div>
       <button id="archive" hidden>Archive card</button>

       <ul aria-label="Todo column">
         <li id="card" draggable="true">Design review</li>
       </ul>
       <section id="done" aria-label="Done column">Done column</section>
       <output aria-label="Board state">Design review is in todo</output>

       <label for="attachment">Attachment</label>
       <input id="attachment" type="file" />
       <output aria-label="Attachment state">none</output>

       <script>
         const boardState = document.querySelector('output[aria-label="Board state"]');
         document.getElementById('board-search').addEventListener('keydown', (event) => {
           if (event.key !== 'Enter') return;
           document.querySelector('output[aria-label="Search state"]').textContent =
             'searched: ' + event.target.value;
         });
         document.getElementById('card-menu').addEventListener('mouseenter', () => {
           document.getElementById('archive').hidden = false;
         });
         document.getElementById('archive').addEventListener('click', () => {
           boardState.textContent = 'Design review is archived';
         });
         const done = document.getElementById('done');
         done.addEventListener('dragover', (event) => event.preventDefault());
         done.addEventListener('drop', (event) => {
           event.preventDefault();
           boardState.textContent = 'Design review is done';
         });
         document.getElementById('attachment').addEventListener('change', (event) => {
           document.querySelector('output[aria-label="Attachment state"]').textContent =
             event.target.files[0] ? event.target.files[0].name : 'none';
         });
       </script>`,
    ),

  '/frames': () =>
    layout(
      'Frames',
      `<h1>Frames</h1>
       <iframe id="editor" src="/frames/child" title="editor"></iframe>`,
    ),

  '/frames/child': () =>
    layout(
      'Editor frame',
      `<h2>Embedded editor</h2>
       <label for="note">Note</label>
       <input id="note" />
       <button id="save-note">Save note</button>
       <output role="status" aria-label="Note state">empty</output>
       <script>
         document.getElementById('save-note').addEventListener('click', () => {
           document.querySelector('output').textContent =
             'saved: ' + document.getElementById('note').value;
         });
       </script>`,
    ),

  // A canvas surface with no accessibility semantics whatsoever: the pins and
  // the bar chart exist only as pixels. Nothing here is reachable through the
  // semantic tree, so this page is what the vision tier is dogfooded against.
  '/canvas': () =>
    layout(
      'Canvas map',
      `<h1>Canvas map</h1>
       <p>Every control below is drawn, not marked up.</p>
       <canvas id="map" width="480" height="260"></canvas>
       <output id="picked" role="status" aria-label="Picked">nothing picked</output>
       <script>
         const canvas = document.getElementById('map');
         const context = canvas.getContext('2d');
         const pins = [
           { name: 'red', x: 360, y: 70, color: '#d92b2b' },
           { name: 'blue', x: 110, y: 190, color: '#2b56d9' },
         ];
         // An upward-trending bar chart, for judgment assertions about pixels.
         const bars = [30, 55, 70, 110, 150, 190];
         context.fillStyle = '#f4f4f5';
         context.fillRect(0, 0, 480, 260);
         context.fillStyle = '#9ca3af';
         bars.forEach((height, index) => {
           context.fillRect(24 + index * 34, 240 - height, 24, height);
         });
         for (const pin of pins) {
           context.fillStyle = pin.color;
           context.beginPath();
           context.arc(pin.x, pin.y, 16, 0, Math.PI * 2);
           context.fill();
         }
         canvas.addEventListener('click', (event) => {
           const box = canvas.getBoundingClientRect();
           const x = event.clientX - box.left;
           const y = event.clientY - box.top;
           const picked = pins.find(
             (pin) => Math.hypot(pin.x - x, pin.y - y) <= 20,
           );
           document.getElementById('picked').textContent = picked
             ? 'picked the ' + picked.name + ' pin'
             : 'missed at ' + Math.round(x) + ',' + Math.round(y);
         });
       </script>`,
    ),

  '/downloads': () =>
    layout(
      'Downloads',
      `<h1>Downloads</h1>
       <a href="/files/report.csv" download>Download report</a>`,
    ),

  '/release-notes': () =>
    layout(
      'Release notes',
      `<h1>Release notes</h1>
       <p>A page tall enough to require scrolling before the footer is reachable.</p>
       <ol data-testid="notes">
         ${Array.from({ length: 60 }, (_, index) => `<li>Change number ${index + 1}</li>`).join('\n')}
       </ol>
       <button id="acknowledge">Acknowledge release notes</button>
       <output role="status" aria-label="Acknowledgement">not acknowledged</output>
       <script>
         document.getElementById('acknowledge').addEventListener('click', () => {
           document.querySelector('output').textContent = 'acknowledged';
         });
       </script>`,
    ),
};

function parseCookies(request) {
  const header = request.headers.cookie ?? '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter((pair) => pair.length === 2),
  );
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const send = (status, headers, body) => {
    response.writeHead(status, headers);
    response.end(body);
  };
  const html = (body) => send(200, { 'content-type': 'text/html; charset=utf-8' }, body);

  if (url.pathname === '/api/users') {
    send(
      200,
      { 'content-type': 'application/json' },
      JSON.stringify([{ name: 'Ada' }, { name: 'Grace' }, { name: 'Margaret' }]),
    );
    return;
  }
  if (url.pathname === '/files/report.csv') {
    send(
      200,
      { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' },
      'id,name\n1,Ada\n2,Grace\n',
    );
    return;
  }
  if (url.pathname === '/login' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const params = new URLSearchParams(body);
    if (params.get('username') === 'admin' && params.get('password') === 'admin-pass') {
      send(303, { 'set-cookie': 'session=admin; Path=/; HttpOnly', location: '/dashboard' });
    } else {
      html(pages['/login']({ failed: true }));
    }
    return;
  }
  if (url.pathname === '/logout') {
    send(303, { 'set-cookie': 'session=; Path=/; Max-Age=0', location: '/login' });
    return;
  }
  if (url.pathname === '/dashboard') {
    const cookies = parseCookies(request);
    if (cookies.session !== 'admin') {
      send(303, { location: '/login' });
      return;
    }
    html(pages['/dashboard']({ user: 'admin' }));
    return;
  }

  const page = pages[url.pathname];
  if (page === undefined) {
    send(404, { 'content-type': 'text/plain' }, 'not found');
    return;
  }
  html(page({}));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`playground listening on http://127.0.0.1:${PORT}`);
});
