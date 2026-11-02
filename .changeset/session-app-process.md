---
"e2e": patch
---

`open_session` now names the app command it started: its executable, the URL it answers on, the port a free-port `url` was assigned, and the `env` and `inheritEnv` names it got. It prints no `args` and no `env` values. It also says the config reads the MCP server's environment, not the agent's shell. `e2e run` prints the URL on the app command's setup line, and the `app` setup event carries it as `url`.
