/**
 * Pixels-only surfaces: every control below is painted on a canvas and
 * nothing is marked up, so the agent's screenshot and tap_at tools are the
 * only way through. The DOM learns the outcome at the end, which is what the
 * paired deterministic assertion reads.
 */

const nav = [
  { path: '/canvas', label: 'Canvas' },
  { path: '/canvas-flow', label: 'Keypad' },
  { path: '/canvas-wizard', label: 'Canvas wizard' },
  { path: '/canvas-form', label: 'Canvas form' },
];

const pages = {
  // A canvas surface with no accessibility semantics whatsoever: the pins and
  // the bar chart exist only as pixels. Nothing here is reachable through the
  // semantic tree, so this page is what the vision tier is dogfooded against.
  '/canvas': () => ({
    title: 'Canvas map',
    body: `<h1>Canvas map</h1>
       <p>Every control below is drawn, not marked up.</p>
       <canvas id="map" width="480" height="260"></canvas>
       <output id="picked" role="status" aria-label="Picked">nothing picked</output>
       <script>
         const canvas = document.getElementById('map');
         const context = canvas.getContext('2d');
         const pins = [
           { name: 'red', x: 360, y: 70, color: '#d92b2b' },
           { name: 'blue', x: 110, y: 190, color: '#2b56d9' },
         ];
         // An upward-trending bar chart, for judgment assertions about pixels.
         const bars = [30, 55, 70, 110, 150, 190];
         context.fillStyle = '#f4f4f5';
         context.fillRect(0, 0, 480, 260);
         context.fillStyle = '#9ca3af';
         bars.forEach((height, index) => {
           context.fillRect(24 + index * 34, 240 - height, 24, height);
         });
         for (const pin of pins) {
           context.fillStyle = pin.color;
           context.beginPath();
           context.arc(pin.x, pin.y, 16, 0, Math.PI * 2);
           context.fill();
         }
         canvas.addEventListener('click', (event) => {
           const box = canvas.getBoundingClientRect();
           const x = event.clientX - box.left;
           const y = event.clientY - box.top;
           const picked = pins.find(
             (pin) => Math.hypot(pin.x - x, pin.y - y) <= 20,
           );
           document.getElementById('picked').textContent = picked
             ? 'picked the ' + picked.name + ' pin'
             : 'missed at ' + Math.round(x) + ',' + Math.round(y);
         });
       </script>`,
  }),

  // A long pixels-only flow: a drawn keypad whose every control and whose
  // feedback (the digits entered so far) exist only as canvas pixels. The DOM
  // learns the outcome only when the drawn OK button is pressed, so a run has
  // to see the canvas to make progress and the test can still assert the end.
  '/canvas-flow': () => ({
    title: 'Drawn keypad',
    body: `<h1>Drawn keypad</h1>
       <p>Everything below is painted on a canvas; nothing is marked up.</p>
       <canvas id="pad" width="420" height="560"></canvas>
       <output id="result" role="status" aria-label="Result">waiting</output>
       <script>
         const canvas = document.getElementById('pad');
         const context = canvas.getContext('2d');
         const keys = [];
         const labels = ['1','2','3','4','5','6','7','8','9','CLR','0','OK'];
         labels.forEach((label, index) => {
           const column = index % 3;
           const row = Math.floor(index / 3);
           keys.push({ label, x: 30 + column * 125, y: 120 + row * 105, w: 105, h: 85 });
         });
         let entered = '';
         function draw() {
           context.fillStyle = '#f4f4f5';
           context.fillRect(0, 0, 420, 560);
           context.fillStyle = '#111827';
           context.fillRect(30, 30, 355, 60);
           context.fillStyle = '#f9fafb';
           context.font = '32px monospace';
           context.textBaseline = 'middle';
           context.textAlign = 'left';
           context.fillText(entered === '' ? 'enter code' : entered, 45, 60);
           for (const key of keys) {
             context.fillStyle = key.label === 'OK' ? '#15803d' : key.label === 'CLR' ? '#b45309' : '#e5e7eb';
             context.fillRect(key.x, key.y, key.w, key.h);
             context.fillStyle = key.label === 'OK' || key.label === 'CLR' ? '#ffffff' : '#111827';
             context.font = 'bold 30px sans-serif';
             context.textAlign = 'center';
             context.fillText(key.label, key.x + key.w / 2, key.y + key.h / 2);
           }
         }
         draw();
         canvas.addEventListener('click', (event) => {
           const box = canvas.getBoundingClientRect();
           const x = event.clientX - box.left;
           const y = event.clientY - box.top;
           const key = keys.find((k) => x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h);
           if (!key) return;
           if (key.label === 'CLR') entered = '';
           else if (key.label === 'OK') {
             document.getElementById('result').textContent = 'code accepted: ' + entered;
           } else if (entered.length < 12) entered += key.label;
           draw();
         });
       </script>`,
  }),

  // A long pixels-only flow of a different shape: eight drawn screens, each
  // asking for one of four drawn shapes by colour and kind, with a drawn Next.
  // The model must read each new screen's instruction from pixels and track
  // which screen it is on; the DOM shows the picks only at the end.
  '/canvas-wizard': () => ({
    title: 'Drawn wizard',
    body: `<h1>Drawn wizard</h1>
       <p>Eight drawn screens; nothing below is marked up.</p>
       <canvas id="wiz" width="520" height="420"></canvas>
       <output id="wizard-result" role="status" aria-label="Wizard result">in progress</output>
       <script>
         const canvas = document.getElementById('wiz');
         const context = canvas.getContext('2d');
         const shapes = [
           { key: 'red-circle', color: '#d92b2b', kind: 'circle', label: 'red circle' },
           { key: 'blue-square', color: '#2b56d9', kind: 'square', label: 'blue square' },
           { key: 'green-triangle', color: '#15803d', kind: 'triangle', label: 'green triangle' },
           { key: 'orange-diamond', color: '#ea580c', kind: 'diamond', label: 'orange diamond' },
         ];
         // Which shape each screen asks for, and where the four shapes sit on it
         // (a rotation per screen, so a position memorised on one screen is wrong on the next).
         const asks = [2, 0, 3, 1, 1, 3, 0, 2];
         const slots = [ { x: 90, y: 200 }, { x: 210, y: 200 }, { x: 330, y: 200 }, { x: 450, y: 200 } ];
         let screen = 0;
         let picked = null;
         const picks = [];
         function order(index) { return shapes.map((_, i) => shapes[(i + index) % 4]); }
         function draw() {
           context.fillStyle = '#f4f4f5';
           context.fillRect(0, 0, 520, 420);
           context.fillStyle = '#111827';
           context.font = 'bold 22px sans-serif';
           context.textAlign = 'left';
           context.textBaseline = 'middle';
           context.fillText('Step ' + (screen + 1) + ' of 8: tap the ' + shapes[asks[screen]].label + ', then Next', 20, 40);
           const arranged = order(screen);
           arranged.forEach((shape, i) => {
             const { x, y } = slots[i];
             context.fillStyle = shape.color;
             context.beginPath();
             if (shape.kind === 'circle') context.arc(x, y, 36, 0, Math.PI * 2);
             else if (shape.kind === 'square') context.rect(x - 34, y - 34, 68, 68);
             else if (shape.kind === 'triangle') { context.moveTo(x, y - 38); context.lineTo(x + 40, y + 32); context.lineTo(x - 40, y + 32); context.closePath(); }
             else { context.moveTo(x, y - 40); context.lineTo(x + 40, y); context.lineTo(x, y + 40); context.lineTo(x - 40, y); context.closePath(); }
             context.fill();
             if (picked === shape.key) { context.lineWidth = 6; context.strokeStyle = '#111827'; context.stroke(); }
           });
           context.fillStyle = picked ? '#15803d' : '#9ca3af';
           context.fillRect(380, 330, 120, 60);
           context.fillStyle = '#ffffff';
           context.font = 'bold 26px sans-serif';
           context.textAlign = 'center';
           context.fillText('Next', 440, 360);
           context.fillStyle = '#374151';
           context.font = '18px sans-serif';
           context.textAlign = 'left';
           context.fillText(picked ? 'Selected: ' + shapes.find((s) => s.key === picked).label : 'Nothing selected', 20, 360);
         }
         draw();
         canvas.addEventListener('click', (event) => {
           if (screen >= 8) return;
           const box = canvas.getBoundingClientRect();
           const x = event.clientX - box.left;
           const y = event.clientY - box.top;
           if (x >= 380 && x <= 500 && y >= 330 && y <= 390) {
             if (!picked) return;
             picks.push(picked === shapes[asks[screen]].key ? 'ok' : 'wrong');
             picked = null;
             screen += 1;
             if (screen === 8) {
               document.getElementById('wizard-result').textContent = 'wizard done: ' + picks.join(',');
               context.fillStyle = '#f4f4f5'; context.fillRect(0, 0, 520, 420);
               context.fillStyle = '#111827'; context.font = 'bold 24px sans-serif'; context.textAlign = 'left';
               context.fillText('All eight steps done.', 20, 40);
               return;
             }
             draw();
             return;
           }
           const arranged = order(screen);
           const hit = arranged.findIndex((_, i) => Math.hypot(slots[i].x - x, slots[i].y - y) <= 42);
           if (hit >= 0) { picked = arranged[hit].key; draw(); }
         });
       </script>`,
  }),

  // A drawn form: two text fields and a submit button painted on a canvas.
  // Clicking a field focuses the canvas and makes that field active; keystrokes
  // go to the active field through the canvas's own keydown handler. Nothing
  // is marked up, so text can only arrive through a focused-field keyboard path.
  '/canvas-form': () => ({
    title: 'Drawn form',
    body: `<h1>Drawn form</h1>
       <p>Two fields and a button, all painted; nothing below is marked up.</p>
       <canvas id="form" width="480" height="300" tabindex="0" style="outline:none"></canvas>
       <output id="form-result" role="status" aria-label="Form result">unsubmitted</output>
       <script>
         const canvas = document.getElementById('form');
         const context = canvas.getContext('2d');
         const fields = [
           { label: 'Name', value: '', x: 40, y: 60, w: 400, h: 44 },
           { label: 'City', value: '', x: 40, y: 140, w: 400, h: 44 },
         ];
         const submit = { x: 40, y: 220, w: 160, h: 48 };
         let active = -1;
         function draw() {
           context.fillStyle = '#f4f4f5';
           context.fillRect(0, 0, 480, 300);
           context.textBaseline = 'middle';
           fields.forEach((field, index) => {
             context.fillStyle = '#111827';
             context.font = '16px sans-serif';
             context.textAlign = 'left';
             context.fillText(field.label, field.x, field.y - 14);
             context.fillStyle = '#ffffff';
             context.fillRect(field.x, field.y, field.w, field.h);
             context.lineWidth = index === active ? 3 : 1;
             context.strokeStyle = index === active ? '#2563eb' : '#9ca3af';
             context.strokeRect(field.x, field.y, field.w, field.h);
             context.fillStyle = '#111827';
             context.font = '20px monospace';
             context.fillText(field.value + (index === active ? '|' : ''), field.x + 10, field.y + field.h / 2);
           });
           context.fillStyle = '#15803d';
           context.fillRect(submit.x, submit.y, submit.w, submit.h);
           context.fillStyle = '#ffffff';
           context.font = 'bold 18px sans-serif';
           context.textAlign = 'center';
           context.fillText('Submit', submit.x + submit.w / 2, submit.y + submit.h / 2);
         }
         function inside(box, x, y) { return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h; }
         function submitForm() {
           document.getElementById('form-result').textContent =
             'submitted: name=' + fields[0].value + ' city=' + fields[1].value;
         }
         draw();
         canvas.addEventListener('click', (event) => {
           const box = canvas.getBoundingClientRect();
           const x = event.clientX - box.left;
           const y = event.clientY - box.top;
           const index = fields.findIndex((field) => inside(field, x, y));
           if (index >= 0) { active = index; canvas.focus(); }
           else if (inside(submit, x, y)) submitForm();
           draw();
         });
         let selected = false;
         canvas.addEventListener('keydown', (event) => {
           if (active < 0) return;
           event.preventDefault();
           const field = fields[active];
           if (event.key === 'Enter') submitForm();
           else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') selected = field.value !== '';
           else if (event.metaKey || event.ctrlKey || event.altKey) return;
           else if (event.key === 'Backspace' || event.key === 'Delete') {
             field.value = selected ? '' : field.value.slice(0, -1);
             selected = false;
           } else if (event.key === 'Tab') { active = (active + 1) % fields.length; selected = false; }
           else if (event.key.length === 1) {
             field.value = selected ? event.key : field.value + event.key;
             selected = false;
           }
           draw();
         });
         canvas.addEventListener('blur', () => { active = -1; draw(); });
       </script>`,
  }),
};

/** This group's routes and the nav entries it contributes, in order. */
export const canvas = { nav, pages };
