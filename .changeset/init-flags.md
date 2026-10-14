---
"e2e": minor
---

`e2e init` takes a flag per wizard question: `--engine`, `--gateway`, `--endpoint`, `--skills`, `--mcp`, and `--install`/`--no-install`. A flag skips its prompt; with `--yes`, an omitted flag keeps its default. Without a terminal, pass `--yes`. `--endpoint` implies `--gateway openai-compatible`. `--skills` and `--mcp` take comma-separated locations or `none`. An unknown value exits 2 before any write and lists the valid ones.

```sh
npx e2e init --yes --gateway openrouter --skills .agents/skills --mcp .mcp.json --install
```
