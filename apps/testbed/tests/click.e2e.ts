/**
 * Adapted from microsoft/playwright tests/page/page-click.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `page.click(selector)` is a locator tap.
 *
 * Not ported:
 * - should click button inside frameset: needs element handles and Frame objects.
 * - should issue clicks in parallel in page and popup: needs `waitForEvent('popup')`.
 * - should select the text by triple clicking: no `clickCount`.
 * - should not wait with force: e2e tap has no force option.
 * - should click the button with fixed position inside an iframe: Playwright skips it on Chromium (`it.fixme(browserName === 'chromium')`).
 * - should click a very large button with offset: a `position` tap scrolls the node into view, not the offset point.
 * - should click a button in scrolling container with offset: same.
 * - should wait for becoming hit target with trial run: no `trial` option.
 * - trial run should work with short timeout: same.
 * - trial run should not click: same.
 * - trial run should not double click: same.
 * - should fail when obscured and not waiting for hit target: e2e tap has no force option.
 * - should report nice error when element is detached and force-clicked: needs element handles, and e2e tap has no force option.
 * - should fail when element detaches after animation: needs element handles.
 * - should fail when element is animating from outside the viewport with force: e2e tap has no force option.
 * - should not throw protocol error when navigating during the click: needs Playwright's `__testHookBeforeStable`.
 * - should retry when navigating during the click: same.
 * - should not hang when frame is detached: same, and needs Frame objects.
 * - should not retain removed iframe after clicking inside it: needs `page.requestGC`.
 * - should click in a transformed iframe with force: e2e tap has no force option.
 * - ensure events are dispatched in the individual tasks: needs `page.on('console')`.
 * - should click with tweened mouse movement: needs click `steps`.
 * - should abort via signal: needs `AbortSignal`.
 * - should throw an Error when aborted in-flight with a string reason: same.
 * - should abort via already-aborted signal: same.
 * - should throw an Error when aborted via an already-aborted signal with a string reason: same.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content, CROSS } from './helpers.ts';

/** Two animation frames and a task, Playwright's `rafraf`, so a pending tap has had its chance. */
const giveItAChanceToClick = '() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))))';

