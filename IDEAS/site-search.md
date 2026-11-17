---
id: site-search
status: partial
dated: 2026-11-15
---

# Idea — search and a table of contents for a site-kit site

A visitor to a site-kit site can neither search it nor see a long page's
outline. The legacy ksite sites had a table of contents (maid.tech's
`site/src/blocks/TableOfContents.svelte`, turned on per page by `toc: true`,
live on `/understanding-kpis/`); site-kit has none, and its one Cmd/Ctrl+K
palette is the owner's editor's (`packages/site-kit/src/editor/Palette.mesa`),
which a visitor never loads and which matches page names, not page text.

## Shape

- **The build writes the index.** A site-kit Sierra config plugin reads each
  built page and writes `dist/search.json`: per page its address, title, the
  `<main>` headings with their ids (Mesa slugs them already) and its `<main>`
  words. Static, so no server answers a query.
- **The palette is `@frontierjs/ui`'s `CommandPalette`** for visitor and owner
  alike; site-kit's own `Palette.mesa` is deleted. Pages rank by
  `@frontierjs/toolbelt/search`'s `rank()` on title and address. Body words go
  through the palette's `search` hook as whole-word matches with an excerpt,
  because a fuzzy run of letters through a page's whole text matches almost
  anything.
- **Two islands a preset places.** `Search.mesa` is a header button that also
  answers Cmd/Ctrl+K and `/`; `Toc.mesa` is the floating outline, placed when
  the page's front-matter says `toc: true`. Both `client:idle`, so a page
  without them ships no script for them.
