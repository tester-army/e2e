/**
 * The observed tree reads an element's text as a person reads its line:
 * words inside inline descendants (a link, emphasis, code) stay in place in
 * the sentence, the link stays a node of its own, and text-only inline
 * wrappers are not listed a second time.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

let page: WebSession;

beforeAll(async () => {
  page = await startWebSession();
});

afterAll(async () => {
  await page.close();
});

/** Every node of one observation of `html`, in document order. */
async function observe(html: string): Promise<SemanticNode[]> {
  await page.setContent(html);
  const { root } = await page.observe();
  const out: SemanticNode[] = [];
  const visit = (node: SemanticNode): void => {
    out.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of root.children ?? []) visit(child);
  return out;
}

/** The nodes as `role "name" text`, the parts a model reads. */
function lines(nodes: readonly SemanticNode[]): string[] {
  return nodes.map((node) => [node.role, node.name === undefined ? undefined : `"${node.name}"`, node.text].filter(Boolean).join(' '));
}

it('reads a sentence with an inline link whole and keeps the link as its own node under it', async () => {
  const nodes = await observe('<p>Read our <a href="/privacy">privacy policy</a> for details.</p>');
  expect(lines(nodes)).toEqual(['Read our privacy policy for details.', 'link "privacy policy" privacy policy']);
  expect(nodes[0]!.children?.map((child) => child.role)).toEqual(['link']);
});

it('reads emphasis, code, and spans in place and lists none of them again', async () => {
  const nodes = await observe('<p>Use <strong>bold</strong>, <em>italic <b>nested</b></em>, <code>npx e2e</code>, and a <span>span</span>.</p>');
  expect(lines(nodes)).toEqual(['Use bold, italic nested, npx e2e, and a span.']);
});

it('keeps an inline node named by a test id while its words stay in the sentence', async () => {
  const nodes = await observe('<p>Total <span data-testid="total">$10</span> due today</p>');
  expect(lines(nodes)).toEqual(['Total $10 due today', '$10']);
  expect(nodes[1]!.testId).toBe('total');
});

it('keeps an inline element that offers an action listed, its words still in the sentence', async () => {
  const nodes = await observe(`
    <p>Text <span onclick="" tabindex="0">change</span> here</p>
    <p>Or <span id="wired">resend</span> the code</p>
    <p>See <a>the note</a> below</p>
    <p>Pick <span tabindex="-1"><b>this</b></span> now</p>
    <div tabindex="-1"><span>Outside</span> <span tabindex="0"><b>any</b></span></div>
    <script>document.getElementById('wired').onclick = () => undefined;</script>
  `);
  expect(lines(nodes)).toEqual([
    'Text change here',
    'change',
    'Or resend the code',
    'resend',
    'See the note below',
    'the note',
    'Pick this now',
    'this',
    'Outside',
    'any',
  ]);
});

it('lists the children of a wrapper with no text of its own, as before', async () => {
  const nodes = await observe('<div><span>One</span><span>Two</span></div><button><span>Save</span></button>');
  expect(lines(nodes)).toEqual(['One', 'Two', 'button "Save"', 'Save']);
});

it('separates words at block children, line breaks, and form controls, and reads no hidden inline text', async () => {
  const nodes = await observe(`
    <div>Intro<p>Block</p>tail</div>
    <p>one<br>two</p>
    <label>Show <select><option>10</option></select> per page</label>
    <p>Shown <span style="display:none">gone</span><span aria-hidden="true">decor</span><span style="visibility:hidden">ghost</span> end</p>
    <p>Price <span style="display:inline-block;width:0;height:0;overflow:hidden">$99</span><span style="font-size:0">$98</span> today</p>
    <p>extra<wbr>ordinary</p>
  `);
  const texts = nodes.filter((node) => node.role === undefined).map((node) => node.text);
  expect(texts).toEqual(['Intro tail', 'Block', 'one two', 'Show per page', 'Shown end', 'Price today', 'extraordinary']);
});

it('reads the shadow tree an inline custom element renders, open or closed, and the light text it slots', async () => {
  const nodes = await observe(`
    <p>Signed in as <open-name></open-name>, welcome back.</p>
    <p>Your plan: <closed-plan></closed-plan> until May.</p>
    <p>Hello <slot-greet>Ada <unused-light style="display:none">x</unused-light></slot-greet>!</p>
    <script>
      customElements.define('open-name', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<b>Ada</b> <a href="/me">Lovelace</a>'; }
      });
      customElements.define('closed-plan', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: 'closed' }).innerHTML = '<strong>Pro</strong>'; }
      });
      customElements.define('slot-greet', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = 'dear <em><slot></slot></em>'; }
      });
    </script>
  `);
  expect(lines(nodes)).toEqual([
    'Signed in as Ada Lovelace, welcome back.',
    'link "Lovelace" Lovelace',
    'Your plan: Pro until May.',
    'Hello dear Ada !',
  ]);
});

it('reads no slotted text a hidden slot hides, and lists a slotted child that shows itself again', async () => {
  const nodes = await observe(`
    <p>Status <hidden-slot>secret <span style="visibility:visible">shown</span></hidden-slot> end</p>
    <script>
      customElements.define('hidden-slot', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<slot style="visibility:hidden"></slot>'; }
      });
    </script>
  `);
  expect(lines(nodes)).toEqual(['Status end', 'shown']);
  expect(await page.browser.evaluate(() => document.querySelector('p')!.innerText)).toBe('Status shown end');
});

it('keeps listing the inline text of a line too long for the text bound, so nothing past the cut is lost', async () => {
  const nodes = await observe(`<p>${'word '.repeat(120)}<strong>Total: $42</strong></p>`);
  expect(nodes.map((node) => node.text)).toEqual([expect.stringMatching(/^word word/), 'Total: $42']);
});
