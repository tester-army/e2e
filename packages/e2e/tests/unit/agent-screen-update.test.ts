import { describe, expect, it } from 'vitest';
import type { ModelMessage, ToolResultPart } from 'ai';
import type { ExecutorObservation } from '../../src/agent/executor.ts';
import { ScreenPresenter } from '../../src/agent/screen-update.ts';
import { compactScreenHistory } from '../../src/agent/transcript-compaction.ts';

function screen(revision: string, lines: readonly string[], extra: Partial<ExecutorObservation> = {}): ExecutorObservation {
  return {
    revision,
    text: lines.join('\n'),
    truncated: false,
    viewport: { width: 1280, height: 720 },
    ...extra,
  };
}

const HOME = [
  '#n1 document "Home"',
  ' #n2 heading "Welcome"',
  ' #n3 button "Increment"',
  ' #n4 status "Counter" text="0"',
  ' #n5 link "About" href="/about"',
  ' #n6 textbox "Email"',
];

/** One tool result carrying a rendered screen as its text. */
function toolResult(id: string, text: string): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: id, toolName: 'tap', output: { type: 'text', value: text } }],
  };
}

/** The text of a tool message's one text result. */
function toolText(message: ModelMessage): string {
  const [part] = message.content as ToolResultPart[];
  const output = part!.output;
  if (output.type !== 'text') throw new Error('expected a text tool result');
  return output.value;
}

