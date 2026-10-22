import { describe, it } from 'node:test';
import { RuleTester } from 'oxlint/plugins-dev';
import { noUncheckedJson } from './no-unchecked-json.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } });
const unchecked = { messageId: 'unchecked' };

tester.run('e2e/no-unchecked-json', noUncheckedJson, {
  valid: [
    'const value: unknown = JSON.parse(text);',
    'const value: unknown = JSON.parse(text) satisfies User;',
    'function load(): unknown { return JSON.parse(text) satisfies User; }',
    'const value = JSON.parse(text) as unknown;',
    'const value: unknown = await response.json();',
    'const value: Promise<unknown> = response.json();',
    'const value = Schema.parse(await response.json());',
    'let value: unknown; value = JSON.parse(text);',
    'function load(): unknown { return JSON.parse(text); }',
    'async function load(): Promise<unknown> { return response.json(); }',
    'const value: unknown = await fetch(url).then((r) => r.json());',
    'const value: unknown = await fetch(url).then(function (r) { return r.json(); });',
    'const value = parser.parse(text) as User;',
    'const response = Response.json(body) as Response;',
    'const value = JSON.stringify(user) as string;',
  ],
  invalid: [
    { code: 'const value = JSON.parse(text) as User;', errors: [unchecked] },
    { code: 'const value = <User>JSON.parse(text);', errors: [unchecked] },
    { code: 'const value = JSON.parse(text) satisfies User;', errors: [unchecked] },
    { code: 'const value = JSON.parse(text) satisfies unknown;', errors: [unchecked] },
    { code: 'const value = (await response.json()) satisfies User;', errors: [unchecked] },
    { code: 'let value: User; value = JSON.parse(text) satisfies User;', errors: [unchecked] },
    { code: 'function load(): User { return JSON.parse(text) satisfies User; }', errors: [unchecked] },
    { code: 'const value = JSON.parse(text, reviver) as User;', errors: [unchecked] },
    { code: 'const value = JSON.parse(text)! as User;', errors: [unchecked] },
    { code: 'const value: User = JSON.parse(text);', errors: [unchecked] },
    { code: 'const value = JSON.parse(text);', errors: [unchecked] },
    { code: 'const { name } = JSON.parse(text);', errors: [unchecked] },
    { code: 'const value = (await response.json()) as User;', errors: [unchecked] },
    { code: 'const value = (await response?.json()) as User;', errors: [unchecked] },
    { code: 'const value: Promise<User> = response.json();', errors: [unchecked] },
    { code: 'const value = await fetch(url).then((r) => r.json());', errors: [unchecked] },
    { code: 'const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;', errors: [unchecked] },
    { code: 'let value: User; value = JSON.parse(text);', errors: [unchecked] },
    { code: 'function load(): User { return JSON.parse(text); }', errors: [unchecked] },
    { code: 'const load = async (): Promise<User> => response.json();', errors: [unchecked] },
    { code: 'function load() { return JSON.parse(text); }', errors: [unchecked] },
    { code: 'const load = () => JSON.parse(text);', errors: [unchecked] },
    { code: 'class Store { load() { return JSON.parse(text); } }', errors: [unchecked] },
  ],
});
