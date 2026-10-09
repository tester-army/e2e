---
name: authoring-docs
description: Use when writing, editing, rewriting, or shortening a guide page on the docs site (docs/**/*.mdx outside docs/reference/), including cleanup passes on legacy pages and requests to make a page shorter.
metadata:
  internal: true
---

# Authoring docs

Readers skim. They read the headings, the first sentence of each section,
the code blocks, and the tables, then leave. Write for that reader. Show the
fast path first and fold everything else.

Model pages: `docs/bug-bash.mdx` and `docs/quickstart.mdx`. When in doubt,
copy their shape.

## IMPORTANT: shorten every page

**Run this pass on every page you write, edit, or rewrite, before you
commit. Don't skip it for a new page or a small edit.** A first draft is
always too long, and an edit that adds one paragraph often repeats a fact
the page already has.

A page is too long when it says a fact twice, or when it is much longer
than its sidebar neighbors for no reason. Measure first. Count source lines
and prose words, and compare the page with its siblings:

````bash
wc -l docs/integrations/*.mdx
awk '/^```/{c=!c;next} !c' docs/integrations/smol.mdx | wc -w   # prose only
````

List every section with its rough line count. Then sort each cut into one
of three kinds, and work them in this order.

1. **Cut what the reader doesn't act on.**
   - How the code works inside, such as the order a provider boots
     machines. Keep the behavior a user sees, as one sentence where it
     matters.
   - An agent prompt for a task that is one install and a config change.
   - Next cards beyond the two the reader most likely needs.

   Keep a guarantee the reader would otherwise doubt, even when it reads
   like "works as it does locally". Check whether another page says it can
   fail. `browser.mdx` says a provider without `downloads` fails, so a
   provider page keeps the line that downloads work.
2. **Merge what's said twice.** Each fact has one place.
   - A lede paragraph that previews a section becomes a link to it.
   - A "Before you start" with one or two items becomes a `Note` in the
     first task.
   - A section that explains one option moves under the config that sets
     it.
   - A list and a table that describe the same fields become one table,
     with the details in its cells.
   - An options table row for an option with its own section links there.
     It doesn't describe the option again.
   - Text copied from another page, such as a list of limits, becomes a
     link to the page that owns it.
3. **Fold what only some readers need.** An optional path with its own
   install and example goes into an `Accordion`. The visible text keeps the
   rule every reader must follow.

Write the target outline before you edit: the headings, and what each one
holds. List moves that change other pages separately from the cuts on this
page, and say if you recommend them.

When the user asks how to shorten a page, show the plan before you edit.
Group the items by kind. Give each item its rough savings in lines and one
sentence of reason. End with the target outline and your recommendation.
If an earlier pass of yours added the length, say so.

Shortening adds claims. Check each new sentence:

- **A caveat moves with its claim.** Cut "external state stays shared" from
  the lede, and "every retry starts from the same state" becomes a promise
  the code doesn't keep.
- **A sentence that replaces three is a new claim.** Check it against
  `src/`. "`workers` sets how many machines run" was wrong: in `'attempt'`
  scope each worker slot runs a warm machine and a branch.
- **A leftover fact gets a heading or gets cut.** Don't park it under the
  nearest heading, such as cleanup under "Options". The heading list must
  still lead to it.
- **Estimates run high.** Measure after the edit. Report the real visible
  and folded line counts against the target.

## Scope

- Guides: every `docs/**/*.mdx` page except `docs/reference/`. That
  includes `docs/ci/`, `docs/integrations/`, and `docs/migrate/`.
- Not reference pages. They are lookup tables and keep their own shape.
- Not `skills/e2e/`. Agents read it start to finish, and the interactive
  components don't render there.
- `unslop` still applies to every sentence. This skill adds structure and
  tone on top. Where they disagree, this skill wins on docs pages: keep the
  STE sentence and paragraph limits, and write no first person.

## Page skeleton

```
---
title: <noun the reader searches for>
description: <one sentence: what the reader can do after this page>
icon: <font awesome name, or /images/icons/<brand>.svg (see Page icons)>
---

<lede: 2-4 sentences. What it is, what it does.>

<optional: Video or screenshot with a one-line caption>

<optional: Copy agent prompt, when an agent can do the whole task>

## Before you start          (prerequisites as bullets, if any)

## <task heading>            (one per task, in the order the reader does them)

## <task heading>

## Next

<CardGroup cols={2}> 2-4 next pages, one line each </CardGroup>
```

- **Lede.** Define the thing in the first sentence. No "In this guide you
  will", no "e2e is a powerful". If the reader stops here, they still know
  what the page is about.
- **Put the fast path first.** Before you write, ask what most readers of
  this page came to do: the default setup, the common command, the answer
  to the common question. Make that the first task section, unless an
  earlier task is a prerequisite. Fold the rare cases or move them down:
  edge cases, tuning, troubleshooting.
- **Headings name a task or a question**: "Install the skill", "Start a bug
  bash", "What the agent does". The heading list alone is a usable table
  of contents. "Next" before the closing cards is the one exception. Don't use "Overview", "Introduction",
  "Details", or "More information".
- **First sentence of each section carries the point.** The rest supports
  it.
- **One idea per section.** If a section needs a sub-heading to hold
  together, it's two sections. The exception is a group of tasks under one
  path, like "Set up manually" in the quickstart: use one level of `###`
  for its tasks, never deeper.
