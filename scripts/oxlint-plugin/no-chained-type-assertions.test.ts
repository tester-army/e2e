import { describe, it } from 'node:test';
import { RuleTester } from 'oxlint/plugins-dev';
import { noChainedTypeAssertions } from './no-chained-type-assertions.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } });
const chained = { messageId: 'chained' };

tester.run('e2e/no-chained-type-assertions', noChainedTypeAssertions, {
  valid: [
    'const value = input as User;',
    'const value = (input as User);',
    'const value = <User>input;',
    'const value = ({ id: 1 } as const) as const;',
    'const value = (input as User).name as string;',
  ],
  invalid: [
    { code: 'const value = input as unknown as User;', errors: [chained] },
    { code: 'const value = (input as unknown) as User;', errors: [chained] },
    { code: 'const value = <User>(<unknown>input);', errors: [chained] },
    { code: 'const value = <User>(input as unknown);', errors: [chained] },
    { code: 'const value = ({ id: 1 } as const) as User;', errors: [chained] },
    { code: 'const value = input as unknown as Partial<User> as User;', errors: [chained] },
  ],
});
