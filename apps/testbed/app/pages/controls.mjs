/**
 * Surfaces for the deterministic matchers and the fixtures around them: one
 * control per state the matchers read, a scroll page, the browser fixture's
 * own page, a counter for the speed floor, and the about page navigation
 * verbs land on.
 */

const nav = [
  { path: '/controls', label: 'Controls' },
  { path: '/scroll', label: 'Scroll' },
  { path: '/browser', label: 'Browser' },
  { path: '/speed', label: 'Speed' },
  { path: '/about', label: 'About' },
];

/** `count` fixed-height list slots labelled `label 1..count`; the scroll page's script paints each one's button once it is scrolled into view. */
const slots = (count, label, height) =>
  Array.from({ length: count }, (_, index) => `<li style="height: ${height}px" data-row="${label} ${index + 1}"></li>`).join('\n');

const pages = {
  // Every control state the deterministic matchers read, one control each:
  // an expanded toggle, a button that Prepare enables a second later, a
  // listbox, radios, a hidden twin, a context menu, a long-press and a
  // double-tap target, a key log, an attribute-rich link, and a footnote far
  // below.
  '/controls': () => ({
    title: 'Controls',
    body: `<h1>Controls</h1>

       <ul aria-label="Files">
         <li id="file">report.pdf</li>
       </ul>
       <menu id="file-menu" role="menu" aria-label="File actions" hidden>
         <li><button role="menuitem" id="rename">Rename</button></li>
         <li><button role="menuitem" id="trash">Move to trash</button></li>
       </menu>
       <output role="status" aria-label="File state">untouched</output>

       <button id="hold">Hold me</button>
       <button id="twice">Tap me twice</button>
       <output role="status" aria-label="Gesture state">none</output>

       <button id="details-toggle" aria-expanded="false" aria-controls="details">Details</button>
       <p id="details" hidden>The fine print.</p>

       <button id="prepare">Prepare</button>
       <button id="publish" disabled>Publish</button>

       <fieldset>
         <legend>Size</legend>
         <label><input type="radio" name="size" value="s" /> Small</label>
         <label><input type="radio" name="size" value="m" /> Medium</label>
         <label><input type="radio" name="size" value="l" /> Large</label>
       </fieldset>

       <label for="agree">Agree to terms</label>
       <input id="agree" type="checkbox" />

       <label for="color">Color</label>
       <select id="color" size="3">
         <option value="red">Red</option>
         <option value="green" selected>Green</option>
         <option value="blue">Blue</option>
       </select>

       <label for="coupon">Coupon</label>
       <input id="coupon" value="SAVE10" />

       <label for="first">First</label>
       <input id="first" />
       <label for="second">Second</label>
       <input id="second" />

       <label for="keys">Key log input</label>
       <input id="keys" />
       <output aria-label="Key log"></output>

       <a id="docs" href="/about" data-kind="external" aria-label="Documentation" class="link primary">Docs</a>

       <span data-testid="banner" hidden>Sale</span>
       <span data-testid="banner">Sale</span>

       <ul aria-label="Tickets">
         <li>Ticket A <span class="badge">urgent</span> <button>Close A</button></li>
         <li>Ticket B <button>Close B</button></li>
         <li>Ticket C <span class="badge">urgent</span></li>
       </ul>

       <label for="attachments">Attachments</label>
       <input id="attachments" type="file" multiple />
       <output aria-label="Attachments state">none</output>

       <div style="height: 3000px"></div>
       <p id="footnote">Footnote</p>
       <output aria-label="Footnote state">out of view</output>

       <script>
         const fileState = document.querySelector('output[aria-label="File state"]');
         const menu = document.getElementById('file-menu');
         document.getElementById('file').addEventListener('contextmenu', (event) => {
           event.preventDefault();
           menu.hidden = false;
           fileState.textContent = 'menu open';
         });
         document.getElementById('rename').addEventListener('click', () => {
           menu.hidden = true;
           fileState.textContent = 'renamed';
         });
         document.getElementById('trash').addEventListener('click', () => {
           menu.hidden = true;
           fileState.textContent = 'trashed';
         });

         const gesture = document.querySelector('output[aria-label="Gesture state"]');
         let heldAt = 0;
         const hold = document.getElementById('hold');
         hold.addEventListener('pointerdown', () => {
           heldAt = performance.now();
         });
         hold.addEventListener('pointerup', () => {
           const held = Math.round(performance.now() - heldAt);
           gesture.textContent = held >= 500 ? 'long-pressed' : 'tapped';
         });
         document.getElementById('twice').addEventListener('dblclick', () => {
           gesture.textContent = 'double-tapped';
         });

         const toggle = document.getElementById('details-toggle');
         toggle.addEventListener('click', () => {
           const expanded = toggle.getAttribute('aria-expanded') === 'true';
           toggle.setAttribute('aria-expanded', String(!expanded));
           document.getElementById('details').hidden = expanded;
         });

         document.getElementById('prepare').addEventListener('click', () => {
           setTimeout(() => {
             document.getElementById('publish').disabled = false;
           }, 1000);
         });

         const keyLog = document.querySelector('output[aria-label="Key log"]');
         document.getElementById('keys').addEventListener('keydown', (event) => {
           const parts = [];
           if (event.ctrlKey) parts.push('Control');
           if (event.altKey) parts.push('Alt');
           if (event.shiftKey) parts.push('Shift');
           if (event.metaKey) parts.push('Meta');
           parts.push(event.key);
           keyLog.textContent = parts.join('+');
         });

         document.getElementById('attachments').addEventListener('change', (event) => {
           document.querySelector('output[aria-label="Attachments state"]').textContent =
             Array.from(event.target.files, (file) => file.name).join(', ') || 'none';
         });

         const footnoteState = document.querySelector('output[aria-label="Footnote state"]');
         new IntersectionObserver((entries) => {
           footnoteState.textContent = entries[0].isIntersecting ? 'in view' : 'out of view';
         }).observe(document.getElementById('footnote'));
       </script>`,
  }),

  // A scroll pane of its own and a long page, each reporting its scroll
  // offset: what scrollUntilVisible, node swipes, and a wheel gesture work
  // against. Rows paint only once scrolled into their scroll root, as a
  // windowed list renders: a row the browser lays out is visible to the
  // reader wherever it sits, so scrollUntilVisible would otherwise return
  // before scrolling at all.
  '/scroll': () => ({
    title: 'Scroll',
    body: `<h1>Scroll</h1>
       <output role="status" aria-label="Scroll position">0</output>
       <output role="status" aria-label="Pane position">0</output>
       <output role="status" aria-label="Picked row">none</output>
       <ul aria-label="Pane" style="height: 200px; overflow: auto; padding: 0; list-style: none">
         ${slots(40, 'Item', 40)}
       </ul>
       <ul aria-label="Rows" style="padding: 0; list-style: none">
         ${slots(120, 'Row', 60)}
       </ul>
       <script>
         const picked = document.querySelector('output[aria-label="Picked row"]');
         document.addEventListener('click', (event) => {
           if (event.target.tagName === 'BUTTON') picked.textContent = 'picked ' + event.target.textContent;
         });
         const position = document.querySelector('output[aria-label="Scroll position"]');
         addEventListener('scroll', () => {
           position.textContent = String(Math.round(scrollY));
         });
         const pane = document.querySelector('ul[aria-label="Pane"]');
         const panePosition = document.querySelector('output[aria-label="Pane position"]');
         pane.addEventListener('scroll', () => {
           panePosition.textContent = String(Math.round(pane.scrollTop));
         });
         const reveal = (list, root) => {
           const observer = new IntersectionObserver((entries) => {
             for (const entry of entries) {
               if (!entry.isIntersecting) continue;
               const button = document.createElement('button');
               button.textContent = entry.target.dataset.row;
               entry.target.replaceChildren(button);
               observer.unobserve(entry.target);
             }
           }, { root });
           for (const slot of list.children) observer.observe(slot);
         };
         reveal(pane, pane);
         reveal(document.querySelector('ul[aria-label="Rows"]'), null);
       </script>`,
  }),

  // The browser fixture's own surface: navigation with a delay, the viewport
  // size, the cookies the page sees, and a load counter for reload.
  '/browser': () => ({
    title: 'Browser',
    body: `<h1>Browser</h1>
       <button id="go-about">Go to about, soon</button>
       <output aria-label="Viewport"></output>
       <output aria-label="Cookies"></output>
       <output aria-label="Loads"></output>
       <output aria-label="Random"></output>
       <script>
         document.getElementById('go-about').addEventListener('click', () => {
           setTimeout(() => {
             location.assign('/about');
           }, 400);
         });
         const viewport = document.querySelector('output[aria-label="Viewport"]');
         const report = () => {
           viewport.textContent = innerWidth + 'x' + innerHeight;
         };
         addEventListener('resize', report);
         report();
         document.querySelector('output[aria-label="Cookies"]').textContent = document.cookie || 'no cookies';
         const loads = Number(sessionStorage.getItem('loads') ?? '0') + 1;
         sessionStorage.setItem('loads', String(loads));
         document.querySelector('output[aria-label="Loads"]').textContent = 'loads: ' + loads;
         document.querySelector('output[aria-label="Random"]').textContent = 'random: ' + (Math.random() === 0.5 ? 'seeded' : 'unseeded');
       </script>`,
  }),

  // A counter with nothing to wait for: the floor of what one deterministic
  // action costs, which the speed suite measures.
  '/speed': () => ({
    title: 'Speed',
    body: `<h1>Speed</h1>
       <button id="increment">Increment</button>
       <output role="status" aria-label="Count">0</output>
       <label for="echo">Echo</label>
       <input id="echo" />
       <output role="status" aria-label="Echoed"></output>
       <script>
         let count = 0;
         document.getElementById('increment').addEventListener('click', () => {
           count += 1;
           document.querySelector('output[aria-label="Count"]').textContent = String(count);
         });
         document.getElementById('echo').addEventListener('input', (event) => {
           document.querySelector('output[aria-label="Echoed"]').textContent = event.target.value;
         });
       </script>`,
  }),

  '/about': () => ({
    title: 'About page',
    body: `<h1>About</h1>
       <p>The playground, described.</p>`,
  }),
};

/** This group's routes and the nav entries it contributes, in order. */
export const controls = { nav, pages };
