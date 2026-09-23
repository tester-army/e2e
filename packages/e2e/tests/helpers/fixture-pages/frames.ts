/** Document boundaries: frames, a frame the page writes itself, and a shadow root. */

import { constant, type PageRenderer } from './page.ts';

export const FRAME_PAGES: Record<string, PageRenderer> = {
  '/frame': constant(`<!doctype html>
<html>
<head><title>Frame host</title></head>
<body>
  <h1>Frame host</h1>
  <iframe id="child" src="/child" title="child"></iframe>
</body>
</html>`),
  '/frame-nested': constant(`<!doctype html>
<html>
<head><title>Nested frame host</title></head>
<body>
  <h1>Nested frame host</h1>
  <iframe id="outer" src="/frame" title="outer"></iframe>
</body>
</html>`),
  '/child': constant(`<!doctype html>
<html>
<head><title>Child frame</title></head>
<body>
  <button onclick="this.textContent = 'Frame clicked'">Frame button</button>
</body>
</html>`),
  // The frame-scoping trap: the control the agent wants is inside the frame, and
  // the outer document holds one element with the same role and the same `name`
  // attribute. A selector derived for the inner control resolves against the
  // outer document unless it is scoped to the frame, and the identity check
  // cannot tell them apart: neither has a name or text to compare.
  '/frame-twin': constant(`<!doctype html>
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
</html>`),
  '/frame-twin-child': constant(`<!doctype html>
<html>
<head><title>Frame twin child</title></head>
<body>
  <output id="inside" role="status" aria-label="Inside">untouched</output>
  <table><tr><td>Pin:</td><td>
    <input name="pin" type="text" oninput="document.getElementById('inside').textContent = 'inner typed'" />
  </td></tr></table>
</body>
</html>`),
  // A frame the page writes itself. Its document has no network origin, so an
  // origin allowlist has nothing to match and used to exclude it, leaving the
  // agent a boundary node and no way in.
  '/data-frame': constant(`<!doctype html>
<html>
<head><title>Data frame</title></head>
<body>
  <h1>Data frame host</h1>
  <iframe id="inline" title="inline" src="data:text/html,<body><label for=%22ok%22>Confirm</label><input id=%22ok%22 type=%22checkbox%22 /></body>"></iframe>
</body>
</html>`),
  // An open shadow root: the panel and its button exist only in the shadow tree,
  // so a walk over light-DOM children alone cannot see them, while the slotted
  // heading is light DOM the component merely renders.
  '/shadow': constant(`<!doctype html>
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
</html>`),
};
