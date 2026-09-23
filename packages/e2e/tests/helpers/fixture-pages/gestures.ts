/** One target per grammar verb beyond tap and type. */

import { constant, type PageRenderer } from './page.ts';

export const GESTURE_PAGES: Record<string, PageRenderer> = {
  // A hover-revealed control, a right-click menu, long-press and double-tap
  // detection, a drag target, a checkbox, a file input, and a footnote far
  // below the fold. The hover trigger is pinned to a fixed box over nothing
  // else, so a bare-point hover at a known coordinate reaches it alone. It
  // sits away from the viewport origin: headless Chromium on Linux starts
  // its pointer at (0, 0), and a move within the box it already occupies
  // fires no mouseenter.
  '/gestures': constant(`<!doctype html>
<html>
<head><title>Gestures</title></head>
<body style="margin:0;padding:90px 16px 16px">
  <div id="account" style="position:fixed;left:40px;top:40px;width:200px;height:30px;line-height:30px;background:#eee">Account</div>
  <h1>Gestures</h1>
  <a href="/about">About</a>
  <output id="state" role="status" aria-label="Gesture state">idle</output>
  <button id="redeem" hidden>Redeem</button>

  <span id="file">report.pdf</span>
  <div id="file-menu" role="menu" aria-label="File actions" hidden><button id="rename" role="menuitem">Rename</button></div>

  <button id="hold">Hold me</button>
  <button id="twice">Tap me twice</button>

  <ul aria-label="Todo column"><li id="card" draggable="true">Design review</li></ul>
  <section id="done" aria-label="Done column" style="min-height:40px;border:1px solid #000">Done column</section>

  <label for="agree">Agree to terms</label>
  <input id="agree" type="checkbox" />

  <label for="attachment">Attachment</label>
  <input id="attachment" type="file" multiple />

  <div style="height:3000px"></div>
  <p id="footnote">Footnote</p>
  <output aria-label="Footnote state">out of view</output>
  <script>
    const state = document.getElementById('state');
    const redeem = document.getElementById('redeem');
    document.getElementById('account').addEventListener('mouseenter', () => { redeem.hidden = false; });
    redeem.addEventListener('click', () => { state.textContent = 'redeemed'; });
    const menu = document.getElementById('file-menu');
    document.getElementById('file').addEventListener('contextmenu', (event) => {
      event.preventDefault();
      menu.hidden = false;
      state.textContent = 'menu open';
    });
    document.getElementById('rename').addEventListener('click', () => { menu.hidden = true; state.textContent = 'renamed'; });
    let heldAt = 0;
    const hold = document.getElementById('hold');
    hold.addEventListener('pointerdown', () => { heldAt = performance.now(); });
    hold.addEventListener('pointerup', () => { state.textContent = performance.now() - heldAt >= 400 ? 'long-pressed' : 'tapped'; });
    document.getElementById('twice').addEventListener('dblclick', () => { state.textContent = 'double-tapped'; });
    const done = document.getElementById('done');
    done.addEventListener('dragover', (event) => event.preventDefault());
    done.addEventListener('drop', (event) => { event.preventDefault(); state.textContent = 'Design review is done'; });
    document.getElementById('agree').addEventListener('change', (event) => { state.textContent = 'agreed: ' + event.target.checked; });
    document.getElementById('attachment').addEventListener('change', (event) => {
      state.textContent = 'attached: ' + Array.from(event.target.files, (file) => file.name).join(', ');
    });
    const footnoteState = document.querySelector('output[aria-label="Footnote state"]');
    new IntersectionObserver((entries) => {
      footnoteState.textContent = entries[0].isIntersecting ? 'in view' : 'out of view';
    }).observe(document.getElementById('footnote'));
  </script>
</body>
</html>`),
};
