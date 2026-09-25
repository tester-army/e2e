/**
 * Pages where the runner talks to the browser rather than the DOM: a fetch
 * the network verbs intercept, a native confirm, a board with hover, drag,
 * and upload targets, a pointer pad, and an iframe with its child document.
 */

const nav = [
  { path: '/network', label: 'Network' },
  { path: '/dialogs', label: 'Dialogs' },
  { path: '/board', label: 'Board' },
  { path: '/pointer', label: 'Pointer' },
  { path: '/frames', label: 'Frames' },
];

const pages = {
  '/network': () => ({
    title: 'Network',
    body: `<h1>Network</h1>
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
  }),

  '/dialogs': () => ({
    title: 'Dialogs',
    body: `<h1>Dialogs</h1>
       <button id="confirm">Delete everything</button>
       <output role="status" aria-label="Decision"></output>
       <script>
         document.getElementById('confirm').addEventListener('click', () => {
           const accepted = confirm('Really delete everything?');
           document.querySelector('output').textContent = accepted ? 'deleted' : 'kept';
         });
       </script>`,
  }),

  '/board': () => ({
    title: 'Board',
    body: `<h1>Board</h1>

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
  }),

  // Coordinate input: a pad that reports where a tap landed relative to its
  // own top-left corner, and where a swipe went down and lifted.
  '/pointer': () => ({
    title: 'Pointer',
    body: `<h1>Pointer</h1>
       <div id="pad" role="img" aria-label="Pointer pad" style="width: 320px; height: 200px; background: #e5e7eb; touch-action: none;"></div>
       <output aria-label="Pad state">untouched</output>
       <div aria-label="Hidden pad" hidden>never shown</div>
       <script>
         const pad = document.getElementById('pad');
         const padState = document.querySelector('output[aria-label="Pad state"]');
         const local = (event) => {
           const box = pad.getBoundingClientRect();
           return Math.round(event.clientX - box.left) + ',' + Math.round(event.clientY - box.top);
         };
         let downAt = null;
         let swiped = false;
         pad.addEventListener('pointerdown', (event) => {
           downAt = local(event);
           swiped = false;
         });
         pad.addEventListener('pointerup', (event) => {
           const upAt = local(event);
           if (downAt !== null && upAt !== downAt) {
             swiped = true;
             padState.textContent = 'swiped from ' + downAt + ' to ' + upAt;
           }
           downAt = null;
         });
         pad.addEventListener('click', (event) => {
           if (!swiped) padState.textContent = 'tapped at ' + local(event);
         });
       </script>`,
  }),

  '/frames': () => ({
    title: 'Frames',
    body: `<h1>Frames</h1>
       <iframe id="editor" src="/frames/child" title="editor"></iframe>`,
  }),

  '/frames/child': () => ({
    title: 'Editor frame',
    body: `<h2>Embedded editor</h2>
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
  }),
};

/** This group's routes and the nav entries it contributes, in order. */
export const interaction = { nav, pages };
