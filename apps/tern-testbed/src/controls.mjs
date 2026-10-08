import { connect, html, ui } from '@stencil-hq/tern';

const session = await connect({ app: 'e2e-native-controls' });
if (!session) throw new Error('This fixture requires real native Tern; no plain-text substitute');
const surface = session.open({ id: 'controls', mode: 'inline', title: 'Native controls' });
let count = 0;
let value = '';
let subscribed = false;
let enabled = false;
function render() {
  surface.render(ui.col({ key: 'form' },
    html.h1({ key: 'title' }, 'Native controls'),
    ui.editor({ key: 'value', text: value, placeholder: 'Value', maxLines: 4, onEdit: (event) => {
      value = value.slice(0, event.from) + event.text + value.slice(event.to);
      render();
    } }),
    html.button({ key: 'increment', onClick: () => { count++; render(); } }, 'Increment'),
    ui.text({ key: 'count', text: `Count: ${count}` }),
    html.label({ key: 'subscribeLabel' }, 'Subscribe', html.input({ key: 'subscribe', type: 'checkbox', checked: subscribed, attrs: { 'aria-label': 'Subscribe' }, onClick: () => { subscribed = !subscribed; render(); } })),
    html.label({ key: 'enabledLabel' }, 'Enabled', html.input({ key: 'enabled', type: 'checkbox', checked: enabled, attrs: { role: 'switch', 'aria-label': 'Enabled' }, onClick: () => { enabled = !enabled; render(); } })),
    ui.meter({ key: 'effort', value: 0.5, label: 'Thinking effort', total: '100%' }),
    html.input({ key: 'disabled', type: 'checkbox', disabled: true, attrs: { 'aria-label': 'Disabled control' } }),
    ui.text({ key: 'hidden', text: 'Hidden sentinel', hidden: true }),
    html.label({ key: 'private' }, 'Protected', html.input({ key: 'secret', type: 'password', value: 'inert-secret-sentinel' })),
    html.label({ key: 'duplicateA' }, 'Duplicate', html.input({ key: 'inputA', type: 'text' })),
    html.label({ key: 'duplicateB' }, 'Duplicate', html.input({ key: 'inputB', type: 'text' })),
  ));
}
render();
try { for await (const input of session) { if (input.type === 'key' && input.key.name === 'escape') break; } }
finally { await session.close(); }