describe('ScreenPresenter', () => {
  it('retires semantic history through repeated unavailable captures and shows recovery whole', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', ['#root', ' #save button "Save"']));
    const pixels = { data: new Uint8Array([1]), mediaType: 'image/png' as const, width: 1, height: 1, scale: 1, maskedRegionCount: 0 };
    for (const revision of ['b2', 'b3']) {
      const output = presenter.present(screen(revision, [
        '[semantic capture unavailable: no nodes were read; previous node ids are no longer valid. Use the screenshot, never infer absence from this listing]',
      ], { treeUnavailable: true, truncated: true, pixels }));
      expect(output).toMatchObject({ pixels });
      const text = typeof output === 'string' ? output : output.text;
      expect(text).toContain('semantic capture unavailable');
      expect(text).toContain('previous node ids are no longer valid');
      expect(text).not.toContain('keeps the id');
      expect(text).not.toContain('no listed node changed');
      expect(text).not.toContain('removed');
    }
    const recovered = presenter.update(screen('b4', ['#root', ' #save button "Save"']));
    expect(recovered).toContain('Current screen (revision b4');
    expect(recovered).toContain('#save button "Save"');
    expect(recovered).not.toContain('Screen changes');
  });

  it('sends the first screen whole, with its revision, path, and size', () => {
    const presenter = new ScreenPresenter();
    const text = presenter.initial(screen('b1', HOME, { path: '/' }));
    expect(text.split('\n')[0]).toBe('Current screen (revision b1, path /, 6 nodes):');
    expect(text).toContain(' #n3 button "Increment"');
  });

  it('says a tab the app opened stays in the background, then shows another tab whole even when its ids match', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME, { path: '/' }));
    const opened = presenter.update(screen('b2', HOME, { path: '/', tabs: { count: 2, active: 1 } }), { lead: 'Tapped #n3.', expectChange: true });
    // The tab is the tap's effect: no control is blamed for the unchanged screen.
    expect(opened).toContain('Tapped #n3.\n\nThe app opened a new tab (tab 2 of 2). The screen still shows tab 1; use switch_tab to see it. Screen unchanged since revision b1');
    const popup = ['#n1 document "Verification"', ' #n2 text "Code TAB-88421"'];
    const switched = presenter.update(screen('b3', popup, { path: '/verify', tabs: { count: 2, active: 2 } }), { lead: 'Switched to tab 2.' });
    expect(switched).toContain('The screen shows tab 2 of 2 now. Current screen (revision b3, path /verify, tab 2 of 2, 2 nodes):');
    expect(switched).toContain(' #n2 text "Code TAB-88421"');
    expect(switched).not.toContain('changed #n1');
    const back = presenter.update(screen('b4', HOME, { path: '/', tabs: { count: 2, active: 1 } }), { lead: 'Switched to tab 1.' });
    expect(back).toContain('The screen shows tab 1 of 2 now. Current screen (revision b4, path /, tab 1 of 2, 6 nodes):');
    expect(presenter.update(screen('b5', HOME, { path: '/', tabs: { count: 2, active: 1 } }))).toContain('Screen unchanged since revision b4');
    const two = presenter.update(screen('b6', HOME, { path: '/', tabs: { count: 4, active: 1 } }));
    expect(two).toContain('The app opened 2 new tabs (tabs 3 to 4 of 4). The screen still shows tab 1; use switch_tab to see one.');
    const closed = presenter.update(screen('b7', HOME, { path: '/' }));
    expect(closed).toContain('The other tabs closed; the screen shows the one tab still open. Current screen (revision b7, path /, 6 nodes):');
  });

  it('reports a changed and an added line, in document order, keyed by stable ids', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const next = [...HOME];
    next[3] = ' #n4 status "Counter" text="1"';
    next.push(' #n7 button "Late arrival"');
    const text = presenter.update(screen('b2', next), { lead: 'Tapped #n3.' });
    expect(text.split('\n')).toEqual([
      'Tapped #n3.',
      '',
      'Screen changes since revision b1 (now revision b2, 7 nodes): 1 added, 1 changed. Every node not listed as removed is still on screen under the id you have.',
      'changed #n4 status "Counter" text="1" (was: #n4 status "Counter" text="0")',
      'added #n7 button "Late arrival"',
    ]);
  });

  it('lists removed lines after the additions', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const next = HOME.filter((line) => !line.includes('#n5'));
    const text = presenter.update(screen('b2', next));
    expect(text).toContain('1 removed.');
    expect(text).toContain('removed #n5 link "About" href="/about"');
    expect(text).not.toContain('added ');
  });

  it('says so when nothing changed, and blames the action when one was expected to change something', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    expect(presenter.update(screen('b2', HOME))).toBe(
      'Screen unchanged since revision b1 (re-observed as revision b2); the ids you have stay valid.',
    );
    const afterAction = presenter.update(screen('b3', HOME), { lead: 'Tapped #n3.', expectChange: true });
    expect(afterAction).toContain('Tapped #n3.');
    expect(afterAction).toContain('re-observed as revision b3');
  });

  it('says no listed node changed after an action, never that it had no effect, when no screenshot was compared', () => {
    const presenter = new ScreenPresenter();
    const shot = (byte: number) => ({ data: new Uint8Array([byte]), mediaType: 'image/png' as const, width: 1, height: 1, scale: 1, maskedRegionCount: 0 });
    const textOf = (output: ReturnType<ScreenPresenter['present']>) => (typeof output === 'string' ? output : output.text);
    presenter.open(screen('b1', HOME));
    // A tap that only fills a drawn dot leaves the tree as it was: the tree cannot tell a drawn effect from none.
    const treeOnly = textOf(presenter.present(screen('b2', HOME), { lead: 'Tapped #n3.', expectChange: true }));
    expect(treeOnly).toContain('No listed node changed within the wait after this action');
    expect(treeOnly).toContain('a drawn change needs a screenshot to see');
    expect(treeOnly).not.toContain('had no visible effect');
    expect(treeOnly).not.toContain('look for another way');
    // The first screenshot has none before it to differ from, so it proves no more than the tree.
    const first = textOf(presenter.present(screen('b3', HOME, { pixels: shot(1) }), { lead: 'Tapped #n3.', expectChange: true }));
    expect(first).not.toContain('had no visible effect');
  });

  it('keeps the listing as the only evidence, and says to try another way, when the engine captures no screenshot', () => {
    const textOf = (output: ReturnType<ScreenPresenter['present']>) => (typeof output === 'string' ? output : output.text);
    // An engine that captures none says so once asked; from then on the listing is all there is.
    const denied = new ScreenPresenter();
    denied.open(screen('c1', HOME));
    denied.present(screen('c2', HOME, { pixelsWithheld: 'UNSUPPORTED_CAPABILITY' }));
    const after = textOf(denied.present(screen('c3', HOME), { lead: 'Tapped #n3.', expectChange: true }));
    expect(after).toContain('No screenshot can be taken in this step');
    expect(after).toContain('look for another way rather than repeating it');
    expect(after).not.toContain('needs a screenshot to see');
  });

  it('says the screenshot changed, not that the control had no effect, when the listing stood still under a moved image', () => {
    const presenter = new ScreenPresenter();
    const shot = (byte: number) => ({ data: new Uint8Array([byte]), mediaType: 'image/png' as const, width: 1, height: 1, scale: 1, maskedRegionCount: 0 });
    const textOf = (output: ReturnType<ScreenPresenter['present']>) => (typeof output === 'string' ? output : output.text);
    presenter.open(screen('b1', HOME, { pixels: shot(1) }));
    const moved = textOf(presenter.present(screen('b2', HOME, { pixels: shot(2) }), { lead: 'Tapped #n3.', expectChange: true }));
    expect(moved).toContain('Tapped #n3.');
    expect(moved).toContain('listed nodes unchanged; the screenshot changed');
    expect(moved).not.toContain('had no visible effect');
    // The same image again: the tree describes this screen, so the control is blamed as before.
    const still = textOf(presenter.present(screen('b3', HOME, { pixels: shot(2) }), { lead: 'Tapped #n3.', expectChange: true }));
    expect(still).toContain('had no visible effect');
    expect(still).not.toContain('the screenshot changed');
    // A moved image is reported whether or not a change was expected.
    const observed = textOf(presenter.present(screen('b4', HOME, { pixels: shot(3) }), { lead: 'Observed.', expectChange: false }));
    expect(observed).toContain('listed nodes unchanged; the screenshot changed');
    expect(observed).not.toContain('Screen unchanged since');
  });

  it('treats unproven masking as one screen\'s refusal, not the step\'s', () => {
    const textOf = (output: ReturnType<ScreenPresenter['present']>) => (typeof output === 'string' ? output : output.text);
    const presenter = new ScreenPresenter();
    presenter.open(screen('b1', HOME));
    presenter.present(screen('b2', HOME, { pixelsWithheld: 'MASKING_UNPROVEN' }));
    const later = textOf(presenter.present(screen('b3', HOME), { lead: 'Tapped #n3.', expectChange: true }));
    expect(later).not.toContain('No screenshot can be taken in this step');
    expect(later).toContain('a drawn change needs a screenshot to see');
  });

  it('ignores focus moving, which every action does, when deciding what changed', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const focused = [...HOME];
    focused[2] = ' #n3 button "Increment" [focused]';
    expect(presenter.update(screen('b2', focused), { lead: 'Tapped #n3.', expectChange: true })).toContain(
      'No listed node changed within the wait',
    );
    const typed = [...focused];
    typed[5] = ' #n6 textbox "Email" value="a" [focused]';
    typed[2] = ' #n3 button "Increment"';
    const text = presenter.update(screen('b3', typed));
    expect(text).toContain('changed #n6 textbox "Email" value="a" (was: #n6 textbox "Email")');
    expect(text).not.toContain('Increment');
  });

  it('falls back to the whole screen when most of it changed', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const other = [
      '#n20 document "Pricing"',
      ' #n21 heading "Plans"',
      ' #n22 button "Choose Pro"',
      ' #n23 button "Choose Team"',
    ];
    const text = presenter.update(screen('b2', other, { path: '/pricing' }), { lead: 'Tapped #n5.' });
    expect(text).toContain('The screen changed substantially since revision b1. Current screen (revision b2, path /pricing, 4 nodes):');
    expect(text).toContain(' #n22 button "Choose Pro"');
    expect(text).not.toContain('added ');
  });

  it('compares against the newest screen it rendered, whole or as changes', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const typed = [...HOME];
    typed[5] = ' #n6 textbox "Email" value="ada@example.test"';
    presenter.update(screen('b2', typed));
    const pressed = [...typed];
    pressed[3] = ' #n4 status "Counter" text="1"';
    const text = presenter.update(screen('b3', pressed));
    // The email line was already reported and is not repeated.
    expect(text).not.toContain('Email');
    expect(text).toContain('changed #n4 status "Counter" text="1" (was: #n4 status "Counter" text="0")');
  });

  it('notes a truncated screen on a change update', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const next = [...HOME, ' #n8 button "More"'];
    const text = presenter.update(screen('b2', next, { truncated: true }));
    expect(text).toContain('1 added. The screen listing is truncated');
  });

  it('reports no removals against a truncated screen, whose missing nodes were cut, not gone', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    // The walk stopped after four nodes: the link and the textbox may well still exist.
    const text = presenter.update(screen('b2', HOME.slice(0, 4), { truncated: true }));
    expect(text).not.toMatch(/^removed /m);
    expect(text).not.toContain('Screen unchanged');
    expect(text).toContain('no listed node changed. The screen listing is truncated');
  });

  it('does not call a node changed when only its depth moved', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const next = HOME.map((line) => (line.includes('#n4 ') ? ` ${line}` : line));
    expect(presenter.update(screen('b2', next))).toContain('Screen unchanged since revision b1');
  });
});

