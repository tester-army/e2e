/** The document shell every playground page shares: the stylesheet and the nav. */

import { nav } from './pages/index.mjs';

/** One page's content in the shell; the nav lists every registered page. */
export function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 640px; }
    nav a { margin-right: 0.75rem; }
    li { margin: 0.25rem 0; }
    .done label { text-decoration: line-through; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <nav aria-label="Main">
    ${nav.map(({ path, label }) => `<a href="${path}">${label}</a>`).join('\n    ')}
  </nav>
  ${body}
</body>
</html>`;
}
