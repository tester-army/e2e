import { describe, expect, it } from 'vitest';
import { BackendError, type LocatorExpression, type SemanticNode } from '@e2edev/e2e/backend';
import { resolveExpression } from '../../src/locate.ts';
import { projectScreen, segmentsOf } from '../../src/nodes.ts';
import { captureArgs, parseCapture, screenText } from '../../src/screen.ts';
import { openCodeScreen } from '../helpers/fake-tmux.ts';

function minted(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `n${counter}`;
  };
}

const PROMPT = 'Ask anything... "Fix a TODO in the codebase"';

describe('parseCapture', () => {
  it('reads the metadata line and pads the rows to the pane height', () => {
    const screen = parseCapture('6\t1\t1\t40\t5\t1\t1\t0\t\topencode\tOpen Code\nfirst   \n\nthird\n');
    expect(screen).toEqual({
      lines: ['first', '', 'third', '', ''],
      cursor: { x: 6, y: 1, visible: true },
      width: 40,
      height: 5,
      mouse: true,
      alternate: true,
      dead: false,
      command: 'opencode',
      title: 'Open Code',
    });
    expect(screenText(screen)).toBe('first\n\nthird');
  });

  it('reports a dead pane with its exit status', () => {
    const screen = parseCapture('0\t0\t0\t10\t2\t0\t0\t1\t130\tbash\t\nbye\n');
    expect(screen.dead).toBe(true);
    expect(screen.exitStatus).toBe(130);
    expect(screen.title).toBe('');
  });

  it('captures the metadata and the rows in one tmux command line', () => {
    const args = captureArgs('@3');
    expect(args[0]).toBe('display-message');
    expect(args).toContain(';');
    expect(args.slice(args.indexOf(';') + 1)).toEqual(['capture-pane', '-p', '-t', '@3']);
  });

  it('rejects an empty capture', () => {
    expect(() => parseCapture('')).toThrow(BackendError);
  });
});

describe('segmentsOf', () => {
  it('splits a row into columns at two or more spaces and drops decoration', () => {
    expect(segmentsOf('  /agents          Switch agent  ')).toEqual([
      { x: 2, text: '/agents' },
      { x: 19, text: 'Switch agent' },
    ]);
    expect(segmentsOf('   |  [ Yes ]   [ No ]')).toEqual([
      { x: 6, text: '[ Yes ]' },
      { x: 16, text: '[ No ]' },
    ]);
    expect(segmentsOf('┃┃┃  ----  ====  ##  ▀▀█')).toEqual([]);
    expect(segmentsOf('a single spaced sentence')).toEqual([{ x: 0, text: 'a single spaced sentence' }]);
    // A border one space from the text is decoration too; a dash inside a sentence is not.
    expect(segmentsOf('  ┃ /help       Help                ┃')).toEqual([
      { x: 4, text: '/help' },
      { x: 16, text: 'Help' },
    ]);
    expect(segmentsOf('| a - b |')).toEqual([{ x: 2, text: 'a - b' }]);
  });
});

