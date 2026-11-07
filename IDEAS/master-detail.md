---
id: master-detail
status: proposed
dated: 2026-11-07
---

# Master-detail — one pane on a phone, picked by the URL

**Status: PROPOSED.** Dated 2026-11-07. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

`responsive-layout.md` § Phase 3, step 3.3, sent this here: four show/hide
sites in its census hide a whole pane, and `FJS-D2023` ruled that a pane
which carries state is not the secondary-content class. This paper decides
where that state lives.

---

## What exists

- **A route per detail is already paved.** A `_module.mesa` renders the list
  and its `<slot />` the child route: serpgrid's `/chat/` and
  `/chat/[roomId]/`, Basecamp's `/deployments/` and `/deployments/[id]/`.
  `example/web/src/routes/products/[id].mesa` is a page of its own with
  `Breadcrumbs` back to `/products/`. Deep links, refresh and the back
  button work because the URL is the selection.
- **The Aside stacks; it does not hide.** Below md it moves over the main
  content (`patterns/aside.css`), and `.aside-toggle` collapses it on the
  app's `aria-expanded`. Both panes stay on the page.
- **The Shell's Sidebar becomes a Drawer below md** (`frame.css`), opened by a
  `.sidebar-toggle` the app wires. That is navigation, not a selection.
- **`.switcher` puts two panes side by side and stacks them** below
  `--switch-at` (`FJS-D2020`). It cannot hide one, and a child cannot learn
  which state it is in: the wrap is not observable (`FJS-D2024`).

None of the four says which pane a phone shows, or how a person gets back to
the list. Each app writes that rule itself.

## The sample

The census (`node scripts/width-census.mjs --hides`) reads CSS only; ELA's
three collapses are `matchMedia` in script, found with `rg -n matchMedia`.

| App | Site | What hides | State that picks the pane | Back on a phone | Detail is |
| --- | --- | --- | --- | --- | --- |
| serpgrid | `chat/_module.mesa:29` (960px) | the room list with a room open; the room with none | `page.params.roomId`, or a pathname regex listing eight sibling routes | browser back only: the room header links nowhere | a route |
| serpgrid | `chat/[roomId]/index.mesa:129` (960px) | the room column while a thread is open | `?thread=` | ✕ or Esc, `goto` the room | a query |
| quo | `routes/index.mesa:85` (1100px) | the contact pane | `?c=` | none: the pane cannot be reached under 1100px | a query |
| serpgrid | `components/ClientRail.mesa:64` (1023px) | a quick-switch rail of clients | nothing | the shell's nav | a route, `/clients/[id]/` |
| ELA | `support/Desk.mesa:90` (JS, 48rem) | the thread list with one open | `?thread=` | `← All threads` to `/support/`, narrow only | a query |
| ELA | `messages/index.mesa:85` (JS, 48rem) | the reading pane | wide: a local `selected` id; narrow: the link falls through to `/messages/[id]` | browser back | a route on a phone, local state when wide |

