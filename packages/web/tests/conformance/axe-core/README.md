Test cases derived from the axe-core test suite
(https://github.com/dequelabs/axe-core/tree/develop/test), taken as Playwright
vendors them in `tests/assets/axe-core/` at microsoft/playwright
`b9a34ac7783a1b6c2e1dfff0c08ac744c048fa59`. Mozilla Public License 2.0, see
`LICENSE`.

- `implicit-role.cjs`: cases extracted from `/test/commons/aria/implicit-role.js`.
- `accessible-text.cjs`: cases extracted from `/test/commons/aria/accessible-text.js`.

Both are Playwright's files byte for byte, renamed to `.cjs` because this
package is an ES module. Update them by copying again, never by hand; a case
the engine reads differently belongs in `../expected.txt` with a reason.
