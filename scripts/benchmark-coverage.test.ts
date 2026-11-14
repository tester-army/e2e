import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mobileNames, mobileProblems, webProblems, webSlugs } from './benchmark-coverage.ts';

describe('webSlugs', () => {
  it('reads every slug a catalog declares, in file order', () => {
    const source = `
      { component: LoginForm, slug: "login-form", name: "Login Form" },
      { component: FileRoundTrip, slug: "file-round-trip", name: "File Round Trip" },
    `;
    assert.deepEqual(webSlugs(source), ['login-form', 'file-round-trip']);
  });
});

describe('mobileNames', () => {
  it('reads the name of each component entry, in file order', () => {
    const source = `
  {
    component: LoginForm,
    name: "Login Form",
    description: "Fill credentials.",
  },
  {
    component: ModalFlow,
    name: "Modal Flow",
    platform: "ios",
  },
`;
    assert.deepEqual(mobileNames(source), ['Login Form', 'Modal Flow']);
  });

  it('reads a name whatever else the entry orders around it, and skips the unquoted type', () => {
    const source = `
export type Example = { component: ComponentType; name: string; };
  {
    name: "Name First",
    component: NameFirst,
  },
  {
    component: Quoted,
    name: 'Single Quoted',
  },
`;
    assert.deepEqual(mobileNames(source), ['Name First', 'Single Quoted']);
  });
});

describe('webProblems', () => {
  const slugs = ['login-form', 'canvas-only'];
  const testFiles = new Set(['login-form.e2e.ts', 'canvas-only.e2e.ts']);

  it('is empty when every slug has its twin, whatever the agentic suite covers', () => {
    assert.deepEqual(webProblems({ slugs, testFiles }), []);
    // The web agentic suite is intentionally partial, so a slug it never touches is not a gap.
    assert.deepEqual(webProblems({ slugs: ['div-soup'], testFiles: new Set(['div-soup.e2e.ts']) }), []);
  });

  it('reports a slug with no deterministic twin, naming the file the README promises', () => {
    assert.deepEqual(webProblems({ slugs: ['login-form'], testFiles: new Set() }), [
      'web: login-form has no tests/login-form.e2e.ts; the README promises every scenario a deterministic twin',
    ]);
  });
});

describe('mobileProblems', () => {
  const scenarios = "name: 'Login Form',\nname: 'Modal Flow',";

  it('is empty when every name has an entry or is on the allowed list', () => {
    const problems = mobileProblems({ names: ['Login Form', 'Control Inventory'], scenariosSource: scenarios, withoutAgent: ['Control Inventory'] });
    assert.deepEqual(problems, []);
  });

  it('reports a catalog name the agentic suite never declares', () => {
    const problems = mobileProblems({ names: ['Login Form', 'Huge Virtualized List'], scenariosSource: scenarios, withoutAgent: [] });
    assert.deepEqual(problems, ['mobile: Huge Virtualized List has no entry in tests-agent/scenarios.e2e.ts; the README promises one agent.act per scenario']);
  });

  it('accepts an entry in either quote style, so formatting alone never hides one', () => {
    const doubleQuoted = 'name: "Modal Flow",';
    assert.deepEqual(mobileProblems({ names: ['Modal Flow'], scenariosSource: doubleQuoted, withoutAgent: [] }), []);
    assert.deepEqual(mobileProblems({ names: ['Modal Flow'], scenariosSource: scenarios, withoutAgent: [] }), []);
  });
});
