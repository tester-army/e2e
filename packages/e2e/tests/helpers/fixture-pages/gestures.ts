/** One target per grammar verb beyond tap and type. */

import { constant, type PageRenderer } from './page.ts';

export const GESTURE_PAGES: Record<string, PageRenderer> = {
  // A hover-revealed control, a right-click menu, long-press and double-tap
  // detection, a drag target, a checkbox, a file input, a memo field whose
  // selection the status echoes, and a footnote far below the fold. The hover trigger is pinned to a fixed box over nothing
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

  <label for="memo">Memo</label>
  <input id="memo" value="release approved" />

  <p>Page the ledger down to Row 333 and stop there.</p>
  <span>Jump to Row 333</span>
  <div id="ledger" role="list" aria-label="Ledger" style="position:relative;height:200px;overflow:auto;border:1px solid #000"><div id="ledger-spacer"></div></div>
  <output aria-label="Ledger state">golden out of view</output>
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
    // A windowed list: 400 rows of 40 px exist as data, and only the rows
    // inside the container's scrolled window are in the DOM, so the golden
    // row is nowhere in the tree until the list is paged down to it.
    const ROWS = 400, ROW_PX = 40, GOLDEN = 333;
    const ledger = document.getElementById('ledger');
    document.getElementById('ledger-spacer').style.height = ROWS * ROW_PX + 'px';
    const ledgerState = document.querySelector('output[aria-label="Ledger state"]');
    const renderLedger = () => {
      for (const row of ledger.querySelectorAll('[role="listitem"]')) row.remove();
      const first = Math.floor(ledger.scrollTop / ROW_PX);
      const last = Math.min(ROWS, Math.ceil((ledger.scrollTop + ledger.clientHeight) / ROW_PX));
      for (let index = first; index < last; index += 1) {
        const row = document.createElement('div');
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-label', 'Ledger row');
        row.style.cssText = 'position:absolute;left:0;right:0;height:' + ROW_PX + 'px;top:' + index * ROW_PX + 'px';
        row.textContent = index === GOLDEN ? 'Row ' + GOLDEN + ' · Golden' : 'Row ' + index;
        ledger.appendChild(row);
      }
      ledgerState.textContent = first <= GOLDEN && GOLDEN < last ? 'golden in view' : 'golden out of view';
    };
    ledger.addEventListener('scroll', renderLedger);
    renderLedger();
    const memo = document.getElementById('memo');
    // A click parks the caret at the end: Home and End scroll the page on macOS, so a flow cannot rely on them.
    memo.addEventListener('click', () => { memo.setSelectionRange(memo.value.length, memo.value.length); });
    memo.addEventListener('select', () => { state.textContent = 'selected: ' + memo.value.slice(memo.selectionStart, memo.selectionEnd); });
    const footnoteState = document.querySelector('output[aria-label="Footnote state"]');
    new IntersectionObserver((entries) => {
      footnoteState.textContent = entries[0].isIntersecting ? 'in view' : 'out of view';
    }).observe(document.getElementById('footnote'));
  </script>
</body>
</html>`),
};
