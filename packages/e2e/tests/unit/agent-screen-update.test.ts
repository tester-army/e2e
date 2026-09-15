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
    expect(afterAction).toContain('did not change within the wait after this action');
    expect(afterAction).toContain('re-observed as revision b3');
  });

  it('ignores focus moving, which every action does, when deciding what changed', () => {
    const presenter = new ScreenPresenter();
    presenter.initial(screen('b1', HOME));
    const focused = [...HOME];
    focused[2] = ' #n3 button "Increment" [focused]';
    expect(presenter.update(screen('b2', focused), { lead: 'Tapped #n3.', expectChange: true })).toContain(
      'did not change within the wait',
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
