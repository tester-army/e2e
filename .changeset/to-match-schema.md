---
'e2e': minor
---

`expect(value).toMatchSchema(schema)` validates a value against a synchronous Standard Schema (Zod, Valibot, ArkType) and returns the schema's output, typed: `const users = expect(await response.json()).toMatchSchema(z.array(User))`. A failure lists every issue by its path. `expect.poll(read).toMatchSchema(schema)` resolves to the output of the passing read, and `expect.soft(value).toMatchSchema(schema)` returns `undefined` after a kept failure. A schema that validates asynchronously is `INVALID_ARGUMENT`.