describe('ScreenPresenter folds large unchanged subtrees in the full-screen fallback', () => {
  /** A sidebar of `count` links under a navigation node, ids #n3 and up. */
  function sidebar(count: number): string[] {
    return [
      ' #n2 navigation "Sidebar"',
      ...Array.from({ length: count }, (_, i) => `  #n${String(i + 3)} link "Item ${String(i + 1)}"`),
    ];
  }

  const MAIN_LIST = [
    ' #n20 main "Order list"',
    '  #n21 heading "Orders"',
    '  #n22 button "Order 1"',
    '  #n23 button "Order 2"',
  ];

  const MAIN_DETAILS = [
    ' #n20 main "Order details"',
    '  #n30 heading "Order 42"',
    '  #n31 text "Total $12"',
    '  #n32 text "Placed yesterday"',
    '  #n33 button "Refund"',
    '  #n34 button "Ship"',
    '  #n35 button "Print"',
    '  #n36 button "Archive"',
    '  #n37 link "Back to orders"',
  ];

  const MAIN_SEARCH = [
    ' #n40 main "Order search"',
    '  #n41 heading "Find an order"',
    '  #n42 textbox "Order number"',
    '  #n43 button "Search"',
    '  #n44 text "No order selected"',
    '  #n45 button "Clear"',
    '  #n46 link "All orders"',
    '  #n47 text "Search by number or customer"',
    '  #n48 button "Help"',
  ];

  function orderScreen(main: readonly string[], sidebarCount: number): string[] {
    return ['#n1 document "Orders"', ...sidebar(sidebarCount), ...main];
  }

  it('folds a large unchanged sidebar, and lists the changed main in full', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', orderScreen(MAIN_LIST, 12)));
    const text = presenter.update(screen('b2', orderScreen(MAIN_DETAILS, 12), { path: '/orders' }), { lead: 'Tapped #n22.' });
    expect(text).toContain('The screen changed substantially since revision b1.');
    expect(text).toContain('Current screen (revision b2, path /orders, 23 nodes):');
    expect(text).toContain(' #n2 navigation "Sidebar" (12 nodes inside, unchanged since revision b1)');
    expect(text).not.toContain('#n3 link "Item 1"');
    expect(text).not.toContain('#n14 link "Item 12"');
    expect(text).toContain(' #n30 heading "Order 42"');
    expect(text).toContain(' #n37 link "Back to orders"');
  });

  it('keeps a small unchanged subtree listed in full', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', orderScreen(MAIN_LIST, 3)));
    const text = presenter.update(screen('b2', orderScreen(MAIN_DETAILS, 3)), { lead: 'Tapped #n22.' });
    expect(text).toContain('The screen changed substantially since revision b1.');
    expect(text).not.toContain('nodes inside, unchanged since revision');
    expect(text).toContain(' #n3 link "Item 1"');
    expect(text).toContain(' #n30 heading "Order 42"');
  });

  it('folds an unchanged group inside a changed sidebar, and lists the changed sibling', () => {
    const presenter = new ScreenPresenter();
    const before = [
      '#n1 document "Orders"',
      ' #n2 navigation "Sidebar"',
      '  #n3 list "Sections"',
      ...Array.from({ length: 12 }, (_, i) => `   #n${String(i + 40)} link "Section ${String(i + 1)}"`),
      '  #n60 link "Settings"',
      ...MAIN_LIST,
    ];
    presenter.initial(screen('b1', before));
    const after = before.map((line) => (line.includes('#n60 ') ? '  #n60 link "Settings (2)"' : line));
    after.splice(after.indexOf(' #n20 main "Order list"'), 4, ...MAIN_DETAILS);
    const text = presenter.update(screen('b2', after), { lead: 'Tapped #n22.' });
    expect(text).toContain('The screen changed substantially since revision b1.');
    expect(text).toContain('  #n3 list "Sections" (12 nodes inside, unchanged since revision b1)');
    expect(text).not.toContain('#n40 link "Section 1"');
    expect(text).toContain('  #n60 link "Settings (2)"');
    expect(text).not.toContain('navigation "Sidebar" (');
  });

  it('does not fold a subtree that lost a node, even when the rest is unchanged', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', orderScreen(MAIN_LIST, 12)));
    const after = orderScreen(MAIN_DETAILS, 12).filter((line) => !line.includes('#n5 '));
    const text = presenter.update(screen('b2', after), { lead: 'Tapped #n22.' });
    expect(text).toContain('The screen changed substantially since revision b1.');
    expect(text).not.toContain('nodes inside, unchanged since revision');
    expect(text).toContain(' #n3 link "Item 1"');
  });

  it('does not fold a subtree holding the focused node', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', orderScreen(MAIN_LIST, 12)));
    const after = orderScreen(MAIN_DETAILS, 12).map((line) =>
      (line.includes('#n8 ') ? '  #n8 link "Item 6" [focused]' : line),
    );
    const text = presenter.update(screen('b2', after), { lead: 'Tapped #n22.' });
    expect(text).toContain('The screen changed substantially since revision b1.');
    expect(text).not.toContain('nodes inside, unchanged since revision');
    expect(text).toContain('#n8 link "Item 6" [focused]');
  });

  it('does not fold on a truncated listing, whose cut nodes are unknown', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', orderScreen(MAIN_LIST, 12)));
    // Twelve more added nodes, so the change still trips the whole-screen fallback
    // even though a truncated listing reports no removals.
    const extra = Array.from({ length: 12 }, (_, i) => `  #n${String(i + 40)} button "Extra ${String(i + 1)}"`);
    const after = [...orderScreen(MAIN_DETAILS, 12), ...extra];
    const text = presenter.update(screen('b2', after, { truncated: true }), { lead: 'Tapped #n22.' });
    expect(text).toContain('The screen changed substantially since revision b1.');
    expect(text).not.toContain('nodes inside, unchanged since revision');
    expect(text).toContain(' #n3 link "Item 1"');
  });

  it('sends the first screen whole, with no folding', () => {
    const presenter = new ScreenPresenter();
    const text = presenter.initial(screen('b1', orderScreen(MAIN_LIST, 12)));
    expect(text).toContain('Current screen (revision b1, 18 nodes):');
    expect(text).not.toContain('nodes inside, unchanged since revision');
    expect(text).toContain(' #n3 link "Item 1"');
    expect(text).toContain(' #n14 link "Item 12"');
  });

  it('names the revision that last listed the subtree in full, not an intervening diff', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', orderScreen(MAIN_LIST, 12)));
    // The sidebar is not listed at b2: the diff names only the changed heading.
    const changed = orderScreen(MAIN_LIST, 12).map((line) =>
      (line.includes('#n21 ') ? '  #n21 heading "Orders (2)"' : line),
    );
    const diff = presenter.update(screen('b2', changed));
    expect(diff).toContain('changed #n21 heading "Orders (2)"');
    expect(diff).not.toContain('Current screen');
    const text = presenter.update(screen('b3', orderScreen(MAIN_DETAILS, 12)), { lead: 'Tapped #n22.' });
    expect(text).toContain('The screen changed substantially since revision b2.');
    expect(text).toContain(' #n2 navigation "Sidebar" (12 nodes inside, unchanged since revision b1)');
    expect(text).not.toContain('unchanged since revision b2');
  });

  it('names the original revision when the previous screen itself folded the subtree', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', orderScreen(MAIN_LIST, 12)));
    const first = presenter.update(screen('b2', orderScreen(MAIN_DETAILS, 12)), { lead: 'Tapped #n22.' });
    expect(first).toContain(' #n2 navigation "Sidebar" (12 nodes inside, unchanged since revision b1)');
    const second = presenter.update(screen('b3', orderScreen(MAIN_SEARCH, 12)), { lead: 'Tapped #n43.' });
    expect(second).toContain('The screen changed substantially since revision b2.');
    expect(second).toContain(' #n2 navigation "Sidebar" (12 nodes inside, unchanged since revision b1)');
    expect(second).not.toContain('unchanged since revision b2');
  });

  it('lists a changed subtree in full again, then folds it against that listing', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', orderScreen(MAIN_LIST, 12)));
    const renamed = orderScreen(MAIN_LIST, 12).map((line) =>
      (line.includes('#n5 ') ? '  #n5 link "Item 3 (new)"' : line),
    );
    expect(presenter.update(screen('b2', renamed))).toContain('changed #n5 link "Item 3 (new)"');
    // The sidebar changed at b2, so b3 may not fold it against b1: the model
    // holds the old item text there, not the new one.
    const rename = (lines: readonly string[]): string[] =>
      lines.map((line) => (line.includes('#n5 ') ? '  #n5 link "Item 3 (new)"' : line));
    const relisted = presenter.update(screen('b3', rename(orderScreen(MAIN_DETAILS, 12))), { lead: 'Tapped #n22.' });
    expect(relisted).toContain('The screen changed substantially since revision b2.');
    expect(relisted).not.toContain('nodes inside, unchanged since revision');
    expect(relisted).toContain(' #n5 link "Item 3 (new)"');
    const folded = presenter.update(screen('b4', rename(orderScreen(MAIN_SEARCH, 12))), { lead: 'Tapped #n43.' });
    expect(folded).toContain(' #n2 navigation "Sidebar" (12 nodes inside, unchanged since revision b3)');
    expect(folded).not.toContain('unchanged since revision b1');
  });

  it('still folds against the original revision when a change was undone', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', orderScreen(MAIN_LIST, 12)));
    const renamed = orderScreen(MAIN_LIST, 12).map((line) =>
      (line.includes('#n5 ') ? '  #n5 link "Item 3 (new)"' : line),
    );
    presenter.update(screen('b2', renamed));
    presenter.update(screen('b3', orderScreen(MAIN_LIST, 12)));
    const text = presenter.update(screen('b4', orderScreen(MAIN_DETAILS, 12)), { lead: 'Tapped #n22.' });
    expect(text).toContain(' #n2 navigation "Sidebar" (12 nodes inside, unchanged since revision b1)');
  });

  it('folds against the original listing when an intervening change was undone, even though the previous screen differs', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', orderScreen(MAIN_LIST, 12)));
    const renamed = orderScreen(MAIN_LIST, 12).map((line) =>
      (line.includes('#n5 ') ? '  #n5 link "Item 3 (new)"' : line),
    );
    expect(presenter.update(screen('b2', renamed))).toContain('changed #n5 link "Item 3 (new)"');
    // b3 changes most of the screen and puts the sidebar back as b1 listed
    // it: the fold names b1, since the digest is what the model holds, not
    // the screen before it.
    const text = presenter.update(screen('b3', orderScreen(MAIN_DETAILS, 12)), { lead: 'Tapped #n22.' });
    expect(text).toContain('The screen changed substantially since revision b2.');
    expect(text).toContain(' #n2 navigation "Sidebar" (12 nodes inside, unchanged since revision b1)');
  });

  it('a truncated full screen clears the fold record, so the next fallback lists the subtree in full instead of naming an elided screen', () => {
    const presenter = new ScreenPresenter();
    const b1 = presenter.initial(screen('b1', orderScreen(MAIN_LIST, 12)));
    const b2 = presenter.update(screen('b2', orderScreen(MAIN_DETAILS, 12)), { lead: 'Tapped #n22.' });
    expect(b2).toContain(' #n2 navigation "Sidebar" (12 nodes inside, unchanged since revision b1)');
    // b3 is a truncated full screen: it records nothing and folds nothing.
    const extra = Array.from({ length: 12 }, (_, i) => `  #n${String(i + 60)} button "Extra ${String(i + 1)}"`);
    const b3 = presenter.update(screen('b3', [...orderScreen(MAIN_SEARCH, 12), ...extra], { truncated: true }), { lead: 'Tapped #n43.' });
    expect(b3).toContain('The screen changed substantially since revision b2.');
    expect(b3).not.toContain('nodes inside, unchanged since revision');
    // By the time b4 renders, compaction has already elided b1 and b2: the
    // truncated screen carries no fold, so nothing preserves them.
    const messages = [b1, b2, b3].map((text, index) => toolResult(`c${String(index)}`, text));
    const compacted = compactScreenHistory(messages, { keepStaleBytes: 0 });
    const b1Text = toolText(compacted[0]!);
    expect(b1Text).toContain('[earlier screen elided');
    expect(b1Text).not.toContain('#n3 link "Item 1"');
    // The record b3 cleared means b4 cannot fold against b1: the sidebar is
    // listed in full again instead of naming a screen the model no longer holds.
    const b4 = presenter.update(screen('b4', orderScreen(MAIN_DETAILS, 12)), { lead: 'Tapped #n22.' });
    expect(b4).toContain('The screen changed substantially since revision b3.');
    expect(b4).not.toContain('nodes inside, unchanged since revision');
    expect(b4).toContain(' #n3 link "Item 1"');
    expect(b4).toContain(' #n14 link "Item 12"');
  });

  it('drops the fold record when a subtree leaves the screen, so a re-added subtree is listed in full', () => {
    const presenter = new ScreenPresenter();
    const extras = [
      ' #n50 group "Extras"',
      ...Array.from({ length: 24 }, (_, i) => `  #n${String(60 + i)} button "Extra ${String(i + 1)}"`),
    ];
    const wide = (main: readonly string[], sidebarCount: number): string[] =>
      ['#n1 document "Orders"', ...sidebar(sidebarCount), ...main, ...extras];
    presenter.initial(screen('b1', wide(MAIN_LIST, 12)));
    // The sidebar leaves in a change update: 13 removed lines of 43 nodes.
    const removed = presenter.update(screen('b2', ['#n1 document "Orders"', ...MAIN_LIST, ...extras]));
    expect(removed).toContain('removed #n2 navigation "Sidebar"');
    expect(removed).not.toContain('Current screen');
    const readded = presenter.update(screen('b3', wide(MAIN_LIST, 12)));
    expect(readded).toContain('added #n2 navigation "Sidebar"');
    expect(readded).not.toContain('Current screen');
    // The record was dropped when the sidebar left, so the fallback lists it
    // in full even though it reads exactly as b1 listed it.
    const renamedExtras = extras.map((line, index) =>
      (index > 0 ? line.replace(/Extra (\d+)/, 'Extra $1 (new)') : line),
    );
    const text = presenter.update(screen('b4', ['#n1 document "Orders"', ...sidebar(12), ...MAIN_DETAILS, ...renamedExtras]), { lead: 'Tapped #n22.' });
    expect(text).toContain('The screen changed substantially since revision b3.');
    expect(text).not.toContain('nodes inside, unchanged since revision');
    expect(text).toContain(' #n3 link "Item 1"');
  });

  it('never folds a top-level root, even one holding enough unchanged nodes', () => {
    const presenter = new ScreenPresenter();
    // A second top-level root with its leaves directly under it: the root
    // itself is the only node that could fold, and its indent is 0.
    const second = [
      '#n50 document "Second"',
      ...Array.from({ length: 12 }, (_, i) => ` #n${String(60 + i)} link "Second ${String(i + 1)}"`),
    ];
    const first = [
      '#n1 document "First"',
      ' #n2 heading "First"',
      ' #n3 button "First 1"',
      ' #n4 button "First 2"',
      ' #n5 button "First 3"',
    ];
    presenter.initial(screen('b1', [...first, ...second]));
    const changedFirst = [
      '#n1 document "First (new)"',
      ' #n2 heading "First changed"',
      ...Array.from({ length: 9 }, (_, i) => ` #n${String(70 + i)} button "New ${String(i + 1)}"`),
    ];
    const text = presenter.update(screen('b2', [...changedFirst, ...second]), { lead: 'Tapped #n3.' });
    expect(text).toContain('The screen changed substantially since revision b1.');
    expect(text).not.toContain('nodes inside, unchanged since revision');
    expect(text).toContain('#n50 document "Second"');
    expect(text).toContain(' #n60 link "Second 1"');
  });
});

