/**
 * The everyday pages: the landing page, a todo list kept in localStorage, a
 * profile form, the cookie-session login and the dashboard behind it, a
 * three-step wizard, and a checkout with one planted bug. What queries,
 * fills, sessions, polling assertions, and judgments are dogfooded against.
 */

const nav = [
  { path: '/', label: 'Home' },
  { path: '/todos', label: 'Todos' },
  { path: '/forms', label: 'Forms' },
  { path: '/login', label: 'Login' },
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/wizard', label: 'Wizard' },
  { path: '/checkout', label: 'Checkout' },
];

const pages = {
  '/': () => ({
    title: 'Playground',
    body: `<h1>Playground</h1>
       <p>A tiny app exercised by the e2e dogfood suite.</p>`,
  }),

  '/todos': () => ({
    title: 'Todos',
    body: `<h1>Todos</h1>
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
  }),

  '/forms': () => ({
    title: 'Forms',
    body: `<h1>Forms</h1>
       <form id="profile">
         <label for="name">Full name</label>
         <input id="name" placeholder="Ada Lovelace" autocomplete="username" />

         <label for="bio">Bio</label>
         <textarea id="bio" placeholder="Tell us about yourself"></textarea>

         <label for="city">City</label>
         <input id="city" autocomplete="off" />
         <ul id="city-suggestions" aria-label="City suggestions"></ul>

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
         // Search-as-you-type: suggestions render on keyup, so a value set
         // without key events leaves the list empty.
         const cities = ['Warsaw', 'Wroclaw', 'Gdansk', 'Krakow'];
         const city = document.getElementById('city');
         city.addEventListener('keyup', () => {
           const typed = city.value.toLowerCase();
           const list = document.getElementById('city-suggestions');
           list.replaceChildren();
           if (typed === '') return;
           for (const name of cities.filter((candidate) => candidate.toLowerCase().startsWith(typed))) {
             const item = document.createElement('li');
             item.textContent = name;
             list.appendChild(item);
           }
         });
       </script>`,
  }),

  '/login': (request) => ({
    title: 'Sign in',
    body: `<h1>Sign in</h1>
       ${request.failed === true ? '<p role="alert">Invalid credentials</p>' : ''}
       <form method="post" action="/login">
         <label for="username">Username</label>
         <input id="username" name="username" autocomplete="username" />
         <label for="password">Password</label>
         <input id="password" name="password" type="password" autocomplete="current-password" />
         <button type="submit">Sign in</button>
       </form>`,
  }),

  '/dashboard': (request) => ({
    title: 'Dashboard',
    body: `<h1>Dashboard</h1>
       <p role="status" aria-label="Greeting">Welcome back, ${request.user}!</p>
       <a href="/logout">Sign out</a>`,
  }),

  // Planted bug: the pay button keeps the total from page load, so after a
  // quantity change the summary and the button show different totals.
  '/checkout': () => ({
    title: 'Checkout',
    body: `<h1>Checkout</h1>
       <table aria-label="Cart">
         <thead><tr><th>Item</th><th>Price</th><th>Quantity</th><th>Line total</th></tr></thead>
         <tbody>
           <tr>
             <td>Notebook</td><td>$12.00</td>
             <td><input id="notebook-qty" type="number" min="1" value="1" aria-label="Notebook quantity" data-price="12" /></td>
             <td data-line>$12.00</td>
           </tr>
           <tr>
             <td>Pen</td><td>$3.00</td>
             <td><input id="pen-qty" type="number" min="1" value="2" aria-label="Pen quantity" data-price="3" /></td>
             <td data-line>$6.00</td>
           </tr>
         </tbody>
       </table>
       <section aria-label="Order summary">
         <h2>Order summary</h2>
         <p>Order total: <strong id="summary-total">$18.00</strong></p>
       </section>
       <button id="pay">Pay $18.00</button>

       <script>
         const money = (amount) => '$' + amount.toFixed(2);
         for (const input of document.querySelectorAll('input[data-price]')) {
           input.addEventListener('input', () => {
             let total = 0;
             for (const row of document.querySelectorAll('tbody tr')) {
               const qty = row.querySelector('input');
               const line = Number(qty.dataset.price) * Number(qty.value);
               row.querySelector('[data-line]').textContent = money(line);
               total += line;
             }
             document.getElementById('summary-total').textContent = money(total);
           });
         }
       </script>`,
  }),

  '/wizard': () => ({
    title: 'Wizard',
    body: `<h1>Workspace wizard</h1>
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
  }),
};

/** This group's routes and the nav entries it contributes, in order. */
export const basics = { nav, pages };