- **End with next steps**: a `CardGroup` of 2-4 cards. Each card has one
  line of description that says why to go there.
- **Link to depth instead of repeating it**: "To read the full procedure,
  run `npx e2e guide bug-bash`." or "See [Starting your app](/web#starting-your-app)."

## Page icons

The `icon` in the frontmatter shows in the sidebar beside the page title.
Use a Font Awesome name. Use a file only for a brand mark, such as a
vendor's logo on an integration page.

Mintlify fills Font Awesome icons with one grey. A file loads as an `<img>`
in its own colors. `docs/style.css` turns a file grey only when it is under
`docs/images/icons/`. It makes every opaque pixel a grey silhouette, so the
file must be a silhouette too:

- **Location**: `docs/images/icons/<brand>.svg`. A file anywhere else keeps
  its colors and stands out in the sidebar.
- **Color**: black marks on a transparent background. Don't use a filled
  tile, a white background, or brand colors. They turn into a solid grey
  square.
- **Format**: SVG. If the vendor has only a raster logo, use a transparent
  PNG.
- **Shape**: crop the file to the mark, with no padding. Padding makes the
  mark smaller than the icons beside it.
- **Weight**: the icon shows at 16 px. Hairline strokes look faint at that
  size. Thicken them until the mark is as heavy as the icons beside it.

Card logos in `docs/images/integrations/` are a different set. They keep
their brand colors, and some sit on a filled tile. Don't use one as a page
icon. Make a silhouette copy in `docs/images/icons/`.

Preview a new icon in the sidebar in light and dark mode, on its own page
and on another page. In all four views it must match its neighbors in
color, size, and weight.

## Copy agent prompt

Put a copyable prompt near the top when a coding agent can do the whole
task from the page: setup, migration, a bug bash, wiring CI. Skip it when
the page explains a concept, or the task is one command or one install and
a config change.

The import path is relative to the page. Use `./snippets/` for a top-level
page and `../snippets/` for a page in `docs/ci/`, `docs/integrations/`, or
`docs/migrate/`.

```mdx
import { SetupPrompt } from './snippets/setup-prompt-card.jsx';

export const setupPrompt = `<task>. Docs: \`https://e2e.tester.army/docs/<page>.md\`

1. <one step, imperative>
2. ...`;

<SetupPrompt>

<Prompt description={setupPrompt} children={setupPrompt} actions={["copy", "cursor"]} />

</SetupPrompt>
```

- Link the page's `.md` URL so the agent can read the rest.
- Numbered steps, one action each. Tell the agent when to stop and ask the
  user, for example to choose a model or to sign in.
- End on a check the agent can run: "run the test and fix errors until it
  passes".
- After the prompt, put the manual path under its own heading, such as
  "Set up manually".

## Showing less at one time

Fold content that most readers don't need. Choose the component by the
question the reader asks:

| The reader... | Use | Example |
| --- | --- | --- |
| picks one of several paths (platform, provider, OS) | `Tabs` | Web / Mobile, Subscription / API key |
| picks a package manager | `CodeGroup` with `npm`, `pnpm`, `bun` | every shell block that runs `npx` or `npm install`/`ci`, checked by `docs:check` |
| follows an ordered setup | `Steps` | Quickstart "Run your first test" |
| may want a full example or edge case | `Accordion` | "Example web config and test" |
| may want a long procedure that isn't the point of the page | `ShowMore` | Bug bash "What the agent does" |
| compares 3+ options with the same fields | table | plan -> login command |
| must not miss a requirement | `Note`, at most one per section | Node.js version |
| can lose data or leak a secret | `Warning` | unmasked video with a typed password |
| wants to see the result | `Video` with a one-line caption | `init` recording |

Rules:

- The text that stays visible must make sense without the folded part.
- Don't put the only copy of a required step inside an `Accordion` or
  `ShowMore`.
- Don't nest tabs in tabs. An `Accordion` inside a `Tab` is fine.
- Give a `ShowMore` a unique `id`.
- About one screen of visible content between two headings. If more,
  fold it, cut it, or split the section.

## Tone: 80% ASD-STE100

Follow Simplified Technical English for sentences and words. Relax it where
it would make the docs sound robotic.

Keep:

- **Short sentences.** Procedure: 20 words or fewer. Description: 25 words
  or fewer.
- **One instruction per sentence.** "Start the app. Then run the test."
  Not "Start the app and then run the test, making sure that...".
- **Imperative for procedures**: "Install the skill." Not "You will want to
  install the skill."
- **Active voice, present tense**: "e2e downloads a browser." Not "A browser
  will be downloaded."
- **Condition or warning first, then the instruction**: "When `CI` is set,
  e2e ignores `reuseExisting`. Use port `0`."
- **Short paragraphs**: 1-3 sentences.
- **One term for one concept** across the site. A step is a step, a run is
  a run. Don't rotate synonyms for variety.
- **Simple words**:

  | Write | Not |
  | --- | --- |
  | use | utilize, leverage |
  | make sure | ensure |
  | start, stop | initiate, terminate |
  | show | display |
  | examine, check | inspect, verify (for the reader's action) |
  | about | approximately |
  | one time | once (as a count) |
  | to | in order to |
  | if, when | in the event that |
  | (cut) | simply, just, easily, seamlessly, powerful, load-bearing |

Relax:

- Contractions are fine: "don't", "it's", "you'll".
- Product and API names stay as they are: `agent.act`, replay cache,
  fixture, target, engine.
- "You" is fine for descriptions. Procedures still use the imperative.
- Page titles can use the term people search for, `-ing` forms included:
  "Signing in", "Debugging".
- "Can" for capability is fine: "The agent can start one subagent for each
  area."
- When an STE phrasing reads worse than the plain one, use the plain one.

Before and after:

```
Before: In order to ensure that your app is able to handle multiple explorers
        simultaneously, you'll want to either reuse an existing server or
        configure a dynamic port.
After:  Make sure the app can serve many explorers at the same time. Start the
        app one time and set `reuseExisting: true`, or set port `0`.
```

```
Before: The wizard will then proceed to write out a config file as well as an
        example test, after which dependencies are added.
After:  The wizard writes a config and an example test, and adds dependencies.
```

## Rewriting a legacy page

A cleanup is a rewrite of the shape, not a copy edit. Keep every fact, cut
every repetition.

1. **List the facts.** Read the page and note every claim, option, default,
   and caveat. This is the content you must keep.
2. **Check the facts against `src/`.** Status prose drifts, as the Gotchas
   in `AGENTS.md` say. Fix or delete claims that no longer hold, including "not
   implemented yet" callouts.
3. **Find the reader's tasks.** Each task becomes a heading, in the order
   the reader does them. Facts that serve no task go to a reference page or
   a card link, or are cut. When the tasks don't depend on each other, put
   the fast path first.
4. **Write the lede and headings first.** Read them alone. If they don't
   explain the page, fix them before writing the body.
5. **Fold.** Apply the component table. Long examples go into an
   `Accordion`, alternatives into `Tabs`, background procedures into
   `ShowMore`.
6. **Apply the tone rules** sentence by sentence, then run `unslop`.
7. **Add a copy agent prompt** if an agent can now do the whole task.
8. **Keep URLs and anchors stable.** When you rename a heading, update
   every link to its anchor. Search for `/<page>#<anchor>` across `docs/`,
   `skills/`, `README.md`, and `packages/*/src`. Also search the page itself
   for `](#<anchor>)` and `href="#<anchor>"`. If a page moves, add a
   redirect in `docs/docs.json`.
9. **Compare.** The new page is shorter on screen, and every fact from
   step 1 is still on it, folded, or linked.
10. **Shorten.** A page in the right shape can still say things twice. Run
    the pass in
    [IMPORTANT: shorten every page](#important-shorten-every-page).

One page per PR. The reviewer compares old and new side by side.

## Before you commit

- [ ] **IMPORTANT:** the shortening pass ran on this page. It was measured
      against its neighbors before and after, and every new or merged
      sentence was checked against `src/`.
- [ ] Reading only the headings and first sentences explains the page.
- [ ] The lede defines the thing in its first sentence.
- [ ] The first task section is the fast path most readers came for,
      unless an earlier task is a prerequisite. Rare cases are folded or
      come later.
- [ ] No section shows much more than one screen without folding.
- [ ] Every shell block that runs `npx` or `npm install`/`ci` is a
      `CodeGroup` of npm, pnpm, bun.
- [ ] Code blocks are real or clearly fragments. A full example lives in
      `docs/examples/`, has an entry in `EXAMPLES` in
      `scripts/check-docs-examples.ts`, and typechecks with
      `pnpm --filter @e2e-dev/docs typecheck`.
- [ ] Status claims checked against `src/`.
- [ ] Each fact is in one place on the page. A fact another page owns is a
      link.
- [ ] A page icon from a file is a black silhouette under
      `docs/images/icons/` and matches its sidebar neighbors in light and
      dark mode.
- [ ] Links and anchors resolve. Moved pages have redirects.
- [ ] `pnpm docs:check` passes.
- [ ] Preview the page with `pnpm docs:dev` and look at it
      the way a skimmer would: scroll fast, stop only at headings and code.
