---
"e2e": patch
---

`agent.assert` and `agent.waitFor` take `params`, like `agent.act`. The judge reads `{name}` with its value, a `unique()` value included. A `Secret` reaches the judge by name only, so check a secret's value on screen with a locator assertion.

```ts
const name = unique(`acme-${Date.now()}`);
await agent.act('create a company named {name}', { params: { name } });
await agent.assert('the table shows company {name}', { params: { name } });
```
