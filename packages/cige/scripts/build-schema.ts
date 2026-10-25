/** Writes `schema/cige-1.schema.json` from the zod schema (`src/json-schema.ts`). Run by `build`. */

import { writeFileSync } from 'node:fs';

import { cigeJsonSchema } from '../src/json-schema.ts';

writeFileSync(new URL('../schema/cige-1.schema.json', import.meta.url), `${JSON.stringify(cigeJsonSchema(), null, 2)}\n`);
