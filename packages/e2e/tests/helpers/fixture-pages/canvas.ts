/** Surfaces the semantic tree cannot describe: drawn pixels and pointer geometry. */

import { constant, type PageRenderer } from './page.ts';

/** A drawn map with two pins, and a Reset button under it when the tree should have one listed control. */
function canvasMap(options: { readonly reset: boolean }): string {
  const button = options.reset
    ? `  <button id="reset" style="position:fixed;left:0;top:260px;width:100px;height:30px">Reset</button>
  <input id="note" aria-label="Note" style="position:fixed;left:0;top:300px;width:200px;height:30px;margin:0;padding:0;border:1px solid #000">
  <div id="pad" role="application" aria-label="Pad" tabindex="0" style="position:fixed;left:0;top:380px;width:200px;height:30px;border:1px solid #000"></div>
  <select id="tint" aria-label="Tint" style="position:fixed;left:0;top:340px;width:200px;height:30px;margin:0">
    <option>plain</option><option>warm</option><option>cool</option>
  </select>
  <script>
    document.getElementById('reset').addEventListener('click', () => {
      document.getElementById('hit').textContent = 'reset';
    });
    document.getElementById('note').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') document.getElementById('hit').textContent = 'note: ' + event.target.value;
    });
    document.getElementById('tint').addEventListener('change', (event) => {
      document.getElementById('hit').textContent = 'tint: ' + event.target.value;
    });
    // A listed but unfillable widget: focusable, with its own key handling.
    let padText = '';
    document.getElementById('pad').addEventListener('keydown', (event) => {
      event.preventDefault();
      if (event.key === 'Enter') document.getElementById('hit').textContent = 'pad: ' + padText;
      else if (event.key.length === 1) padText += event.key;
    });
    // A drawn field: the canvas takes focus on click and collects keystrokes
    // itself, the way a canvas-rendered text input does. Nothing in the tree
    // is editable, so only the keyboard path can reach it.
    const map = document.getElementById('map');
    map.tabIndex = 0;
    map.contentEditable = 'true';
    map.style.outline = 'none';
    let drawn = '';
    map.addEventListener('keydown', (event) => {
      event.preventDefault();
      if (event.key === 'Enter') document.getElementById('hit').textContent = 'drawn: ' + drawn;
      else if (event.key.length === 1) drawn += event.key;
    });
  </script>
`
    : '';
  return `<!doctype html>
<html>
<head><title>${options.reset ? 'Canvas map' : 'Bare canvas map'}</title></head>
<body style="margin:0">
  <canvas id="map" width="400" height="200" style="position:fixed;left:0;top:0"></canvas>
  <output id="hit" role="status" aria-label="Hit" style="position:fixed;left:0;top:220px">none</output>
${button}  <script>
    const canvas = document.getElementById('map');
    const context = canvas.getContext('2d');
    context.fillStyle = '#dddddd';
    context.fillRect(0, 0, 400, 200);
    const pins = [
      { name: 'red', x: 300, y: 60, color: '#ff0000' },
      { name: 'blue', x: 80, y: 140, color: '#0000ff' },
    ];
    for (const pin of pins) {
      context.fillStyle = pin.color;
      context.beginPath();
      context.arc(pin.x, pin.y, 14, 0, Math.PI * 2);
      context.fill();
    }
    canvas.addEventListener('click', (event) => {
      const box = canvas.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      const pin = pins.find((candidate) => Math.hypot(candidate.x - x, candidate.y - y) <= 18);
      document.getElementById('hit').textContent =
        pin ? pin.name : 'miss at ' + Math.round(x) + ',' + Math.round(y);
    });
  </script>
</body>
</html>`;
}

export const CANVAS_PAGES: Record<string, PageRenderer> = {
  // A surface with no accessibility semantics at all: the pins exist only as
  // pixels, so the semantic tree cannot name either one and pointing is the
  // only way to reach them.
  '/canvas': constant(canvasMap({ reset: true })),
  // The same map with nothing the tree can act on: no button, no link. A
  // screen like this is "thin" to the agent, which then opens with a screenshot.
  '/canvas-bare': constant(canvasMap({ reset: false })),
  // Two controls the tree cannot tell apart: every query derived from either one
  // matches both, so a tree-only locate strands on LOCATOR_AMBIGUOUS. Only the
  // pixels distinguish them.
  // Two "Pick" buttons stacked at one rect, so no derived query and no index can
  // separate them: role, name, and geometry are all shared. That is what strands
  // a tree-only locate for good, rather than merely making it ambiguous.
  '/twins': constant(`<!doctype html>
<html>
<head><title>Twins</title></head>
<body style="margin:0">
  <canvas id="left" width="120" height="60" style="position:fixed;left:0;top:0"></canvas>
  <canvas id="right" width="120" height="60" style="position:fixed;left:200px;top:0"></canvas>
  <button style="position:fixed;left:0;top:80px;width:90px;height:24px">Pick</button>
  <button style="position:fixed;left:0;top:80px;width:90px;height:24px">Pick</button>
  <output id="picked" role="status" aria-label="Picked">none</output>
  <script>
    for (const [id, label] of [['left', 'L'], ['right', 'R']]) {
      const context = document.getElementById(id).getContext('2d');
      context.fillStyle = id === 'left' ? '#ff0000' : '#0000ff';
      context.fillRect(0, 0, 120, 60);
      context.fillStyle = '#ffffff';
      context.font = '32px sans-serif';
      context.fillText(label, 50, 42);
    }
    document.addEventListener('click', (event) => {
      const box = event.target.getBoundingClientRect();
      document.getElementById('picked').textContent = box.left < 100 ? 'left' : 'right';
    });
  </script>
</body>
</html>`),
  // Drag geometry. The near zone starts below the fold but can share a viewport
  // with the source once something scrolls; the far zone never can. A pointer
  // drag has to scroll for the first and refuse the second, because a pointer can
  // only be put at a coordinate that is on screen.
  '/drag-scroll': constant(`<!doctype html>
<html>
<head><title>Drag scroll</title></head>
<body style="margin:0">
  <output id="drops" role="status" aria-label="Drops" style="position:fixed;right:0;top:0">none</output>
  <img id="chip" data-testid="chip" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7"
       width="80" height="30" draggable="true" style="position:absolute;left:20px;top:200px"
       ondragstart="event.dataTransfer.setData('text', 'chip')" />
  <div id="near" style="position:absolute;left:20px;top:800px;width:200px;height:40px;border:1px solid #333"></div>
  <div id="far" style="position:absolute;left:20px;top:5000px;width:200px;height:40px;border:1px solid #333"></div>
  <div style="height:5200px"></div>
  <script>
    for (const id of ['near', 'far']) {
      const zone = document.getElementById(id);
      zone.addEventListener('dragover', (event) => event.preventDefault());
      zone.addEventListener('drop', (event) => {
        event.preventDefault();
        zone.appendChild(document.getElementById(event.dataTransfer.getData('text')));
        document.getElementById('drops').textContent = 'dropped on ' + id;
      });
    }
  </script>
</body>
</html>`),
};
