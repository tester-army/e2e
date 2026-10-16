/* Mintlify never scrolls the table of contents to the active entry; this keeps
   it inside the list's scroll padding (style.css). Mintlify loads it on every page. */

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

new MutationObserver(() => {
  const entry = document.querySelector('#table-of-contents li[data-active-deepest] > a');
  const viewport = entry?.closest('[data-component-part="scroll-area-viewport"]');
  if (!viewport) return;
  const { scrollPaddingTop, scrollPaddingBottom } = getComputedStyle(viewport);
  const view = viewport.getBoundingClientRect();
  const top = view.top + parseFloat(scrollPaddingTop);
  const bottom = view.bottom - parseFloat(scrollPaddingBottom);
  const { top: entryTop, bottom: entryBottom } = entry.getBoundingClientRect();
  const offset = entryTop < top ? entryTop - top : entryBottom > bottom ? entryBottom - bottom : 0;
  if (offset !== 0) viewport.scrollBy({ top: offset, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
}).observe(document.documentElement, { subtree: true, attributeFilter: ['data-active-deepest'] });