**On a phone the URL picks the pane in all six.** Only ELA's messages keeps a
selection outside it, and only when wide, so a refresh there loses the open
message. Two rows are not master-detail: the ClientRail is a nav that drops
(responsive-layout's 3.1 group), and quo's contact pane is a third pane of
facts beside a thread. Quo's list and thread also never become one column:
under 1100px a phone gets two narrow columns. The sample is four list-detail
screens in two apps (serpgrid, ELA).

**Prior art** (from memory, not re-read this session). iOS
`UISplitViewController` collapses to a navigation stack: the detail is
pushed, and back pops it. Android's `ListDetailPaneScaffold` keeps the pane
in a navigator, so the system back gesture returns to the list. Every Layout
ships no master-detail; its Sidebar lays out the two, and which one shows is
left to the app. Tailwind UI's "stacked on mobile" examples stack both panes
rather than pick one. GOV.UK's "one thing per page" makes the detail its own
page. Each platform that picks a pane makes the pick navigation.

## The design

**The detail is a route; the two-pane screen is the wide enhancement.** On a
phone the list is one screen and the detail another, and the module that
renders both drops the list while a child route is active. Run through
`decision-rules`, this passes the nine where a `data-pane` component fails
two: it adds a second origin for which pane shows, beside the router's
match, and a noun with an attribute contract and its own back control. The
Aside's `aria-expanded` is no precedent for it; that is disclosure, and a
selection is navigation.

**What A leaves to build is one signal.** A module cannot ask whether its
slot holds a child route, so serpgrid re-derives it with a regex over eight
sibling paths, and a ninth sibling route breaks the phone layout with no
test failing. Sierra owns the match (Invariant 4), so Sierra answers the
question — Q1. `packages/sierra/src` has no child-active flag today;
`page.route` is the matched node, and the layout chain is internal.

**A query-picked detail stays a query.** `?thread=` beside its room is a
filter of the room, and `page.query.thread` is one expression with no route
list — Q2.

**The hide is the app's rule, keyed on that signal.** It names its container
(`FJS-D2024`) or uses `@media` on the scale (`FJS-D2022`); serpgrid's 960px
and quo's 1100px are off it. `.switcher` cannot be the hide, because it never
reports that it wrapped.

**Back is a link to the list route, shown only while one pane shows** — Q3.
Browser back works already; a phone in a full-height chat has no visible way
out without one.

**The package ships nothing.** No class, no attribute, no component: a recipe
in the guide (Q5) and the Sierra signal if Phase 0 finds it is needed.

---

### Phase 0 — Prove it on serpgrid's chat

Goal: the route-per-detail recipe holds on the one site with all of it.
Done when: a drive at 400px and 1280px on `/chat/` and `/chat/<id>/` shows
one pane then two; back from a room returns to the list; refresh on a room
keeps the room; a new sibling route under `/chat/` hides the list without
editing the module.

- [ ] 0.1 Drive the site as it stands at 400px and 1280px; record what back does and what the regex misses
- [ ] 0.2 A back link in the room header, shown only while one pane shows, on the app's named container
- [ ] 0.3 Replace the regex with the shortest read of `page.route` that answers "a child is active"; whether it is one expression answers Q1

### Phase 1 — The signal

Goal: a layout knows its slot holds a child route without re-deriving it.
Done when: a sierra test pins the signal for an index and a child route;
serpgrid's module reads it; the Phase 0 drive passes.

- [ ] 1.1 Sierra exposes the child-active signal, spelled as Q1 rules (skipped if 0.3 finds one expression)
- [ ] 1.2 ELA's messages becomes a route at every width; the wide layout renders the list beside it, so a refresh keeps the open message
- [ ] 1.3 ELA's Desk and its `matchMedia` give way to the recipe; drive at 400px

### Phase 2 — The recipe

Goal: a fourth app copies one page rather than a fifth hand-written rule.
Done when: the guide page exists and the census counts no list-detail
collapse outside it.

- [ ] 2.1 The recipe page — module, child route, the hide, the back link — where Q5 rules
- [ ] 2.2 Quo's contact pane as Q4 rules, and its list and thread become one pane on a phone
- [ ] 2.3 `width-census.mjs` counts `matchMedia(` width conditions, so a collapse in script shows in the census

## Open questions

- **Q1 — How does a layout learn a child route is active?**
  - **A** — an attribute on the outlet RouterView renders, read with `:has()`.
  - **B** — a field on `page`, which the module binds to a class.
  - **C** — nothing new: the module compares `page.route` itself.
  - **Recommend B, or C if 0.3 finds one expression** — A needs RouterView to
    render a wrapper element, which it may not today (unchecked), and a field
    is a read of a match the router already holds.
- **Q2 — Does a query-picked detail move to a child route?** `?thread=` and
  `?c=` pick a pane beside a routed screen.
  - **A** — no: the recipe shows both, the module reads `page.query`.
  - **B** — yes: every detail pane is a child route.
  - **Recommend A** — a query is URL too, so deep links and back already work;
    B makes a thread a page of its own for no gain a person sees.
- **Q3 — What is the back control on a phone?**
  - **A** — `Breadcrumbs` on the detail at every width, as
    `example/web/src/routes/products/[id].mesa` does.
  - **B** — a link to the list route, shown only while one pane shows.
  - **C** — browser back only.
  - **Recommend B** — a crumb beside a visible list repeats it, ELA's Desk
    already ships B, and C leaves a full-height chat with no way out on screen.
- **Q4 — Where does quo's contact pane go under 1100px?**
  - **A** — a Drawer opened from the thread header.
  - **B** — an Aside, stacked over the thread below md.
  - **C** — it stays dropped.
  - **Recommend A** — B pushes the thread off a phone's first screen, and C
    leaves facts a person needs out of reach.
- **Q5 — Where does the recipe live?**
  - **A** — the css guide's Switcher page, beside the companion rule of
    `FJS-D2024`.
  - **B** — sierra's routing docs, beside `_module.mesa`.
  - **Recommend B** — the state is the router's; the CSS half is one
    app-written rule the Switcher page already teaches.
