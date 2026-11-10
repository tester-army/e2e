---
"e2e": patch
---

A startup failure now quotes the first lines of a long `command.log` as well as the last, with `[startup output omitted]` between them, so the error a service printed before it kept logging survives in the `APP_UNREACHABLE` message.
