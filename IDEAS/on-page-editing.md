---
id: on-page-editing
status: proposed
dated: 2026-10-04
---

# Idea — the ask panel's next four moves, ranked by what on-page editors love

**Status: PROPOSED. Steps 1, 2 and 3 are built; step 4 is not.**
Do not cite this file as describing behavior — see `VERIFYING.md`.

The ask panel is the dev-server half of on-page editing: alt-click opens the
source, shift+alt-click asks Claude to change the picked element, the page
hot-reloads, Undo puts it back. This file ranks what to build next against a
survey of the tools people praise for on-page editing, and states each move
narrowly enough to start.

## What ships

| Piece | Owner | What it gives the next move |
| --- | --- | --- |
| a pick: `{ el, loc, file, key, open }` | `packages/mesa/mesa-vite/inspect-client.js` `pick()` | `loc` is `file:line:col` of the ELEMENT, stamped by the compiler as `data-fjs-loc` on `.mesa` and `.md` output |
| several picks, one run, one Undo (step 1) | `vite-ask-client.js` `open()`/`render()`, `ask-claude.js` `editPrompt({ picks })` + `shareBudget` | a pick list the panel already holds; a direct text edit is one more control on a row |
| a hover outline while the modifier is held | same file, `paint()` | the "what can I touch" affordance is already there |
| picks → one prompt → one `claude -p` run | `packages/cli/core/vite-ask.js`, `ask-claude.js` `editPrompt()` | prompt carries each pick's `loc` + its share of 4000 chars of `outerHTML` |
| the run's ledger: whole-file copy at first Read, Write detected from its result, undo that never overwrites another writer | `vite-ask.js` | every new way of changing a file goes through THIS ledger, so Undo stays one path |
| a per-file diff in the panel | `vite-ask-client.js` `diff()` | — |
| the conversation's session id | `ask-claude.js` (`system/init` event), kept in `sessionStorage` | it is already the id `claude --resume` takes |

Drive: `website` `verify:ask` (`DRIVES.md`).

## What the survey says people love

Tools read: Sanity Presentation, Tina, DatoCMS, CloudCannon, Storyblok, Framer
On-Page Editing, Webflow Editor, Lovable and Bolt Visual Edits, Vercel Toolbar,
BugHerd/Marker.io, React Grab. Sources at the end.

| Lesson | Where it shows | Here |
| --- | --- | --- |
| Click the thing, land on its source | Sanity, Tina, Dato, CloudCannon | **ships** — alt-click |
| Show what is editable before the click | CloudCannon's yellow boxes, Sanity's outlines | **ships** — `paint()` |
| Small text edits need no AI round trip | Lovable ("chatting with AI for every small edit wasn't ideal"; text edits free), Framer, Webflow click-and-type | **ships** — step 2, for text written in the source |
| Stack several edits, commit once | Bolt: edits batch above the chatbox, tokens spent only on save | **ships** — step 1 |
| Hand precise context to an agent | React Grab: file + component + HTML to the clipboard | **ships** — step 3 |
| Feedback anchored to an element, screenshot captured for you | BugHerd, Marker.io, Vercel comments → PR | **gap** — `anchored-feedback.md` |
| Content unlocked, layout locked | Framer locks layout templates; Webflow Editor cannot touch design | not this panel's job: it is a developer tool and the tree is the review |
| Never publish someone else's half-done work | Webflow's top complaint: an Editor publish ships the Designer's unpublished changes | **ships** — the ledger's another-writer rule is this answer |

