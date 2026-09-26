/** Screens that keep changing after the page loads or after an action lands. */

import { constant, type PageRenderer } from './page.ts';

export const LIVE_PAGES: Record<string, PageRenderer> = {
  // Two identically named fields on a page whose layout keeps moving, the way a
  // lazily-loaded banner or an expanding summary shifts a booking form under the
  // cursor. Every node keeps its identity while its rectangle drifts between the
  // observation and the sweep that follows it, which is precisely what geometry
  // cannot survive: the coordinates the model saw name nothing by the time the
  // queries run.
  '/drift': constant(`<!doctype html>
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
</html>`),
  // A screen that changes a beat after the click, the way a client-side route
  // swaps the body once its fetch lands. The result of the tap has to show the
  // second view, not the first one the click was resolved against. The list
  // stays put so the change reads as a diff rather than a whole new screen.
  '/delayed': constant(`<!doctype html>
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
</html>`),
  // A list that remounts and rotates its rows the first time the pointer enters
  // them after every render, the way a live-updating list re-renders under
  // the cursor. Every tap on a handle from the last observation therefore
  // lands on a detached node once; the control itself, "Tap me", stays on
  // screen under a new element. Re-armed by each successful tap so all three
  // taps exercise the relocation. The trigger is the rows, not the document,
  // so a stray pointer move at the origin cannot disarm it before the tap.
  '/churn': constant(`<!doctype html>
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
</html>`),
  // A field a framework re-renders on every animation frame: the element is
  // swapped for an identical clone, so exactly one visible match is in the
  // document at any moment while every handle taken a frame earlier points at
  // a detached node. "Remove" takes the field out for good and stops the swap.
  '/replaced': constant(`<!doctype html>
<html>
<head><title>Replaced</title></head>
<body>
  <label>Nickname <input data-testid="nickname" value="ada"></label>
  <button id="remove">Remove</button>
  <script>
    let removed = false;
    const swap = () => {
      if (removed) return;
      const field = document.querySelector('[data-testid="nickname"]');
      const clone = field.cloneNode(true);
      clone.value = field.value;
      field.replaceWith(clone);
      requestAnimationFrame(swap);
    };
    requestAnimationFrame(swap);
    document.getElementById('remove').addEventListener('click', () => {
      removed = true;
      document.querySelector('[data-testid="nickname"]').remove();
    });
  </script>
</body>
</html>`),
};