describe('projectScreen', () => {
  it('is one application root with a node per column, rows wrapping several columns, and a focused textbox under the cursor', () => {
    const projected = projectScreen(openCodeScreen(), minted());
    const root = projected.root;
    expect(root.role).toBe('application');
    expect(root.name).toBe('OpenCode');
    expect(root.rect).toEqual({ x: 0, y: 0, width: 60, height: 6 });
    expect(projected.viewport).toEqual({ width: 60, height: 6, scale: 1 });

    const children = root.children ?? [];
    expect(children.map((child) => [child.role, child.name, child.rect?.y])).toEqual([
      ['textbox', PROMPT, 1],
      ['text', 'Build - Claude Haiku 4.5 (latest) Anthropic', 3],
      ['row', undefined, 4],
    ]);
    expect(children[0]?.states).toEqual({ focused: true });
    expect(children[0]?.rect).toEqual({ x: 6, y: 1, width: PROMPT.length, height: 1 });

    const status = children[2] as SemanticNode;
    expect(status.rect).toEqual({ x: 25, y: 4, width: 27, height: 1 });
    expect(status.children?.map((cell) => [cell.role, cell.name, cell.rect?.x])).toEqual([
      ['text', 'tab agents', 25],
      ['text', 'ctrl+p commands', 37],
    ]);
    expect(projected.index.map((entry) => entry.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    expect(projected.index[4]?.parent?.id).toBe('n4');
  });

  it('puts the textbox on the column the cursor is in, including right after its last character', () => {
    const base = openCodeScreen();
    const typed = { ...base, lines: ['> hello world  [Send]', '', ''], cursor: { x: 13, y: 0, visible: true } };
    const row = projectScreen(typed, minted()).root.children?.[0] as SemanticNode;
    expect(row.role).toBe('row');
    expect(row.children?.map((cell) => [cell.role, cell.name])).toEqual([
      ['textbox', '> hello world'],
      ['text', '[Send]'],
    ]);

    const onButton = { ...typed, cursor: { x: 16, y: 0, visible: true } };
    const cells = projectScreen(onButton, minted()).root.children?.[0]?.children ?? [];
    expect(cells.map((cell) => cell.role)).toEqual(['text', 'textbox']);
  });

  it('keeps a blank cursor row as an empty textbox so the model has a target to type into', () => {
    const screen = { ...openCodeScreen(), lines: ['', '', ''], cursor: { x: 4, y: 1, visible: true } };
    const children = projectScreen(screen, minted()).root.children ?? [];
    expect(children).toHaveLength(1);
    expect(children[0]?.role).toBe('textbox');
    expect(children[0]?.name).toBeUndefined();
    expect(children[0]?.rect).toEqual({ x: 4, y: 1, width: 1, height: 1 });
  });

  it('marks a hidden cursor as no textbox at all', () => {
    const screen = { ...openCodeScreen(), cursor: { x: 6, y: 1, visible: false } };
    const projected = projectScreen(screen, minted());
    expect(projected.index.every((entry) => entry.node.role !== 'textbox')).toBe(true);
  });

  it('names the root after the command when the program set no title, and reports an exit', () => {
    const screen = { ...openCodeScreen(), title: '', command: 'vim', dead: true, exitStatus: 1 };
    const projected = projectScreen(screen, minted());
    expect(projected.root.name).toBe('vim');
    expect(projected.root.states).toEqual({ disabled: true });
    const last = projected.root.children?.at(-1);
    expect(last?.role).toBe('status');
    expect(last?.text).toBe('the program exited with status 1');
  });
});

describe('resolveExpression', () => {
  const projected = projectScreen(openCodeScreen(), minted());
  const text = (value: string | RegExp, exact = true): LocatorExpression => ({
    kind: 'query',
    query: {
      kind: 'text',
      value:
        typeof value === 'string'
          ? { kind: 'string', value, exact }
          : { kind: 'regexp', source: value.source, flags: value.flags },
    },
  });
  const ids = (expression: LocatorExpression): string[] => resolveExpression(expression, projected.index).map((entry) => entry.id);

  it('answers text queries exactly, as substrings, and as regular expressions', () => {
    expect(ids(text('ctrl+p commands'))).toEqual(['n6']);
    expect(ids(text('ctrl+p'))).toEqual([]);
    expect(ids(text('ctrl+p', false))).toEqual(['n6']);
    expect(ids(text(/^Ask anything/))).toEqual(['n2']);
    expect(ids(text('nowhere'))).toEqual([]);
  });

  it('answers role queries with a name and honours first/last and hasText filters', () => {
    const textbox: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true } },
    };
    expect(ids(textbox)).toEqual(['n2']);
    const rows: LocatorExpression = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'text', exact: true } } };
    expect(ids(rows)).toEqual(['n3', 'n5', 'n6']);
    expect(ids({ kind: 'index', source: rows, index: 'last' })).toEqual(['n6']);
    expect(ids({ kind: 'filter', source: rows, hasText: { kind: 'string', value: 'Build', exact: false } })).toEqual(['n3']);
  });

  it('scopes a query to a row and filters rows by what they contain', () => {
    const row: LocatorExpression = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'row', exact: true } } };
    const scoped: LocatorExpression = {
      kind: 'query',
      query: { kind: 'text', value: { kind: 'string', value: 'tab agents', exact: true } },
      scope: row,
    };
    expect(ids(scoped)).toEqual(['n5']);
    expect(ids({ kind: 'filter', source: row, hasText: { kind: 'string', value: 'ctrl+p', exact: false } })).toEqual(['n4']);
    expect(ids({ kind: 'filter', source: row, has: text('nowhere') })).toEqual([]);
  });

  it('has no selector language and no frames', () => {
    expect(() => resolveExpression({ kind: 'selector', selector: 'x' }, projected.index)).toThrow(/selector language/);
    let caught: unknown;
    try {
      resolveExpression({ kind: 'frame', selector: 'x', source: text('a') }, projected.index);
    } catch (error) {
      caught = error;
    }
    expect((caught as BackendError).code).toBe('FRAME_NOT_FOUND');
  });
});
