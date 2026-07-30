---
'@e2edev/playwright': minor
'e2e': minor
---

Locate nodes that no query can name, and observe shadow roots and `data:` frames.

An agent step whose target has no accessible name, test id, placeholder, or text
used to fail with `LOCATOR_NOT_FOUND` before it looked at the page. The model had
already selected the right node; the runner discarded it because no portable
query could be derived from it — so the agent tier failed hardest on exactly the
controls that have no deterministic address either, such as an input whose label
is the table cell beside it.

The locate sweep now falls through to the two paths that need no query:

- the node's **observed reference**, which the driver backs with the element
  itself, and
- the driver's **platform selector** for the node when it has an anchored one, in
  which case the located node carries a real locator instead of a reference and
  so survives into the cache and into `dragTo`. Recorded as the
  `locate.selector` policy decision.

Both paths re-read the live node and require its recorded identity before acting,
exactly as replay does, so a stale selection is still a miss rather than a blind
dispatch. `poll: false` callers keep their early exit for escalation.

Two observation gaps close alongside it in `@e2edev/playwright`:

- **Open shadow roots are walked.** A control that exists only in a shadow tree
  is now selectable. Slotted content is not double-counted: slotted elements are
  light-DOM children, and the shadow tree holds `<slot>` placeholders rather than
  copies. A closed root stays invisible, as it is to a person reading the page.
- **`data:` documents are admitted to observations.** They are the same trust
  class as `about:blank` and `about:srcdoc` — written by the embedding page, with
  no network origin for an allowlist to match — so refusing them excluded the
  app's own inline frames rather than any third party. The check still keeps out
  ads, trackers, and cross-origin embeds, all of which have a real origin.

Empty painted rectangles are observed, and a drag can end on one.

A drop zone, a colour swatch, a chart placeholder: an element defined by being
empty carries no role, name, text, or test id, so the observation walk skipped it
and no instruction could name it. An empty element that paints something — a
border, an outline, a background of its own — and is at least 12 CSS pixels on
each side is now reported with the role `box`. Nothing else changes: an unpainted
spacer of the same size is still omitted, because a person cannot see it either.

`dragTo` also no longer requires a locator on both sides. `Locator.dragTo` takes
two locators, so a destination the agent reached through its observed reference
made the whole verb unavailable — exactly for the elements that have no locator.
When either endpoint is reference-backed the driver drives the pointer instead,
which is also what makes HTML5 drag-and-drop commit, since it needs a real
`dragover`. A drag whose *source* is reference-only still fails: `dragTo` locates
twice and every observation disposes the generation before it, so the source
handle does not survive to the dispatch. That is an observation lifecycle
question, not a drag one.
