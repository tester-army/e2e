---
"e2e": patch
---

`e2e login` on Windows no longer opens the sign-in URL through a command interpreter. The URL comes from the provider's own response in the device flow, and `cmd /c start` read a `|`, `&`, or `^` in it as command syntax, so a URL that carried one ran a command of its own. The URL is now handed to the default handler for its scheme as a single argument, and only an `http:` or `https:` URL is opened; any other scheme is printed for you to open yourself.
