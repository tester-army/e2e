import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { describeLocate, locateQuery } from '../../src/mcp/catalog.ts';

function node(role: string, name: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id: 'l1', revision: 'l1' }, role, name, ...extra };
}

describe('locateQuery', () => {
  it('builds the role query and the matching screen call', () => {
    const query = locateQuery({ role: 'button', name: 'Save' });
    expect(query.code).toBe('screen.getByRole("button", { name: "Save" })');
    expect(query.expression).toMatchObject({ kind: 'query', query: { kind: 'role', name: { kind: 'string', value: 'Save', exact: true } } });
  });

  it('carries exact: false into both the expression and the code', () => {
    const query = locateQuery({ text: 'sign', exact: false });
    expect(query.code).toBe('screen.getByText("sign", { exact: false })');
    expect(query.expression).toMatchObject({ query: { kind: 'text', value: { exact: false } } });
    expect(locateQuery({ label: 'Email' }).code).toBe('screen.getByLabel("Email")');
    expect(locateQuery({ placeholder: 'you@example.test' }).code).toBe('screen.getByPlaceholder("you@example.test")');
    expect(locateQuery({ testId: 'items' }).code).toBe('screen.getByTestId("items")');
  });

  it('rejects zero or several query kinds and a name without a role', () => {
    expect(() => locateQuery({})).toThrow(/exactly one of role, text, label, placeholder, or testId/);
    expect(() => locateQuery({ role: 'button', text: 'Save' })).toThrow(/exactly one/);
    expect(() => locateQuery({ text: 'Save', name: 'Save' })).toThrow(/name only narrows a role query/);
  });
});

describe('describeLocate', () => {
  it('tells the agent which test outcome the locator would have', () => {
    const query = locateQuery({ role: 'button', name: 'Save' });
    expect(describeLocate(query, 1, [node('button', 'Save')])).toBe(
      '1 node matches getByRole("button", name: "Save").\nUse: screen.getByRole("button", { name: "Save" })\n- button "Save"',
    );
    expect(describeLocate(query, 0, [])).toContain('LOCATOR_NOT_FOUND');
    const ambiguous = describeLocate(query, 12, [node('button', 'Save', { states: { disabled: true } })]);
    expect(ambiguous).toContain('12 nodes match');
    expect(ambiguous).toContain('LOCATOR_AMBIGUOUS');
    expect(ambiguous).toContain('- button "Save" [disabled]');
    expect(ambiguous).toContain('- and 11 more');
  });

  it('never shows the value of a secure node', () => {
    const query = locateQuery({ label: 'Password' });
    const text = describeLocate(query, 1, [node('textbox', 'Password', { value: 'hunter2', states: { secure: true } })]);
    expect(text).not.toContain('hunter2');
    expect(text).toContain('[secure]');
  });
});
