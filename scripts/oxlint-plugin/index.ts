import { definePlugin } from '@oxlint/plugins';
import { noChainedTypeAssertions } from './no-chained-type-assertions.ts';
import { noUncheckedJson } from './no-unchecked-json.ts';

export default definePlugin({
  meta: { name: 'e2e' },
  rules: {
    'no-chained-type-assertions': noChainedTypeAssertions,
    'no-unchecked-json': noUncheckedJson,
  },
});
