/** Controls the tree cannot name or tell apart: unnamed fields, repeated buttons, moving twins. */

import { constant, type PageRenderer } from './page.ts';

/**
 * Three identical controls with nothing that names them or any ancestor: no test
 * id, no form `name`, plain divs all the way to `body`. The sweep can still pin
 * one by index, but there is no selector worth storing for it. A path counted
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
 * `?reverse=1`, or the `b` variant (`FixtureApp.setVariant`) under the plain
 * URL, serves the same three offers in the opposite order: a warm run replays
 * an entry recorded against a page whose rows have since reordered. An index
 * would land on the wrong offer; a selector anchored on the button's own name
 * does not.
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

/**
 * Controls a recording can only re-find by their place: two fields named by
 * placeholder alone, two textboxes with no name at all in one named group,
 * and three buttons sharing one label outside any row or list item. The
 * `b` variant (`?variant=b`, or `FixtureApp.setVariant`) prepends a
 * banner and swaps the two placeholder fields, so every node's id and
 * rectangle move while the counts and the unnamed order stay.
 */
function renderTwinsForm(variant: string | null): string {
  const moved = variant === 'b';
  const nickname = '    <input placeholder="Nickname" />';
  const motto = '    <input placeholder="Motto" />';
  const rows = ['one', 'two', 'three']
    .map((row, index) => `    <div><span>Row ${row}</span> <button onclick="pick(${String(index + 1)})">Add</button></div>`)
    .join('\n');
  return `<!doctype html>
<html>
<head><title>Twins form</title></head>
<body>
${moved ? '  <div role="note">Announcement: scheduled maintenance tonight</div>\n' : ''}  <h1>Twins form</h1>
  <div>
${moved ? `${motto}\n${nickname}` : `${nickname}\n${motto}`}
  </div>
  <fieldset>
    <legend>Codenames</legend>
    <div class="anon"><input /></div>
    <div class="anon"><input /></div>
  </fieldset>
${rows}
  <button onclick="summarize()">Submit</button>
  <output id="picked" role="status" aria-label="Picked">none</output>
  <output id="summary" role="status" aria-label="Summary">empty</output>
  <script>
    function pick(row) {
      document.getElementById('picked').textContent = String(row);
    }
    function summarize() {
      const value = (selector) => document.querySelector(selector).value;
      const anon = [...document.querySelectorAll('.anon input')].map((input) => input.value);
      document.getElementById('summary').textContent =
        'nickname=' + value('[placeholder="Nickname"]') + ' motto=' + value('[placeholder="Motto"]') +
        ' first=' + anon[0] + ' second=' + anon[1] + ' picked=' + document.getElementById('picked').textContent;
    }
  </script>
</body>
</html>`;
}

export const FORM_PAGES: Record<string, PageRenderer> = {
  // Clearing a field is a typed value too: the status reads `cleared` only
  // once the input emptied after holding text.
  '/clear-field': constant(`<!doctype html>
<html>
<head><title>Clear field</title></head>
<body>
  <h1>Clear field</h1>
  <input placeholder="Draft" oninput="document.getElementById('state').textContent = this.value === '' ? 'cleared' : 'typed'" />
  <output id="state" role="status" aria-label="Draft state">untouched</output>
</body>
</html>`),
  // Repeated cross-sell rows: several buttons share role, name, and test id, so
  // every derived query is ambiguous and nothing in the query vocabulary can
  // separate them. Only the reference the model selected can.
  '/rows': constant(`<!doctype html>
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
</html>`),
  // Controls a real page routinely ships and no query vocabulary can name: the
  // label is a sibling table cell rather than a `<label for>`, so every control
  // here has a role but no accessible name, no test id, no placeholder, and no
  // text. Derived queries come back empty, which used to fail the locate before
  // the reference or the platform selector ever got a turn.
  //
  // The three form controls carry a `name`, as a real form does, so the driver
  // derives an anchored selector for them and they resolve to locators. The
  // badge image carries nothing anchorable, so it can only be reached through
  // the observation's reference: the two rungs of the fallback, on one page.
  //
  // `#zone` is the other case: an empty painted rectangle, which no role, name,
  // or text can describe. `#spacer` is the same size with nothing painted, and
  // must stay out of the tree, otherwise the rule that admits drop zones admits
  // every layout div.
  '/unnamed': constant(`<!doctype html>
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
</html>`),
  // Two fields named by nothing: the label sits in a sibling cell, so each is
  // an unnamed textbox told from the other only by its position. The row text
  // beside them is a plain word that a model may well type into them, and
  // the status echoes what was typed so a deterministic check can follow.
  '/row-fields': constant(`<!doctype html>
<html>
<head><title>Row fields</title></head>
<body>
  <output id="filled" role="status" aria-label="Filled">nothing yet</output>
  <table>
    <tr><td>Row one</td><td><input type="text" oninput="render()" /></td></tr>
    <tr><td>Row two</td><td><input type="text" oninput="render()" /></td></tr>
  </table>
  <script>
    function render() {
      const values = [...document.querySelectorAll('input')].map((input) => input.value);
      document.getElementById('filled').textContent = values.every((value) => value !== '') ? values.join('+') : 'nothing yet';
    }
  </script>
</body>
</html>`),
  // A page that echoes what was typed, as a profile page shows a saved token:
  // as typed, under CSS case transforms, and in a <pre> that keeps line
  // breaks, so a reader's transformed or collapsed text holds the value in a
  // form other than the one filled.
  '/echo': constant(`<!doctype html>
<html>
<head><title>Echo</title></head>
<body>
  <label>Token <input id="token" type="text" oninput="render()" /></label>
  <label>Note <textarea id="note" oninput="render()"></textarea></label>
  <p data-testid="plain">nothing yet</p>
  <p data-testid="upper" style="text-transform: uppercase">nothing yet</p>
  <p data-testid="lower" style="text-transform: lowercase">nothing yet</p>
  <pre data-testid="note-echo">nothing yet</pre>
  <script>
    function render() {
      const token = document.getElementById('token').value;
      for (const id of ['plain', 'upper', 'lower']) {
        document.querySelector('[data-testid="' + id + '"]').textContent = token;
      }
      document.querySelector('[data-testid="note-echo"]').textContent = document.getElementById('note').value;
    }
  </script>
</body>
</html>`),
  '/unanchored': constant(UNANCHORED_PAGE),
  '/repeats': (_state, url) => renderRepeats(url.searchParams.get('reverse') === '1' || url.searchParams.get('variant') === 'b'),
  '/twins-form': (_state, url) => renderTwinsForm(url.searchParams.get('variant')),
};