- **The editor joins the same palette.** Signed in, it adds its groups (edit a
  file, the bar's actions) to the visitor's pages and results.

## Plan

### Phase 1 — The index

Goal: every built site carries `dist/search.json`.
Done when: `test/content-build.mjs`'s real build writes it, holding each
route's address, title, headings with ids and words, and no 404 or `noindex`
page.

- [x] 1.1 `config/search.js` — `siteSearch()`, a Sierra config plugin whose
  `closeBundle` parses each `dist/**/index.html` with `happy-dom`, reads
  `<title>`, the h2–h4 under `<main>` that have ids and are not inside
  `.ignore-toc`, and `<main>`'s text (header, nav and footer stay out). A page
  carrying `<meta name="robots" content="noindex">` and `404.html` are skipped.
  Placed before `siteImages()`, which must stay last.
- [x] 1.2 Assertions in `test/content-build.mjs` over the file it writes.

### Phase 2 — The palette

Goal: a visitor finds a page or a passage from the keyboard or a button.
Done when: on a built test site in Chrome, Cmd+K, `/` and the button each open
it, typing a word from one page's body lists that page with an excerpt, and
Enter goes there (to the heading's `#id` when the hit is under one).

- [x] 2.1 `src/site/search.js` — loads `search.json` once, on first open, and
  answers `{ pages, results(query) }`: pages for `rank()`, results as page or
  section hits with an excerpt around the first matched word. Shared with the
  editor in Phase 4.
- [x] 2.2 `src/site/Search.mesa`, exported as
  `@frontierjs/site-kit/site/Search.mesa` — the button and the shortcut,
  mounting `CommandPalette` with a Pages group and a Results group. site-kit
  takes `@frontierjs/ui` as a dependency.
- [x] 2.3 Assertions in `test/blocks.mjs` (renders, parses); the Chrome drive
  through `@frontierjs/mesa/drive`, as `src/shots.js` does.

### Phase 3 — The table of contents

Goal: a long page shows its outline once the visitor scrolls.
Done when: on the same built site, a `toc: true` page shows no outline at the
top, shows the collapsed button after a scroll, opens to numbered h2/h3/h4
entries (1., 1.1), and a click scrolls the heading to just below the top and
closes it; a page without `toc` has no island.

- [x] 3.1 `src/site/Toc.mesa`, exported as `@frontierjs/site-kit/site/Toc.mesa`
  — maid.tech's behavior: headings read from `<main>` on mount, `.ignore-toc`
  skipped, hidden until `scrollY > 0`, a button that toggles the list, a click
  scrolls to 5% below the top and closes it. Styled in `@frontierjs/css` words
  (Invariant 13), no colors.
- [x] 3.2 Assertions in `test/blocks.mjs`; the drive from 2.3 covers the scroll.

### Phase 4 — Wire ksite, then the editor

Goal: kobami.com's preview has both, and an owner's Cmd+K is one palette.
Done when: kobami.com's `try-edit` preview opens search from its header and a
`toc: true` page shows the outline; signed in, Cmd+K lists pages, results and
the editor's groups in one palette.

- [x] 4.1 ksite `Page.mesa` places `{#if meta.toc}<Toc client:idle />{/if}`;
  `Header.mesa` places `<Search client:idle />`.
- [x] 4.2 The editor drops `Palette.mesa` and `palette.js`'s `matching()`,
  mounts `CommandPalette` in its shadow root with `search.js`'s pages and
  results plus its own groups, and while signed in the island yields Cmd+K to
  it. Built 2026-11-15: the editor's own Go to group stands for `pages`, which
  would list each draft page twice; `<html data-fjs-editing>` is the hand-off,
  and the island's button and `/` dispatch `fjs-editor:palette`. Driven over a
  ksite `--preview` build with a stubbed basecamp, 15 checks.
- [x] 4.3 Repack and deploy to kobami.com's `try-edit` (the recipe in its
  memory: a new tarball name every time, `FJS-4267`). Done 2026-11-17:
  every framework tarball packed whole from the tree, `@frontierjs/ui` vendored
  for the first time; try-edit `be1469c` READY, a visitor drive 14/14 against
  the live preview. It found `FJS-4426` (palette rows ran past the panel on a
  ksite page) and `FJS-4427` (the outline's button stretched, the site-wide call
  to action listed), both fixed; Privacy Policy is the `toc: true` page, its
  typed heading numbers dropped. Open: `FJS-4428` (a click before the island
  loads is lost), `FJS-4429` (front-matter `noindex` writes no meta). The
  signed-in palette on the live preview is the owner's to try.

## Open questions

- ~~**Q1 — Where visitor search gets its data.**~~ **Answered 2026-11-15 (`FJS-D2188`): A — site-kit writes its own JSON index at build and ranks it with `@frontierjs/toolbelt/search`.**
  - **A** — site-kit writes its own JSON index at build and ranks it with
    `@frontierjs/toolbelt/search`.
  - **B** — Pagefind, a chunked WASM index (Starlight's).
  - **C** — MiniSearch over the same JSON (VitePress's local search).
  - **Recommend A** — client sites are tens of pages, the toolbelt already owns
    fuzzy ranking, and neither B nor C is a dependency a site that size needs.
- ~~**Q2 — How a visitor opens it.**~~ **Answered 2026-11-15 (`FJS-D2189`): A — Cmd/Ctrl+K and `/`, and a header button the preset places.**
  - **A** — Cmd/Ctrl+K and `/`, and a header button the preset places.
  - **B** — the keys only.
  - **C** — a site.md setting turns it on.
  - **Recommend A** — a phone has no Cmd+K.
- ~~**Q3 — What it lists beside results.**~~ **Answered 2026-11-15 (`FJS-D2190`): A — pages.**
  - **A** — pages.
  - **B** — pages and this page's sections.
  - **C** — pages, sections and contact actions (call, book).
  - **Recommend C** — each is one group over data the page already has.
- ~~**Q4 — The owner's palette and the visitor's.**~~ **Answered 2026-11-15 (`FJS-D2191`): A — one palette; the editor adds its groups to it.**
  - **A** — one palette; the editor adds its groups to it.
  - **B** — two; the editor's takes Cmd+K while signed in.
  - **Recommend A** — two palettes is the fork site-kit exists to prevent.
- ~~**Q5 — The component the one palette is built on.**~~ **Answered 2026-11-15 (`FJS-D2192`): A — `@frontierjs/ui`'s `CommandPalette`, already Basecamp's, Workbench's and the example's, over `toolbelt/search`.**
  - **A** — `@frontierjs/ui`'s `CommandPalette`, already Basecamp's, Workbench's
    and the example's, over `toolbelt/search`.
  - **B** — site-kit's `Palette.mesa`, moved out of the editor and switched to
    `rank()`.
  - **Recommend A** — B leaves the repo with two palette components.
- ~~**Q6 — How the signed-in editor joins the palette, when ui's `CommandPalette` portals to `document.body`, outside the editor's shadow root.**~~ **Answered 2026-11-15 (`FJS-D2197`): A — `CommandPalette` takes a `host` (where it portals, `overlayHost()` by default); the editor mounts it in its own shadow root over `search.js`'s pages and results plus its groups, and while signed in the visitor island hands Cmd+K and its button to it.**
  - **A** — `CommandPalette` takes a `host` (where it portals, `overlayHost()`
    by default); the editor mounts it in its own shadow root over `search.js`'s
    pages and results plus its groups, and while signed in the visitor island
    hands Cmd+K and its button to it.
  - **B** — the editor sends its groups to the visitor island by a document
    event, and the palette renders in the page under the site's stylesheet.
  - **Recommend A** — B lets a site's stylesheet reach the editor again
    (`FJS-4269`), makes the palette's rows picks, and leaves a site without
    the Search island no palette for its owner.
- ~~**Q7 — Whether a Result matches a word the visitor is still typing.**~~ **Answered 2026-11-15 (`FJS-D2198`): A — the last word, when no space follows it, matches a word's start; every other word stays whole.**
  - **A** — the last word, when no space follows it, matches a word's start;
    every other word stays whole.
  - **B** — whole words only.
  - **Recommend A** — under B "insur" finds nothing until "insurance" is
    finished, and the start of one word adds none of a fuzzy run's noise.
- ~~**Q8 — How the outline numbers an h4.**~~ **Answered 2026-11-15 (`FJS-D2199`): B — as an h3, 1.1, the way maid.tech's outline does.**
  - **A** — its own level, 1.2.1.
  - **B** — as an h3, 1.1, the way maid.tech's outline does.
  - **Recommend A** — two levels written the same read as siblings.