test.describe('page click', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should click the button', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.locator('button').tap();
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  test('should click svg', async ({ browser }) => {
    await browser.goto(content(`
      <svg height="100" width="100">
        <circle onclick="window.__CLICKED=42" cx="50" cy="50" r="40" stroke="black" stroke-width="3" fill="red" />
      </svg>
    `));
    await browser.locator('circle').tap();
    expect(await browser.evaluate('__CLICKED')).toBe(42);
  });

  test('should click the button if window.Node is removed', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.evaluate('() => { delete window.Node; }');
    await browser.locator('button').tap();
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  test('should click on a span with an inline element inside', async ({ browser }) => {
    await browser.goto(content(`
      <style>span::before { content: 'q'; }</style>
      <span onclick='window.CLICKED=42'></span>
    `));
    await browser.locator('span').tap();
    expect(await browser.evaluate('CLICKED')).toBe(42);
  });

  for (const [name, style] of [
    ['aligned', ''],
    ['half-aligned', 'margin-left: 20.5px; margin-top: 11.5px;'],
    ['unaligned v1', 'margin-left: 20.23px; margin-top: 11.65px;'],
    ['unaligned v2', 'margin-left: 20.68px; margin-top: 11.13px;'],
    ['unaligned v3', 'margin-left: 20.68px; margin-top: 11.52px;'],
    ['unaligned v4', 'margin-left: 20.15px; margin-top: 11.24px;'],
  ] as const) {
    test(`should click the ${name} 1x1 div`, async ({ browser }) => {
      await browser.goto(content(`<div style="${style} width: 1px; height: 1px;" onclick="window.__clicked = true"></div>`));
      await browser.locator('div').tap();
      expect(await browser.evaluate('window.__clicked')).toBe(true);
    });
  }

  test('should click the button after navigation', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.locator('button').tap();
    await browser.goto('/input/button.html');
    await browser.locator('button').tap();
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  test('should click the button after a cross origin navigation', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.locator('button').tap();
    await browser.goto(`${CROSS}/input/button.html`);
    await browser.locator('button').tap();
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  test('should click when one of inline box children is outside of viewport', async ({ browser }) => {
    await browser.goto(content(`
      <style>i { position: absolute; top: -1000px; }</style>
      <span onclick='window.CLICKED = 42;'><i>woof</i><b>doggo</b></span>
    `));
    await browser.locator('span').tap();
    expect(await browser.evaluate('CLICKED')).toBe(42);
  });

  test('should click offscreen buttons', async ({ browser }) => {
    await browser.goto('/offscreenbuttons.html');
    await browser.evaluate('() => { window.messages = []; console.log = (text) => window.messages.push(text); }');
    for (let index = 0; index < 11; ++index) {
      await browser.evaluate('() => window.scrollTo(0, 0)');
      await browser.locator(`#btn${index}`).tap();
    }
    expect(await browser.evaluate('messages')).toEqual(Array.from({ length: 11 }, (_, index) => `button #${index} clicked`));
  });

  test('should waitFor display:none to be gone', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.evaluate("() => { document.querySelector('button').style.display = 'none'; }");
    let done = false;
    const clicked = browser.locator('button').tap({ timeout: 0 }).then(() => (done = true));
    await browser.evaluate(giveItAChanceToClick);
    expect(await browser.evaluate('result')).toBe('Was not clicked');
    expect(done).toBe(false);
    await browser.evaluate("() => { document.querySelector('button').style.display = 'block'; }");
    await clicked;
    expect(done).toBe(true);
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  test('should waitFor visibility:hidden to be gone', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.evaluate("() => { document.querySelector('button').style.visibility = 'hidden'; }");
    let done = false;
    const clicked = browser.locator('button').tap({ timeout: 0 }).then(() => (done = true));
    await browser.evaluate(giveItAChanceToClick);
    expect(await browser.evaluate('result')).toBe('Was not clicked');
    expect(done).toBe(false);
    await browser.evaluate("() => { document.querySelector('button').style.visibility = 'visible'; }");
    await clicked;
    expect(done).toBe(true);
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  test('should waitFor visible when parent is hidden', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.evaluate("() => { document.querySelector('button').parentElement.style.display = 'none'; }");
    let done = false;
    const clicked = browser.locator('button').tap({ timeout: 0 }).then(() => (done = true));
    await browser.evaluate(giveItAChanceToClick);
    expect(done).toBe(false);
    await browser.evaluate("() => { document.querySelector('button').parentElement.style.display = 'block'; }");
    await clicked;
    expect(done).toBe(true);
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  test('should waitFor visible when already visible', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.locator('button').tap();
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  test('should click wrapped links', async ({ browser }) => {
    await browser.goto('/wrappedlink.html');
    await browser.locator('a').tap();
    expect(await browser.evaluate('__clicked')).toBe(true);
  });

  test('should click on checkbox input and toggle', async ({ browser }) => {
    await browser.goto('/input/checkbox.html');
    expect(await browser.evaluate('() => window.result.check')).toBe(null);
    await browser.locator('input#agree').tap();
    expect(await browser.evaluate('() => window.result.check')).toBe(true);
    expect(await browser.evaluate('() => window.result.events')).toEqual(['mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click', 'input', 'change']);
    await browser.locator('input#agree').tap();
    expect(await browser.evaluate('() => window.result.check')).toBe(false);
  });

  test('should click on checkbox label and toggle', async ({ browser }) => {
    await browser.goto('/input/checkbox.html');
    expect(await browser.evaluate('() => window.result.check')).toBe(null);
    await browser.locator('label[for="agree"]').tap();
    expect(await browser.evaluate('() => window.result.check')).toBe(true);
    expect(await browser.evaluate('() => window.result.events')).toEqual(['click', 'input', 'change']);
    await browser.locator('label[for="agree"]').tap();
    expect(await browser.evaluate('() => window.result.check')).toBe(false);
  });

  test('should scroll and click the button', async ({ browser }) => {
    await browser.goto('/input/scrollable.html');
    await browser.locator('#button-5').tap();
    expect(await browser.evaluate("() => document.querySelector('#button-5').textContent")).toBe('clicked');
    await browser.locator('#button-80').tap();
    expect(await browser.evaluate("() => document.querySelector('#button-80').textContent")).toBe('clicked');
  });

  test('should scroll and click the button with smooth scroll behavior', async ({ browser }) => {
    await browser.goto('/input/scrollable.html');
    await browser.evaluate("() => { const style = document.createElement('style'); style.textContent = 'html { scroll-behavior: smooth; }'; document.head.append(style); }");
    for (let index = 0; index < 5; index++) {
      await browser.locator('#button-80').tap();
      expect(await browser.evaluate("() => document.querySelector('#button-80').textContent")).toBe('clicked');
      await browser.locator('#button-20').tap();
      expect(await browser.evaluate("() => document.querySelector('#button-20').textContent")).toBe('clicked');
    }
  });

  test('should double click the button', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.evaluate("() => { window.double = false; document.querySelector('button').addEventListener('dblclick', () => { window.double = true; }); }");
    await browser.locator('button').doubleTap();
    expect(await browser.evaluate('double')).toBe(true);
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  test('should click a partially obscured button', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.evaluate("() => { const button = document.querySelector('button'); button.textContent = 'Some really long text that will go offscreen'; button.style.position = 'absolute'; button.style.left = '368px'; }");
    await browser.locator('button').tap();
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  test('should click a rotated button', async ({ browser }) => {
    await browser.goto('/input/rotatedButton.html');
    await browser.locator('button').tap();
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  test('should click the button with px border with offset', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.evaluate("() => { document.querySelector('button').style.borderWidth = '8px'; }");
    await browser.locator('button').tap({ position: { x: 20, y: 10 } });
    expect(await browser.evaluate('result')).toBe('Clicked');
    expect(await browser.evaluate('offsetX')).toBe(20);
    expect(await browser.evaluate('offsetY')).toBe(10);
  });

  test('should click the button with em border with offset', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.evaluate("() => { const button = document.querySelector('button'); button.style.borderWidth = '2em'; button.style.fontSize = '12px'; }");
    await browser.locator('button').tap({ position: { x: 20, y: 10 } });
    expect(await browser.evaluate('result')).toBe('Clicked');
    expect(await browser.evaluate('offsetX')).toBe(20);
    expect(await browser.evaluate('offsetY')).toBe(10);
  });

  test('should fire contextmenu event on right click', async ({ browser }) => {
    await browser.goto('/input/scrollable.html');
    await browser.locator('#button-8').secondaryTap();
    expect(await browser.evaluate("() => document.querySelector('#button-8').textContent")).toBe('context menu');
  });

  test('should click links which cause navigation', async ({ browser }) => {
    await browser.goto(content('<a href="/empty.html">empty.html</a>'));
    await browser.locator('a').tap();
    await browser.waitForURL('/empty.html');
  });

  test('should click the button inside an iframe', async ({ browser }) => {
    await browser.goto(content('<div style="width:100px;height:100px">spacer</div><iframe name="button-test" src="/input/button.html"></iframe>'));
    const frame = browser.frameLocator('iframe');
    await frame.locator('button').tap();
    expect(await browser.evaluate("() => document.querySelector('iframe').contentWindow.result")).toBe('Clicked');
  });

  test('should click the button behind sticky header', async ({ browser }) => {
    await browser.setViewport({ width: 500, height: 240 });
    await browser.goto(content(`
      <style>
        * { padding: 0; margin: 0; }
        li { height: 80px; border: 1px solid black; }
        ol { padding-top: 160px; }
        div.fixed { position: fixed; z-index: 1001; width: 100%; background: red; height: 160px; }
      </style>
      <div class=fixed></div>
      <ol>
        <li>hi1</li><li>hi2</li><li>hi3</li><li>hi4</li><li>hi5</li><li>hi6</li><li>hi7</li><li>hi8</li>
        <li id=target onclick="window.__clicked = true">hi9</li>
        <li>hi10</li><li>hi11</li><li>hi12</li><li>hi13</li><li id=li14>hi14</li>
      </ol>
    `));
    await browser.evaluate("() => document.querySelector('#li14').scrollIntoView()");
    await browser.locator('#target').tap();
    expect(await browser.evaluate('() => window.__clicked')).toBe(true);
  });

  test('should click the button behind position:absolute header', async ({ browser }) => {
    await browser.setViewport({ width: 500, height: 240 });
    await browser.goto(content(`
      <style>
        * { padding: 0; margin: 0; }
        li { height: 80px; border: 1px solid black; }
        ol { height: 100vh; overflow: scroll; padding-top: 160px; }
        body { position: relative; }
        div.fixed { position: absolute; top: 0; z-index: 1001; width: 100%; background: red; height: 160px; }
      </style>
      <ol>
        <li>hi1</li><li>hi2</li><li>hi3</li><li>hi4</li><li>hi5</li><li>hi6</li><li>hi7</li><li>hi8</li>
        <li id=target onclick="window.__clicked = true">hi9</li>
        <li>hi10</li><li>hi11</li><li>hi12</li><li>hi13</li><li id=li14>hi14</li>
      </ol>
      <div class=fixed>Overlay</div>
    `));
    await browser.evaluate("() => { const target = document.querySelector('#target'); document.querySelector('ol').scrollTo({ top: target.offsetTop, behavior: 'instant' }); }");
    await browser.locator('#target').tap();
    expect(await browser.evaluate('() => window.__clicked')).toBe(true);
  });

  test('should wait for stable position', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.evaluate(`() => {
      const button = document.querySelector('button');
      button.style.transition = 'margin 500ms linear 0s';
      button.style.marginLeft = '200px';
      button.style.borderWidth = '0';
      button.style.width = '200px';
      button.style.height = '20px';
      button.style.display = 'block';
      document.body.style.margin = '0';
    }`);
    await browser.evaluate(giveItAChanceToClick);
    await browser.locator('button').tap();
    expect(await browser.evaluate('result')).toBe('Clicked');
    expect(await browser.evaluate('pageX')).toBe(300);
    expect(await browser.evaluate('pageY')).toBe(10);
  });

  test('should wait for becoming hit target', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.evaluate(`() => {
      const button = document.querySelector('button');
      button.style.borderWidth = '0';
      button.style.width = '200px';
      button.style.height = '20px';
      document.body.style.margin = '0';
      document.body.style.position = 'relative';
      const flyOver = document.createElement('div');
      flyOver.className = 'flyover';
      flyOver.style.position = 'absolute';
      flyOver.style.width = '400px';
      flyOver.style.height = '20px';
      flyOver.style.left = '-200px';
      flyOver.style.top = '0';
      flyOver.style.background = 'red';
      document.body.appendChild(flyOver);
    }`);
    let clicked = false;
    const tap = browser.locator('button').tap({ timeout: 10_000 }).then(() => (clicked = true));
    expect(clicked).toBe(false);
    await browser.evaluate("() => { document.querySelector('.flyover').style.left = '0'; }");
    await browser.evaluate(giveItAChanceToClick);
    expect(clicked).toBe(false);
    await browser.evaluate("() => { document.querySelector('.flyover').style.left = '200px'; }");
    await tap;
    expect(clicked).toBe(true);
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  for (const [name, html, enable] of [
    ['button', '<button onclick="window.__CLICKED=true;" disabled><span>Click target</span></button>', "document.querySelector('button').removeAttribute('disabled')"],
    ['input', '<input onclick="window.__CLICKED=true;" disabled>', "document.querySelector('input').removeAttribute('disabled')"],
  ] as const) {
    test(`should wait for ${name} to be enabled`, async ({ browser, screen }) => {
      await browser.goto(content(html));
      let done = false;
      const tap = (name === 'button' ? screen.getByText('Click target') : browser.locator(name)).tap({ timeout: 10_000 }).then(() => (done = true));
      await browser.evaluate(giveItAChanceToClick);
      expect(await browser.evaluate('() => window.__CLICKED')).toBeUndefined();
      expect(done).toBe(false);
      await browser.evaluate(`() => { ${enable}; }`);
      await tap;
      expect(await browser.evaluate('__CLICKED')).toBe(true);
    });
  }

  test('should wait for select to be enabled', async ({ browser }) => {
    await browser.goto(content(`
      <select disabled><option selected>Hello</option></select>
      <script>
        document.querySelector('select').addEventListener('mousedown', event => { window.__CLICKED = true; event.preventDefault(); });
      </script>
    `));
    let done = false;
    const tap = browser.locator('select').tap({ timeout: 10_000 }).then(() => (done = true));
    await browser.evaluate(giveItAChanceToClick);
    expect(await browser.evaluate('() => window.__CLICKED')).toBeUndefined();
    expect(done).toBe(false);
    await browser.evaluate("() => { document.querySelector('select').removeAttribute('disabled'); }");
    await tap;
    expect(await browser.evaluate('__CLICKED')).toBe(true);
  });

  test('should click disabled div', async ({ browser, screen }) => {
    await browser.goto(content('<div onclick="window.__CLICKED=true" disabled>Click target</div>'));
    await screen.getByText('Click target').tap();
    expect(await browser.evaluate('__CLICKED')).toBe(true);
  });

  test('should wait for BUTTON to be clickable when it has pointer-events:none', async ({ browser, screen }) => {
    await browser.goto(content('<button onclick="window.__CLICKED=true" style="pointer-events:none"><span>Click target</span></button>'));
    let done = false;
    const tap = screen.getByText('Click target').tap({ timeout: 10_000 }).then(() => (done = true));
    await browser.evaluate(giveItAChanceToClick);
    expect(await browser.evaluate('() => window.__CLICKED')).toBeUndefined();
    expect(done).toBe(false);
    await browser.evaluate("() => { document.querySelector('button').style.removeProperty('pointer-events'); }");
    await tap;
    expect(await browser.evaluate('__CLICKED')).toBe(true);
  });

  test('should wait for LABEL to be clickable when it has pointer-events:none', async ({ browser, screen }) => {
    await browser.goto(content('<label onclick="window.__CLICKED=true" style="pointer-events:none"><span>Click target</span></label>'));
    const tap = screen.getByText('Click target').tap({ timeout: 10_000 });
    for (let index = 0; index < 5; ++index) expect(await browser.evaluate('() => window.__CLICKED')).toBeUndefined();
    await browser.evaluate("() => { document.querySelector('label').style.removeProperty('pointer-events'); }");
    await tap;
    expect(await browser.evaluate('__CLICKED')).toBe(true);
  });

  test('should update modifiers correctly', async ({ browser }) => {
    await browser.goto('/input/button.html');
    const button = browser.locator('button');
    await button.tap({ modifiers: ['Shift'] });
    expect(await browser.evaluate('shiftKey')).toBe(true);
    await button.tap();
    expect(await browser.evaluate('shiftKey')).toBe(false);
    await browser.keyboard.down('Shift');
    await button.tap();
    expect(await browser.evaluate('shiftKey')).toBe(true);
    await browser.keyboard.up('Shift');
    await button.tap();
    expect(await browser.evaluate('shiftKey')).toBe(false);
  });

  test('should retry when element detaches after animation', async ({ browser }) => {
    await browser.goto('/input/animating-button.html');
    await browser.evaluate('addButton()');
    let clicked = false;
    const tap = browser.locator('button').tap({ timeout: 10_000 }).then(() => (clicked = true));
    expect(clicked).toBe(false);
    expect(await browser.evaluate('window.clicked')).toBeUndefined();
    await browser.evaluate('stopButton(true)');
    await browser.evaluate('addButton()');
    expect(clicked).toBe(false);
    expect(await browser.evaluate('window.clicked')).toBeUndefined();
    await browser.evaluate('stopButton(true)');
    await browser.evaluate('addButton()');
    expect(clicked).toBe(false);
    expect(await browser.evaluate('window.clicked')).toBeUndefined();
    await browser.evaluate('stopButton(false)');
    await tap;
    expect(clicked).toBe(true);
    expect(await browser.evaluate('clicked')).toBe(true);
  });

  test('should retry when element is animating from outside the viewport', async ({ browser }) => {
    await browser.goto(content(`
      <style>
        @keyframes move { from { left: -300px; } to { left: 0; } }
        button { position: absolute; left: -300px; top: 0; bottom: 0; width: 200px; }
        button.animated { animation: 1s linear 1s move forwards; }
      </style>
      <div style="position: relative; width: 300px; height: 300px;">
        <button onclick="window.clicked=true"></button>
      </div>
    `));
    const tap = browser.locator('button').tap({ timeout: 10_000 });
    await browser.evaluate("() => { document.querySelector('button').className = 'animated'; }");
    await tap;
    expect(await browser.evaluate('clicked')).toBe(true);
  });

  test('should dispatch microtasks in order', async ({ browser }) => {
    await browser.goto(content(`
      <button id=button>Click me</button>
      <script>
        let mutationCount = 0;
        const observer = new MutationObserver((mutationsList) => {
          for (const mutation of mutationsList) ++mutationCount;
        });
        observer.observe(document.body, { attributes: true, childList: true, subtree: true });
        button.addEventListener('mousedown', () => {
          mutationCount = 0;
          document.body.appendChild(document.createElement('div'));
        });
        button.addEventListener('mouseup', () => {
          window.result = mutationCount;
        });
      </script>
    `));
    await browser.locator('button').tap();
    expect(await browser.evaluate('() => window.result')).toBe(1);
  });

  test('should click an offscreen element when scroll-behavior is smooth', async ({ browser }) => {
    await browser.goto(content(`
      <div style="border: 1px solid black; height: 500px; overflow: auto; width: 500px; scroll-behavior: smooth">
        <button style="margin-top: 2000px" onClick="window.clicked = true">hi</button>
      </div>
    `));
    await browser.locator('button').tap();
    expect(await browser.evaluate('window.clicked')).toBe(true);
  });

  test('should click the button when window.innerWidth is corrupted', async ({ browser }) => {
    await browser.goto('/input/button.html');
    await browser.evaluate("() => { Object.defineProperty(window, 'innerWidth', { value: 0 }); }");
    await browser.locator('button').tap();
    expect(await browser.evaluate('result')).toBe('Clicked');
  });

  test('should click zero-sized input by label', async ({ browser, screen }) => {
    await browser.goto(content(`
      <label>
        Click me
        <input onclick="window.__clicked=true" style="width:0;height:0;padding:0;margin:0;border:0;">
      </label>
    `));
    await screen.getByText('Click me').tap();
    expect(await browser.evaluate('window.__clicked')).toBe(true);
  });

  test('should climb dom for inner label with pointer-events:none', async ({ browser, screen }) => {
    await browser.goto(content('<button onclick="window.__CLICKED=true;"><label style="pointer-events:none">Click target</label></button>'));
    await screen.getByText('Click target').tap();
    expect(await browser.evaluate('__CLICKED')).toBe(true);
  });

  test('should climb up to [role=button]', async ({ browser, screen }) => {
    await browser.goto(content('<div role=button onclick="window.__CLICKED=true;"><div style="pointer-events:none"><span><div>Click target</div></span></div>'));
    await screen.getByText('Click target').tap();
    expect(await browser.evaluate('__CLICKED')).toBe(true);
  });

  test('should climb up to a anchor', async ({ browser }) => {
    await browser.goto(content('<a href="#" onclick="window.__CLICKED=true" id="outer"><div id="intermediate"><div id="inner" style="pointer-events: none">Inner</div></div></a>'));
    await browser.locator('#inner').tap();
    expect(await browser.evaluate('__CLICKED')).toBe(true);
  });

  test('should climb up to a [role=link]', async ({ browser }) => {
    await browser.goto(content('<div role=link onclick="window.__CLICKED=true" id="outer"><div id="inner" style="pointer-events: none">Inner</div></div>'));
    await browser.locator('#inner').tap();
    expect(await browser.evaluate('__CLICKED')).toBe(true);
  });

  test('should click in an iframe with border', async ({ browser }) => {
    await browser.goto(content(`
      <style>
        body, html, iframe { margin: 0; padding: 0; border: none; box-sizing: border-box; }
        iframe { border: 4px solid black; background: gray; margin-left: 33px; margin-top: 24px; width: 400px; height: 400px; }
      </style>
      <iframe srcdoc="
        <style>
          body, html { margin: 0; padding: 0; }
          div { margin-left: 10px; margin-top: 20px; width: 2px; height: 2px; }
        </style>
        <div>Target</div>
        <script>
          document.querySelector('div').addEventListener('click', () => window.top._clicked = true);
        </script>
      "></iframe>
    `));
    await browser.frameLocator('iframe').locator('div').tap();
    expect(await browser.evaluate('window._clicked')).toBe(true);
  });

  test('should click in an iframe with border 2', async ({ browser }) => {
    await browser.goto(content(`
      <style>
        body, html, iframe { margin: 0; padding: 0; border: none; }
        iframe { border: 4px solid black; background: gray; margin-left: 33px; margin-top: 24px; width: 400px; height: 400px; }
      </style>
      <iframe srcdoc="
        <style>
          body, html { margin: 0; padding: 0; }
          div { margin-left: 10px; margin-top: 20px; width: 2px; height: 2px; }
        </style>
        <div>Target</div>
        <script>
          document.querySelector('div').addEventListener('click', () => window.top._clicked = true);
        </script>
      "></iframe>
    `));
    await browser.frameLocator('iframe').locator('div').tap();
    expect(await browser.evaluate('window._clicked')).toBe(true);
  });

  test('should click in a transformed iframe', async ({ browser }) => {
    await browser.goto(content(`
      <style>
        body, html, iframe { margin: 0; padding: 0; border: none; }
        iframe {
          border: 4px solid black; background: gray; margin-left: 33px; margin-top: 24px; width: 400px; height: 400px;
          transform: translate(100px, 100px) scale(1.2) rotate3d(1, 1, 1, 25deg);
        }
      </style>
      <iframe srcdoc="
        <style>
          body, html { margin: 0; padding: 0; }
          div { margin-left: 10px; margin-top: 20px; width: 2px; height: 2px; }
        </style>
        <div>Target</div>
        <script>
          document.querySelector('div').addEventListener('click', () => window.top._clicked = true);
        </script>
      "></iframe>
    `));
    await browser.frameLocator('iframe').locator('div').tap();
    expect(await browser.evaluate('window._clicked')).toBe(true);
  });

  test('should click in a nested transformed iframe', async ({ browser }) => {
    await browser.goto(content(`
      <style>
        body, html, iframe { margin: 0; padding: 0; box-sizing: border-box; }
        iframe { border: 1px solid black; background: gray; margin-left: 33px; margin-top: 24px; width: 400px; height: 400px; transform: scale(0.8); }
      </style>
      <iframe srcdoc="
        <style>
          body, html, iframe { margin: 0; padding: 0; box-sizing: border-box; }
          iframe { border: 3px solid black; background: gray; margin-left: 18px; margin-top: 14px; width: 200px; height: 200px; transform: scale(0.7); }
        </style>
        <iframe srcdoc='
          <style>
            div { margin-left: 10px; margin-top: 20px; width: 2px; height: 2px; }
          </style>
          <div onclick=&quot;window.top._clicked = true&quot;>Target</div>
        '></iframe>
      "></iframe>
    `));
    await browser.frameLocator('iframe').frameLocator('iframe').locator('div').tap();
    expect(await browser.evaluate('window._clicked')).toBe(true);
  });

  test('should click if opened select covers the button', async ({ browser }) => {
    await browser.goto(content(`
      <div>
        <select>
          <option>very long text #1</option><option>very long text #2</option><option>very long text #3</option>
          <option>very long text #4</option><option>very long text #5</option><option>very long text #6</option>
        </select>
      </div>
      <div><button onclick="window.__CLICKED=42">clickme</button></div>
    `));
    await browser.locator('select').tap();
    await browser.locator('button').tap();
    expect(await browser.evaluate('window.__CLICKED')).toBe(42);
  });

  test('should fire contextmenu event on right click in correct order', async ({ browser, screen }) => {
    await browser.goto(content('<button id="target">Click me</button>'));
    await browser.evaluate("() => { window.entries = []; const log = (event) => window.entries.push(event.type); for (const type of ['mousedown', 'mouseup', 'contextmenu']) document.addEventListener(type, log); }");
    await screen.getByRole('button', 'Click me').secondaryTap();
    await expect.poll(() => browser.evaluate('entries')).toEqual(['mousedown', 'contextmenu', 'mouseup']);
  });

  test('should click after a right click', async ({ browser, screen }) => {
    await browser.goto(content(`
      <button>Click me</button>
      <script>
        const button = document.querySelector('button');
        button.addEventListener('click', () => button.textContent = 'Clicked!');
      </script>
    `));
    await screen.getByRole('button').secondaryTap();
    await screen.getByRole('button').tap();
    await expect(screen.getByRole('button')).toHaveText('Clicked!');
  });

  test('should click into shadow root with slotted div', async ({ browser, screen }) => {
    await browser.goto(content(`
      <my-button>
        <template shadowrootmode="open"><button onclick="window.__clicked = true"><slot></slot></button></template>
        <div>Foo</div>
      </my-button>
    `));
    await screen.getByRole('button', 'Foo').tap();
    expect(await browser.evaluate('window.__clicked')).toBe(true);
  });

  test('should click shadow root button', async ({ browser }) => {
    await browser.goto(content(`
      <my-button>
        <template shadowrootmode="open"><button onclick="window.__clicked = true"><slot></slot></button></template>
        <div>Foo</div>
      </my-button>
    `));
    await browser.locator('my-button').tap();
    expect(await browser.evaluate('window.__clicked')).toBe(true);
  });

  test('should click a button that is overlaid by a permission popup', async ({ browser, screen }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto(content(`
      <style>body, html { padding: 0; margin: 0; }</style>
      <script>
        window.addEventListener('DOMContentLoaded', () => {
          for (let i = 0; i < 100; ++i) {
            const button = document.createElement('button');
            button.textContent = i;
            button.style.setProperty('width', '50px');
            button.style.setProperty('height', '50px');
            document.body.append(button);
          }
        }, false);
      </script>
    `));
    await browser.evaluate('() => { navigator.geolocation.getCurrentPosition(() => {}); }');
    for (let index = 0; index < 30; ++index) await screen.getByText(String(index), { exact: true }).tap();
  });

  test('should set PointerEvent.pressure on pointerdown', async ({ browser }) => {
    await browser.goto(content(`
      <button id="target">Click me</button>
      <script>
        window.pressures = [];
        document.addEventListener('pointerdown', e => window.pressures.push(['pointerdown', e.pressure]));
        document.addEventListener('pointerup', e => window.pressures.push(['pointerup', e.pressure]));
      </script>
    `));
    await browser.locator('button').tap();
    expect(await browser.evaluate('() => window.pressures')).toEqual(expect.arrayContaining([
      ['pointerdown', 0.5],
      ['pointerup', 0],
    ]));
  });

  test('should set PointerEvent.pressure on pointermove', async ({ browser }) => {
    await browser.goto(content(`
      <body style="margin: 0; padding: 0;">
        <div id="target" style="width: 500px; height: 500px; background-color: red;"></div>
        <script>
          window.pressures = [];
          document.addEventListener('pointermove', e => window.pressures.push([e.pressure, e.clientX, e.clientY]));
        </script>
      </body>
    `));
    await browser.locator('div#target').tap();
    await browser.mouse.move(10, 10);
    await browser.mouse.down();
    await browser.mouse.move(250, 250);
    await browser.mouse.up();
    await browser.mouse.move(50, 50);
    expect(await browser.evaluate('() => window.pressures')).toEqual(expect.arrayContaining([
      [0, 250, 250],
      [0, 10, 10],
      [0.5, 250, 250],
      [0, 50, 50],
    ]));
  });
});