What people dislike: live `contenteditable` (pasted formatting, layout that
differs while editing, Tina retreated from it to sidebar forms), and slowness on
pages with many blocks (Storyblok's top con).

## The plan

Ranked by love per unit of work. Each step extends `verify:ask` with its own
case before it is called done.

### 1. Multi-pick, one run — BUILT 2026-10-04 (`docs/changes-archive/cli.md`)

Shift+alt-click on a second element ADDS it to the pick list; the panel lists
the picks with a remove control each; one instruction goes out with all of them.
`editPrompt()` takes `picks: [{ loc, html }]` in place of `loc`/`html`, and the
4000-char budget is shared across the list rather than given to each. One run is
still one ledger and one Undo.

Drive case: pick two headings in two files, one instruction, both change, one
Undo restores both.

### 2. Direct text edit, no Claude — BUILT 2026-10-04 (`docs/changes-archive/cli.md`)

**Measured on `website/site`, 29 routes, 6770 text-bearing elements:** 52%
direct, 11% split by inline markup, 36% interpolated. The interpolated share is
the "high" case below, so the content source map is the next idea worth its own
file. Measuring it first found `FJS-1710`: before it was fixed, 80% of locs were
on the wrong line and 0.5% went direct.

The Lovable lesson. A text-only change is a string replace with a known
location, and a model run for it is slow and costs money.

- **Trigger:** an "Edit text" button on a pick whose element has text content.
  It opens an input laid OVER the element (the element is untouched, so nothing
  about live editing's layout and paste problems applies).
- **Server:** a second route beside the ask route in `vite-ask.js`. It reads the
  source at `loc`, finds the element's old text **exactly once** from that line
  to the element's close, replaces it, and records the change in the run ledger
  as an Edit, so Undo, the diff and the another-writer rule are unchanged.
- **Fallback:** text found zero times or twice — interpolated (`{item.title}`),
  coming from `content/data/*.js`, split by inline markup — is handed to step 1's
  ask path with the instruction pre-filled (*change "X" to "Y"*). The person sees
  one control; which path ran is a line in the log.

`.md` sources are the best case: the text is literally in the file. Most of
`website/site/content/routes/` renders data-file text by interpolation, so
measure the fallback rate there before going further. If it is high, the next
step is Sanity's answer — a content source map that tags an interpolated value
with where it came from — and that is a compiler change worth its own idea file.

Drive case: edit a static heading (no Claude spawned — assert the fake CLI was
never called), edit an interpolated one (falls back), Undo each.

### 3. Hand the conversation to a terminal — BUILT 2026-10-04 (`docs/changes-archive/cli.md`)

The session id is already what `claude --resume` takes. The panel gains a
"Continue in terminal" control that copies `cd <root> && claude --resume <id>`.
A run with no session yet copies a React-Grab-style block instead — `loc`, the
HTML excerpt and the typed instruction — to paste into any agent.

The check this step named came out the other way: `claude --resume` finds a
session from any directory (2.1.288). The `cd` stays, because the session's
paths and its tools are relative to the root its runs were spawned in.

Drive case: the copied command, run through `sh` against the fake CLI, starts
it in the root with `--resume <id>`; with no session, the copied block carries
the unsent instruction and the absolute source.

### 4. Screenshots, attached for you

Last, because it is the only one with a design question open. The page cannot
photograph itself without a permission prompt (`getDisplayMedia`) or a DOM
re-renderer (an html2canvas-class dependency, which this repo has not taken).
The third option is the dev server driving its own Chrome over CDP, which
`verify:ask` already does in a test and nothing does in dev. Run
`decision-rules` on the choice before building. When it lands, a screenshot
is attached to a pick automatically, cropped to the element, for any
instruction — the BugHerd lesson is that the capture people value is the one
they did not have to take.

## The nine (`decision-rules`, answered before any edit)

1. **Origin** — none added. Text edits land in the source the pick names; the
   ledger stays the one record of what a run changed.
2. **Concept** — no new noun. *Pick*, *run*, *ledger* exist; a text edit is a
   run with no model.
3. **Complexity** — the problem's: Bolt, Lovable and Framer each grew the same
   two paths (direct + AI).
4. **Predictability** — risk in step 2: two paths behind one control. Answered by
   logging which ran, and by the fallback being the path that always works.
5. **Derived** — step 2's location is derived from `data-fjs-loc`, never stored.
6. **Owner** — exists: `vite-ask.js` owns runs and undo, `inspect-client.js`
   owns picks. Nothing is built beside them.
7. **Boundary** — the new route takes the same same-origin + JSON refusal as the
   ask route and the same `LOC` pattern; it writes only under the root.
8. **Failure** — a text edit that cannot find its text exactly once refuses and
   falls back rather than guessing; that is proportional, because a wrong
   replace is a silent edit somewhere else in the file.
9. **Silence** — *stays true:* a direct edit changes only the picked text.
   *What fails:* step 2's drive case asserts the file's diff is that one line.
   Step 3's resume command: `verify:ask` runs the copied command in a shell.

No § IV adjudication is in tension. Tier: Assessment (`IDEAS/`).

## Not in this file

**On-page editing for a site's OWNER** — Framer's and Webflow Editor's case, on
the deployed site, with layout locked and a publish step — is a different
product on a different surface. It would sit on site-kit's content model
(`site-kit-structure.md`), not on the dev server, and wants its own idea file.

## Sources

- Sanity — https://www.sanity.io/docs/loaders-and-overlays
- Smashing, *Visual Editing Comes To The Headless CMS* — https://smashingmagazine.com/2023/06/visual-editing-headless-cms/
- Tina, *The Evolution of Inline Editing* — https://tina.io/blog/evolution-of-inline-editing
- CloudCannon editable regions — https://cloudcannon.com/documentation/articles/what-are-editable-regions/
- Framer On-Page Editing — https://www.framer.com/updates/on-page-editing
- Webflow wishlist, Editor publishes Designer changes — https://wishlist.webflow.com/ideas/WEBFLOW-I-354
- Lovable Visual Edits — https://lovable.dev/blog/introducing-visual-edits
- Bolt Visual Edits — https://bolt.new/blog/visual-edits
- Vercel Toolbar — https://vercel.com/docs/vercel-toolbar
- BugHerd vs Marker.io — https://bugherd.com/article/bugherd-vs-marker-io-2025
- React Grab — https://jimmysong.io/ai/react-grab
- Storyblok on G2 — https://g2.com/products/storyblok/reviews