describe('ScreenPresenter and the on-screen keyboard', () => {
  const KEYBOARD = [
    ' #n20 keyboard "Padding-Left"',
    '  #n21 key "q"',
    '  #n22 key "w"',
  ];
  const FORM = [
    '#n1 document "Sign in"',
    ' #n2 heading "Welcome back"',
    ' #n3 textbox "Email" value="a@b.c"',
    ' #n4 textbox "Password" value=<secure>',
    ' #n5 link "Forgot password"',
    ' #n6 checkbox "Remember me"',
    ' #n7 button "Log in"',
    ' #n8 text "No account yet?"',
  ];

  it('tells the model when an action closed the keyboard, so a swallowed tap is retried', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', [...FORM, ...KEYBOARD]));
    const text = presenter.update(screen('b2', FORM), { lead: 'Tapped #n7.', expectChange: true });
    expect(text).toContain('removed #n20 keyboard "Padding-Left"');
    expect(text).toContain('The on-screen keyboard closed with this action.');
    expect(text).toContain('act on it again now that the keyboard is down');
    const keys = Array.from({ length: 40 }, (_, i) => `  #k${String(i)} key "${String(i)}"`);
    presenter.initial(screen('b3', [...FORM, ' #n20 keyboard "Padding-Left"', ...keys]));
    const whole = presenter.update(screen('b4', FORM), { lead: 'Tapped #n3.', expectChange: true });
    expect(whole).toContain('changed substantially');
    expect(whole).toContain('The on-screen keyboard closed with this action.');
  });

  it('stays quiet on a truncated listing, an explicit dismissal, or a keyboard that stays or appears, through update and present', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', [...FORM, ...KEYBOARD]));
    expect(presenter.update(screen('b2', FORM, { truncated: true }), { lead: 'Tapped #n7.', expectChange: true })).not.toContain('keyboard closed');
    presenter.initial(screen('b1', [...FORM, ...KEYBOARD]));
    expect(presenter.update(screen('b2', FORM), { lead: 'Dismissed the keyboard.', keyboardNote: false })).not.toContain('keyboard closed');
    presenter.initial(screen('b3', FORM));
    expect(presenter.update(screen('b4', [...FORM, ...KEYBOARD]), { lead: 'Tapped #n2.' })).not.toContain('keyboard closed');
    expect(presenter.update(screen('b5', [...FORM, ...KEYBOARD]), { lead: 'Tapped #n3.' })).not.toContain('keyboard closed');
    const grammar = new ScreenPresenter();
    grammar.open(screen('b1', [...FORM, ...KEYBOARD]));
    expect(grammar.present(screen('b2', FORM), { lead: 'Dismissed the keyboard.', expectChange: false, keyboardNote: false })).not.toContain('keyboard closed');
    grammar.present(screen('b3', [...FORM, ...KEYBOARD]), { lead: 'Tapped #n3.' });
    expect(grammar.present(screen('b4', FORM), { lead: 'Tapped #n7.' })).toContain('The on-screen keyboard closed with this action.');
  });
});
