/** A windowed list whose scrolling animates after the wheel event, as a smooth-scroll library does. */

import type { PageRenderer } from './page.ts';

const ROWS = 300;
const ROW_HEIGHT = 60;

/**
 * `?smooth=js` eases the document to the wheel's target over `?ms=` (450 by default) with
 * `requestAnimationFrame`, the way Lenis-style libraries do; `?smooth=css`
 * hands the target to `scrollTo` under `scroll-behavior: smooth`. Without
 * either the wheel scrolls natively. Rows draw their text only once scrolled
 * into view, as a windowed list does, so a row far down is not in the tree
 * until the page reaches it.
 */
export const SCROLL_PAGES: Record<string, PageRenderer> = {
  '/smooth-scroll': (_state, url) => {
    const smooth = url.searchParams.get('smooth') ?? 'none';
    const duration = Number(url.searchParams.get('ms') ?? 450);
    return `<!doctype html>
<html>
<head><title>Smooth scroll</title>
<style>
  html { ${smooth === 'css' ? 'scroll-behavior: smooth;' : ''} }
  body { margin: 0; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { height: ${ROW_HEIGHT}px; box-sizing: border-box; border-bottom: 1px solid #ddd; }
</style>
</head>
<body>
<h1>Smooth scroll</h1>
<ul aria-label="Rows">${Array.from({ length: ROWS }, (_unused, at) => `<li data-row="Row ${String(at)}"></li>`).join('')}</ul>
<script>
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.textContent = entry.target.dataset.row;
      observer.unobserve(entry.target);
    }
  });
  for (const row of document.querySelectorAll('li')) observer.observe(row);
  const mode = ${JSON.stringify(smooth)};
  if (mode !== 'none') {
    let target = 0;
    let frame = 0;
    const limit = () => document.documentElement.scrollHeight - innerHeight;
    addEventListener('wheel', (event) => {
      event.preventDefault();
      target = Math.min(limit(), Math.max(0, target + event.deltaY));
      if (mode === 'css') {
        scrollTo({ top: target });
        return;
      }
      const from = scrollY;
      const started = performance.now();
      cancelAnimationFrame(frame);
      const step = (now) => {
        const done = Math.min(1, (now - started) / ${String(duration)});
        scrollTo(0, from + (target - from) * (1 - (1 - done) ** 3));
        if (done < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    }, { passive: false });
  }
</script>
</body>
</html>`;
  },
};
