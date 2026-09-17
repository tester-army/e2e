import { describe, expect, it } from 'vitest';
import { acceptsText, candidatesOf, isSecure, pagesOf, shapeOf } from '../../src/screen.ts';
import { literalsOf } from '../../src/values.ts';

const SCREEN = [
  '#n1 heading "Todos"',
  '#n2 textbox "What needs to be done?"',
  ' #n3 button "Add"',
  '#n4 checkbox "Toggle Todo" [checked]',
  '#n5 button "Save" [disabled]',
  '#n6 textbox "Password" value=<secure> purpose=password',
  '#n7 text="Some copy"',
  '#n8 link "Completed" href="/completed" [selected focused]',
].join('\n');

describe('candidatesOf', () => {
  it('lists interactive, enabled nodes in document order', () => {
    expect(candidatesOf(SCREEN).map((c) => c.id)).toEqual(['n2', 'n3', 'n4', 'n6', 'n8']);
  });
  it('keeps the trimmed line as the option text', () => {
    expect(candidatesOf(SCREEN)[1]?.line).toBe('#n3 button "Add"');
  });
  it('knows which candidates take text or are secure', () => {
    const [field, add, , password] = candidatesOf(SCREEN);
    expect(acceptsText(field!)).toBe(true);
    expect(acceptsText(add!)).toBe(false);
    expect(isSecure(password!)).toBe(true);
    expect(isSecure(field!)).toBe(false);
  });
});

describe('shapeOf', () => {
  it('ignores ids and focus so an unchanged screen compares equal', () => {
    const moved = SCREEN.replaceAll('#n', '#m').replace(' [selected focused]', ' [selected]');
    expect(shapeOf(moved)).toBe(shapeOf(SCREEN));
  });
  it('sees a state change', () => {
    expect(shapeOf(SCREEN.replace('[checked]', ''))).not.toBe(shapeOf(SCREEN));
  });
});

describe('pagesOf', () => {
  it('cuts a long list into pages of the given size', () => {
    expect(pagesOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('literalsOf', () => {
  it('collects quoted literals and string params, deduplicated', () => {
    expect(literalsOf('Log in with "alice" and password "secret", then type "alice"', { note: 'hello', n: 3 })).toEqual([
      'alice',
      'secret',
      'hello',
      '3',
    ]);
  });
  it('returns nothing for a step that spells out no value', () => {
    expect(literalsOf('Add a todo of your choice', undefined)).toEqual([]);
  });
});

describe('scrollTargetsOf', () => {
  it('lists landmarks and test-id tagged containers, not the root or plain text', async () => {
    const { scrollTargetsOf } = await import('../../src/screen.ts');
    const text = [
      '#root document "App"',
      ' #n2 main',
      '  #n5 text="Scroll until you find it."',
      '  #n6 testid="feed"',
      '   #n7 testid="feed-item"',
      '  #n9 button "Claim"',
    ].join('\n');
    expect(scrollTargetsOf(text).map((c) => c.id)).toEqual(['n2', 'n6', 'n7']);
  });
});

describe('diffShapes', () => {
  it('lists the lines that appeared and disappeared, ignoring indentation', async () => {
    const { diffShapes } = await import('../../src/screen.ts');
    const before = 'list\n listitem "Buy milk"\n listitem "Walk the dog"\ntext="2 items left"';
    const after = 'list\n listitem "Buy milk"\ntext="1 item left"';
    expect(diffShapes(before, after)).toEqual({ added: ['text="1 item left"'], removed: ['listitem "Walk the dog"', 'text="2 items left"'] });
  });
});
