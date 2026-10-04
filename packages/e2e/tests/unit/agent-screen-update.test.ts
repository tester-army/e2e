import { describe, expect, it } from 'vitest';
import type { ExecutorObservation } from '../../src/agent/executor.ts';
import { ScreenPresenter } from '../../src/agent/screen-update.ts';

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

  it('keeps the listing as the only evidence, and says to try another way, when the step can get no screenshot', () => {
    const textOf = (output: ReturnType<ScreenPresenter['present']>) => (typeof output === 'string' ? output : output.text);
    let tainted = false;
    const presenter = new ScreenPresenter({ pixelsUnavailable: () => tainted });
    presenter.open(screen('b1', HOME));
    tainted = true;
    // A secret was filled: no pixel tool is offered, so pointing at a screenshot would be advice the model cannot follow.
    const after = textOf(presenter.present(screen('b2', HOME), { lead: 'Tapped #n3.', expectChange: true }));
    expect(after).toContain('No screenshot can be taken in this step');
    expect(after).toContain('look for another way rather than repeating it');
    expect(after).not.toContain('needs a screenshot to see');
    // An engine that captures none says so once asked; from then on the same holds.
    const denied = new ScreenPresenter();
    denied.open(screen('c1', HOME));
    denied.present(screen('c2', HOME, { pixelsWithheld: 'UNSUPPORTED_CAPABILITY' }));
    expect(textOf(denied.present(screen('c3', HOME), { lead: 'Tapped #n3.', expectChange: true }))).toContain('No screenshot can be taken in this step');
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
