/**
 * Pages the cross-check reads on every `pnpm test`. Each one packs one
 * family of HTML and ARIA semantics the tree maps, so a change to the reader
 * that moves any node away from Chrome or Playwright shows up as a line in
 * `expected.txt`. Add a page for a bug when the family is not here yet.
 */

export interface FixturePage {
  readonly name: string;
  readonly html: string;
}

export const FIXTURE_PAGES: readonly FixturePage[] = [
  {
    name: 'shadow section landmarks',
    html: `
      <article><div id="article-shadow"></div></article>
      <div role="region" aria-label="News"><div id="region-shadow"></div></div>
      <div id="page-shadow"></div>
      <script>
        for (const id of ['article-shadow', 'region-shadow', 'page-shadow']) {
          const root = document.getElementById(id).attachShadow({ mode: 'open' });
          root.innerHTML = '<div></div>';
          root.firstElementChild.attachShadow({ mode: 'open' }).innerHTML =
            '<header aria-label="' + id + ' header">Heading</header><footer aria-label="' + id + ' footer">Footer</footer>';
        }
      </script>
    `,
  },
  {
    name: 'inferred table headers',
    html: `
      <table><tr><th>Item</th><td>Value</td></tr></table>
      <table><tr><td>Value</td><th>Last item</th></tr></table>
      <table><tr><th>Column</th><th>Other column</th></tr></table>
      <table><tr><th scope="col">Explicit column</th><td>Value</td></tr></table>
      <table><tr><th scope="row">Explicit row</th><th>Column</th></tr></table>
    `,
  },
  {
    name: 'role fallback tokens',
    html: `
      <button role="unknown button">Save</button>
      <button role="unknown widget">Submit</button>
      <a href="/next" role="unknown button link">Continue</a>
      <div role="unknown img" aria-label="Chart" style="width:10px;height:10px"></div>
      <div role="unknown\u00a0button" aria-label="Not a role" style="width:10px;height:10px"></div>
      <table role="unknown grid"><tr><td>Cell</td></tr></table>
    `,
  },
  {
    name: 'boolean attribute casing',
    html: `
      <div role="tablist"><button role="tab" aria-selected="TRUE">All</button><button role="tab" aria-selected="TrUe">Recent</button><button role="tab" aria-selected="FALSE">Archived</button></div>
      <div aria-hidden="TRUE"><button aria-hidden="false">Hidden action</button></div>
      <button>Save<span aria-hidden="TrUe"> decoration</span></button>
      <button aria-hidden="FALSE">Shown</button>
      <button aria-labelledby="upper-reference">Fallback</button>
      <div aria-hidden="TRUE"><span id="upper-reference">Label <i style="display:none">whole</i></span></div>
      <div role="button">Pick <div role="listbox"><div role="option" aria-selected="true">Chosen</div><div role="option" aria-selected="false">Other</div></div></div>
    `,
  },
  {
    name: 'inputs',
    html: `
      <label>Full name <input type="text"></label>
      <label for="mail">Email</label><input id="mail" type="email">
      <input type="search" placeholder="Search products">
      <input type="password" aria-label="Password">
      <input type="number" aria-label="Quantity" value="2">
      <input type="range" aria-label="Volume" min="0" max="10" value="3">
      <input type="date" aria-label="Start date">
      <input type="color" aria-label="Accent colour">
      <input type="file" aria-label="Attachments">
      <input type="tel" title="Phone">
      <input type="url" placeholder="https://example.test">
      <textarea aria-label="Notes"></textarea>
      <select aria-label="Size"><option>Small</option><option selected>Medium</option></select>
      <select aria-label="Toppings" multiple><option>Cheese</option><option selected>Olives</option></select>
      <select aria-label="Shade" size="3"><option>Red</option><option selected>Green</option><option>Blue</option></select>
      <input aria-label="Destination" list="cities"><datalist id="cities"><option>Oslo</option><option>Lima</option></datalist>
      <input type="custom" aria-label="Origin" list="cities">
      <input type="hidden" value="secret">
    `,
  },
  {
    name: 'buttons and links',
    html: `
      <button>Save</button>
      <button aria-label="Close dialog">×</button>
      <input type="submit" value="Send">
      <input type="reset">
      <input type="button" value="Preview">
      <input type="image" alt="Go" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7">
      <a href="/pricing">Pricing</a>
      <a>Not a link</a>
      <a href="/docs" aria-label="Documentation"><svg width="10" height="10"></svg></a>
      <div role="button" tabindex="0">Custom action</div>
      <button aria-pressed="true">Bold</button>
      <button aria-pressed="false">Italic</button>
    `,
  },
  {
    name: 'checked states',
    html: `
      <label><input type="checkbox" checked> Remember me</label>
      <label><input type="checkbox"> Subscribe</label>
      <label><input type="radio" name="plan" checked> Monthly</label>
      <label><input type="radio" name="plan"> Yearly</label>
      <div role="checkbox" aria-checked="true" tabindex="0">Custom agree</div>
      <div role="switch" aria-checked="false" tabindex="0">Dark mode</div>
      <div role="radio" aria-checked="true" tabindex="0">Custom option</div>
      <label><input type="checkbox" aria-checked="false" checked> Native wins</label>
    `,
  },
  {
    name: 'disabled states',
    html: `
      <button disabled>Disabled native</button>
      <button aria-disabled="true">Disabled by aria</button>
      <fieldset disabled><legend>Shipping</legend><input aria-label="Street"><button>Inside fieldset</button></fieldset>
      <div aria-disabled="true"><button>Under aria-disabled</button></div>
      <select disabled aria-label="Country"><option>Poland</option></select>
      <input disabled aria-label="Locked field">
    `,
  },
  {
    name: 'expanded and selected',
    html: `
      <details open><summary>Open details</summary><p>Body</p></details>
      <details><summary>Closed details</summary><p>Hidden body</p></details>
      <button aria-expanded="true" aria-controls="m">Menu</button>
      <ul id="m" role="menu"><li role="menuitem">Rename</li><li role="menuitemcheckbox" aria-checked="true">Pin</li></ul>
      <div role="tablist"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">Settings</button></div>
      <div role="tabpanel" aria-label="Overview panel">Panel</div>
      <div role="listbox" aria-label="Fruit"><div role="option" aria-selected="true">Apple</div><div role="option">Pear</div></div>
      <input role="combobox" aria-label="City" aria-expanded="false">
      <ul role="tree" aria-label="Files"><li role="treeitem" aria-expanded="true">src</li></ul>
    `,
  },
  {
    name: 'landmarks and headings',
    html: `
      <header>Site header</header>
      <nav aria-label="Primary"><a href="/">Home</a></nav>
      <main>
        <h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>
        <div role="heading" aria-level="4">Custom heading</div>
        <section aria-label="Promotions"><p>Sale</p></section>
        <section><p>Unnamed section</p></section>
        <form aria-label="Search form"><input aria-label="Query"></form>
        <article><h2>Post</h2></article>
        <aside>Related</aside>
      </main>
      <footer>Site footer</footer>
      <div role="alert">Saved</div>
      <div role="status">3 items</div>
      <output>42</output>
      <hr>
      <progress value="3" max="10" aria-label="Upload"></progress>
    `,
  },
  {
    name: 'tables and lists',
    html: `
      <table>
        <caption>Orders</caption>
        <thead><tr><th scope="col">Order</th><th scope="col">Total</th></tr></thead>
        <tbody><tr><th scope="row">#1</th><td>$10</td></tr><tr><td>#2</td><td>$20</td></tr></tbody>
      </table>
      <div role="grid" aria-label="Seats"><div role="row"><div role="gridcell">A1</div><div role="gridcell">A2</div></div></div>
      <table role="grid" aria-label="Schedule"><tr><td>Monday</td><td>Tuesday</td></tr></table>
      <table role=" grid" aria-label="Roster"><tr><td>Ada</td><td>Grace</td></tr></table>
      <div role=" button" tabindex="0">Padded role</div>
      <ul><li>First</li><li>Second <button>Remove</button></li></ul>
      <ol><li>Step one</li></ol>
      <menu><li>Menu entry</li></menu>
      <dl><dt>Term</dt><dd>Definition</dd></dl>
    `,
  },
  {
    name: 'names',
    html: `
      <span id="l1">Billing</span><span id="l2">address</span>
      <input aria-labelledby="l1 l2">
      <input aria-label="Wins over label" id="both"><label for="both">Loses</label>
      <button aria-describedby="d1">Delete</button><span id="d1">Permanently removes the file</span>
      <button title="Tooltip only"></button>
      <button><span title="Child tooltip"><svg width="10" height="10"></svg></span></button>
      <button><span title="Blockified tooltip" style="display:flex"><svg width="10" height="10"></svg></span></button>
      <button aria-labelledby="l3">Own text</button><span id="l3" title="Spaced reference"> </span>
      <button><img alt="Trash" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7"> Empty trash</button>
      <button>  Spaced   out   label  </button>
      <button><span aria-hidden="true">★</span> Star</button>
      <button><span style="display:none">Hidden</span>Visible</button>
      <label>Wrapped <select><option>One</option></select></label>
      <img alt="Company logo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7">
      <svg role="img" aria-label="Chart" width="10" height="10"></svg>
      <figure><img alt="Cat" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7"><figcaption>A cat</figcaption></figure>
    `,
  },
  {
    name: 'generated content',
    html: `
      <style>
        .arrow::before { content: "\\2192"; }
        .glyph::before { content: "\\f090"; }
        .badge::after { content: " new"; }
        .quiet::before { content: "\\2605" / ""; }
      </style>
      <button><i class="arrow"> Login</i></button>
      <button><i class="glyph"> Sign in</i></button>
      <a href="/inbox" class="badge">Inbox</a>
      <button class="quiet">Favourite</button>
      <a href="/exit" aria-label="Log out"><i class="glyph"></i></a>
      <a href="/leave" title="Sign out"><i class="glyph"></i></a>
    `,
  },
  {
    name: 'hidden content',
    html: `
      <button aria-hidden="true">Aria hidden</button>
      <button style="display:none">Display none</button>
      <button style="visibility:hidden">Visibility hidden</button>
      <button style="opacity:0">Transparent</button>
      <div hidden><button>Hidden attribute</button></div>
      <button style="position:absolute;left:-9999px">Off screen</button>
      <div inert><button>Inert</button></div>
      <button>Save <span inert>draft</span></button>
      <button>Shown</button>
    `,
  },
  {
    name: 'shadow and custom elements',
    html: `
      <open-card></open-card>
      <script>
        customElements.define('open-card', class extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: 'open' });
            root.innerHTML = '<label>Code <input></label><button>Apply</button><slot></slot>';
          }
        });
      </script>
      <div role="button" tabindex="0"><span>Nested</span> <b>content</b></div>
      <div contenteditable="true" aria-label="Editor">Hello</div>
    `,
  },
];
