---
id: app-shell
status: proposed
dated: 2026-10-13
---

# Idea — the app shell: a `nav.js` contract and a kit `Shell`

**Status: PROPOSED. Nothing here is built.** Do not cite this file as describing
behavior — see `VERIFYING.md`.

Ruled as the next step by `FJS-D952`, raised by
[`docs/mesa-usage-audit-2026-10-12.md`](../docs/mesa-usage-audit-2026-10-12.md) § 3.11.
Every app rewrites `routes/_module.mesa`, and the table its nav is drawn from is
spelled a different way in each. This paper surveys those shapes, proposes one
contract for the table, and proposes a `Shell` in `@frontierjs/ui` that draws
`components/frame.css` from it. The older names for the two halves are *global
navigation* (the groups) and *local navigation* (a section's tabs).

## The survey

Seven shells were read: the five prototypes `FJS-D952` names, plus `example` and
`basecamp`. The scaffold's (`packages/cli/commands/project/new.md`,
`makeRouteModule`) is portal's topbar with two links.

| App | Table | Groups | Section tabs | Who sees a group | Pages with no frame | Below md | ⌘K |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sstime | `lib/shell/nav.js`: `main`, `admin`, `tabsFor` | two arrays, one shown at a time | `tabsFor`, longest prefix | `accounts.can('update', level)` | `/kiosk/` `/join/` `/n/` in the shell, and `frame: bare` frontmatter | a bottom menu, using `short` labels | none |
| ela | `src/nav.js`: `main`, `admin`, `tabsFor` | two arrays and a divider | `tabsFor`, longest prefix, `/` exact | `accounts.can('update', level)` | `/survey/` `/quote/` in the shell, and `reset: true` on one route | `Drawer`, nav snippet drawn twice | none |
| maidtech | `lib/shell/nav.js`: `create`, `groups`, `sectionFor` | `[{ label, entries }]`, three | `sectionFor`, **first match**, with `title` and `action` | none; the labels are not a boundary | `/portal/` in the shell, and `reset: true` | `Drawer`, nav snippet drawn twice; a hover rail above md | none |
| serpgrid | `NAV` in `_module.mesa` | `[{ group, items }]`, two | none | none | `reset: true` on `/p/` `/r/` `/w/` | frame.css hides it | **pages derived from `NAV`** |
| portal | `MORE` in `_module.mesa` | topbar links, plus a More menu grouped by array | none | a session link sees Search alone | none | topbar wraps | a `Palette` of its own |
| example | hand-written anchors | flat topbar | none | `level >= 5`, `isStaff` | none | topbar wraps | 14 `Navigate` rows written beside the anchors |
| basecamp | `PRIMARY` + `NAV` in `_module.mesa` | topbar handful, plus `[{ label, icon, open, links }]` as `<details>` | none | `isSystemAdmin` adds a group | none | `Drawer`, nav snippet drawn twice; a collapsible rail | 38 `Navigate` rows written beside `NAV` |

**What every signed-in shell redoes, apart from the table.** It draws nothing until
`session.checked`, because a cold load would otherwise flash the signed-out frame.
It draws a signed-out frame, usually `container narrow`. It closes the drawer on
`page.route`. It writes `aria-current` with a leading `page.route` read, awaits
`signOut()` before `goto('/login/')`, and in four of seven has a live/offline badge
and a theme switch. Each of these is a comment-carrying trap that each app
re-learned, and none of it differs between apps.

### Four findings that change the brief

`FJS-D952` names four parts of the contract: groups, section tabs, bare prefixes and
drawer copy. The survey keeps two of them, moves one, and corrects the ruling's
premise.

1. **`@frontierjs/ui` cannot import Sierra.** It peers on mesa and css only, and
   `Form.mesa` says why: a kit that imported Sierra would invert the dependency. A
   kit `Shell` therefore gets the route, the session and `isActive` as props from
   the `_module.mesa` that mounts it, which already reads all three. Q1.
2. **Bare prefixes are derivable, so they stay out of `nav.js`.** Sierra already has
   `reset: true` frontmatter, which opts a route out of every layout, and serpgrid,
   ela and maidtech use it. A prefix list in the shell is a second statement of the
   same fact, and maidtech makes both statements for `/portal/`. sstime's
   `frame: bare` is NOT a third spelling: it keeps the bar and the nav and drops
   only the page card, which `reset` cannot say. `reset: true` reaches the page
   that declares it and nothing beneath a directory (step 0.2).
3. **Only serpgrid feeds one table to the nav and ⌘K.** `FJS-D952` recommended a
   paper because "two apps already feed one table to both". It meant basecamp and
   example, and they do not. Each writes its palette's `Navigate` rows by hand beside
   its nav, and basecamp's has already drifted: `/security/` is in `NAV` and missing
   from ⌘K, and nothing reports it. The shared shape is still real (serpgrid
   derives it in one line), and the drift is the stronger argument for it.
4. **Two apps disagree on which section a page is in.** ela and sstime pick the
   longest matching prefix. maidtech takes the first match in array order, so a
   section added above a shorter one silently takes its pages. The contract picks
   one rule, the longest prefix, and a spec pins it.

Drawer copy stays the Shell's job: three apps render one nav snippet twice, once in
the sidebar and once in a `Drawer`, and basecamp's comment says why it must stay one
definition.

## The contract

`src/lib/nav.js` exports one table. Each field is used by at least two apps in the
survey. A field only one app uses stays in that app's own shell.

```js
// web/src/lib/nav.js
import { accounts } from '../resources/Account.mesa'

export const groups = [
  { label: null, entries: [
    { href: '/',        label: 'Today',   icon: 'today', exact: true },
    { href: '/leads/',  label: 'Leads',   icon: 'users', sub: 'open and lost' },
    { href: '/contacts/?kind=customer', label: 'Clients', icon: 'users',
      match: (path, query) => path.startsWith('/contacts/') && query.kind === 'customer' },
  ] },
  { label: 'Admin', show: ({ level }) => accounts.can('update', level), entries: [
    { href: '/settings/', label: 'Settings', icon: 'cog-6-tooth' },
  ] },
]

export const sections = [
  { path: '/leads/', tabs: [
    { href: '/leads/',      label: 'Open', exact: true },
    { href: '/leads/lost/', label: 'Lost' },
  ], action: { href: '/contacts/create/', label: 'New lead' } },
]
```

| Field | On | Callers | Meaning |
| --- | --- | --- | --- |
| `href`, `label` | entry, tab | all seven | as written |
| `icon` | entry | six | a name the app's own icon component takes (`FJS-D951`), passed to the Shell as a snippet |
| `exact` | entry, tab | five | the current-page test does not match pages beneath `href` |
| `match(path, query)` | entry | maidtech, example | where a path alone cannot say current: a query-filtered list, or one link standing for three sections |
| `sub` | entry | basecamp, example | the palette's second line; the nav does not draw it |
| `show(session)` | group, entry | sstime, ela, example, basecamp | an affordance only (Invariant 6). A predicate that throws counts as `true` |
| `label` | group | five | `null` for an unlabeled first group |
| `path`, `tabs` | section | sstime, ela, maidtech | the longest `path` the page starts with wins; `/` matches only `/` |
| `action` | section | maidtech | one app; kept because it replaces a per-page header button on every page in the section |

**Left out, each until a second caller exists:** sstime's `short` (a bottom menu),
basecamp's `open` (collapsible groups) and `PRIMARY` (a topbar handful), portal's
More menu, and a per-entry count. A count is drawn by a `badge` snippet the app
passes (step 0.3), so it stays reactive in the app's component.

**Three pure functions ship beside the contract** in `@frontierjs/ui/nav`:
`sectionFor(sections, path)`, `visible(groups, session)` and
`paletteItems(groups, session, go)`. The last one returns `CommandPalette`'s own item shape,
`{ id, group, label, sub, action }`, so the palette's `Navigate` rows are derived
and basecamp's `/security/` cannot go missing again. None of them decides whether
an entry is current. That stays with Sierra's `isActive`, which the Shell gets as a
prop.

## The Shell

`@frontierjs/ui/components/layout/Shell.mesa` draws `.shell` from frame.css. The name
is frame.css's own class. It is not Sierra's `terminal/Shell.mesa`, which is a
separate surface.

```mesa
<Shell {groups} {sections} layout="sidebar"
       path={page.pathname} query={page.query} route={page.route}
       user={session.user} level={session.level} checked={session.checked}
       {isActive} onsignout={out} title={page.title}>
  {#snippet brand()}<img src="/logo.png" alt="ELA" />{/snippet}
  {#snippet icon(name)}<Icon {name} />{/snippet}
  {#snippet foot()}…the account, the bell…{/snippet}
  <slot />
</Shell>
```

**It owns** the `checked` wait, the signed-out frame, the nav drawn once and rendered
in both the sidebar and a `Drawer`, closing the drawer when `route` changes,
`aria-current`, the section bar (title, tabs, action), and `.sidebar-toggle`.
**The app owns** the brand, the icon set, the foot, anything in the topbar, the
palette's other groups, and sign-out's destination. The app's `_module.mesa` shrinks
to a `$:` line, `out()`, and this element.

`layout` takes `sidebar`, `rail` or `topbar` (Q3). `rail` is the icon-only sidebar
that maidtech, serpgrid and basecamp each hand-roll; frame.css has no form for it,
which is `FJS-2559`, so step 2.1 closes that issue first.

## Against the nine

Answered before any code, as `decision-rules` requires.

1. **Origin** — removes one. Today the nav and the palette are two lists in basecamp
   and example. The hrefs still restate the route tree, and the `nav-href-routes`
   check (1.3) is what reports a link to nowhere.
2. **Concept** — adds `nav.js` and `Shell` and retires seven spellings. *Section*,
   *group* and *entry* are the prototypes' own words, and *shell* is frame.css's.
3. **Complexity** — the problem's. Global and local navigation are old names for
   these two halves, and every app in the survey has both.
4. **Predictability** — rises. One rule (longest prefix) picks a section, where
   today maidtech and ela disagree.
5. **Derived** — the palette rows are derived from the table, and pages with no
   frame come from `reset: true`. Groups, labels and order are the app's intent,
   and nothing in the route tree holds them.
6. **Owner** — `ui` owns kit components, and Sierra keeps owning the current-page
   test (`isActive`, passed in). No new dependency edge. Section lookup has no owner
   today, so `ui/nav` becomes it.
7. **Boundary** — the contract is a JSDoc typedef in `ui/nav.js`, and the spec
   (1.2) tests every field.
8. **Failure** — a nav link with no route is a 404 rather than lost data, so the
   check warns. A `show` that throws shows the entry, which matches Invariant 6:
   when the client cannot tell, it permits and the server refuses.
9. **Silence** — what must stay true: every nav link opens a route, every tab can
   be current, and every entry reaches ⌘K. What fails when it stops:
   `nav-href-routes` (1.3), the `ui/nav` spec (1.2), and derivation, which makes the
   third one impossible to break.

**Adjudications.** *Paved road vs. the workaround*: the Shell is the paved road, and
an app that outgrows it writes its own `_module.mesa` over the same `ui/nav`
functions. *Batteries vs. smallness*: the Shell is a battery in `ui`, and the core
is untouched. **Tier**: Assessment, until a ruling settles Q1–Q3.

## Plan

### Phase 0 — Groundwork

Goal: every open fact the contract leans on is probed rather than assumed.
Done when: each step below names what it found.

- [x] 0.1 Survey the seven shells: the table above
- [x] 0.2 Probe `reset: true` in a directory's `_module.mesa` frontmatter. Does it
  reach the pages beneath it? **No, and it does nothing else either.** A fixture
  through `buildTree` + `getLayoutChainForNode`: `/portal/` and `/portal/inner/`
  under a `reset: true` `_module.mesa` both resolve `[root, portal]`, while a page
  declaring it resolves `[]`. `build-tree.js:97` strips `reset` from layout
  frontmatter and `:156` reads it off the page alone, so the key is dropped with
  nothing said. Every `reset: true` in the surveyed apps is on a single page
  (serpgrid `/p/` `/r/` `/w/`, maidtech `/portal/`, ela `/surveys/print/`), and so
  is every entry in sstime's bare list — no app has a bare directory of pages yet
- [x] 0.3 Probe whether a snippet the parent passes re-renders when the parent's
  state changes (the `badge` and `foot` snippets). **Yes — it tracks exactly the
  reads the parent's own template would.** A child rendering `badge(e)` per entry
  and `foot()`, twice (sidebar and a drawer on the child's own `{#if}`), follows a
  reassigned `let`, an in-place mutation under a `$:` watch, and an imported object
  written through `watchProxy`, including a drawer copy mounted after the change
  and one closed and reopened. An UNWATCHED in-place mutation reaches neither the
  parent nor the snippet (RULE 43), so the app's `_module.mesa` watches what its
  snippets read, as it already does for `session`. Pinned in mesa's
  `test/snippet-parent-state.test.js`

### Phase 1 — The contract

Goal: `@frontierjs/ui/nav` ships the typedef and the three functions.
Done when: `bun run test` in `packages/ui` passes the new spec, and `fli check`
grades `nav-href-routes` over every app it reads.

- [x] 1.1 `packages/ui/nav.js`: the typedef, `sectionFor`, `visible`, `paletteItems`;
  an `exports` entry (`./nav`), as `./drag` has; `fli ws:exports`. **Built.** A
  section matches at a segment boundary and compares paths without their trailing
  slash, so `/leads-archive/` is not in `/leads/` and `trailingSlash: 'never'`'s
  `/leads` is. `visible` drops a group left with no entries, so an empty label is
  never drawn. `paletteItems` takes the session and runs `visible` itself, so ⌘K
  cannot offer an entry the nav hides — a caller composing the two could forget,
  and nothing would say so (`decision-rules` Q7, answered after the first draft);
  every entry lands in one `Navigate` group, the name both palette apps use
- [x] 1.2 The spec: longest prefix wins, `/` matches only `/`, `exact`, `match`, a
  throwing `show` counts as true, the palette's item shape. **`packages/ui/test/nav.mjs`,
  16 checks, in `bun run test`.** It also pins that the palette's rows are exactly
  `visible`'s entries for every session tried. `exact` and `match` are pinned only as
  fields `visible` and `sectionFor` pass through unchanged, because nav.js never
  decides which entry is current; what they mean is tested with the Shell (2.2).
  **It found one defect:** `CommandPalette` keys its keyboard index and row ids on
  `id`, so an href listed in two groups made two rows with one id. `paletteItems`
  now keeps the first visible listing of each href: one destination, one row. Listing
  an href twice is a legitimate table, so it is neither refused nor warned
  (`decision-rules`, answered after the code)
- [x] 1.3 `fli check` rule `nav-href-routes` (warn): every `href` and `path` in
  `src/lib/nav.js` resolves in the route table. **Built, in `core/checks.js`.**
  The route table it reads is the surface's committed `routes.snapshot.md` rather than a
  walk of `src/routes`, because the snapshot includes the routes a `*.mount.js` brings in
  (example's `/automations/`), and the `snapshots` phase fails it when stale. A `:param`
  takes one segment. A nested spread answers everything beneath it. A ROOT spread is
  the catch-all 404, which would vouch for every link, so it vouches for none. A
  section `path` needs a route at or beneath it, and `/` only itself. A query, a
  hash and a trailing slash are ignored, and the match is case-sensitive
  (`FJS-D210`). A relative href is reported, and external ones and templates are
  skipped. **The file moved to `src/lib/`:** `FJS-D625` puts every module that is
  not a route, resource or component in `web/src/lib/`, and `app-layout` warned on
  a loose `src/nav.js`. A ruling outranks this paper, so the paper moved
  (`decision-rules`, answered after the first draft of the rule). It skips in
  every app today, because none has a nav table yet; 3.1 is the first app it grades

### Phase 2 — The Shell

Goal: the kit draws a working shell from the contract.
Done when: the ui drive opens it in Chrome at 1280 and 375 wide, signed in and out.

- [x] 2.1 frame.css `.sidebar.rail`, which closes `FJS-2559`. **Built.** Closed it is
  a new `--rail-width`; under the pointer or while focus is visible in it, it opens to
  `--sidebar-width` over the Screen, and a negative end margin keeps the Shell column
  at the rail width, so the page does not reflow. The open width IS the sidebar
  width, so maidtech's `--sidebar-open-width` has no kit twin. It sits on a new
  `--z-sidebar` rung only while open. The labels go in a new optional Nav part,
  `.navlink-text`, faded by opacity so each stays its link's name. The rail's
  navlink rules are in nav.css, because `patterns` is the later layer. Collapsing
  for good is toggling the class, which is how basecamp and serpgrid already do it
  (`decision-rules`, answered before the first edit). Touch screens at md and up
  never open it, because there is no hover and a tap is not `:focus-visible`;
  2.3 decides whether the Shell gives a rail a `title` per entry for them
- [ ] 2.2 `Shell.mesa`, `layout="sidebar"`: the checked wait, the signed-out frame,
  the sidebar and `Drawer`, the section bar
- [ ] 2.3 `layout="rail"` and `layout="topbar"` (Q3)
- [ ] 2.4 A ui-hazards row and the ui `AGENTS.md` row

### Phase 3 — Callers

Goal: the in-repo apps run on the Shell; the prototypes follow.
Done when: example's and basecamp's drives pass, and basecamp's ⌘K offers `/security/`.

- [ ] 3.1 example: `src/lib/nav.js`, the Shell, `paletteItems` for `Navigate`
- [ ] 3.2 basecamp: same, with `PRIMARY` kept in its own topbar snippet
- [ ] 3.3 ela, maidtech, sstime, serpgrid. Ask the owner first: `fjs-prototypes` is
  not a git repository, so an edit there cannot be undone

### Phase 4 — The generator

Goal: `FJS-D952`'s option B, done after A as the ruling said: a new app starts on
the contract.
Done when: `fli new` writes `src/lib/nav.js` and a `_module.mesa` on the Shell, and the
app it writes builds.

- [ ] 4.1 `makeRouteModule` in `new.md`
- [ ] 4.2 `make:scaffold` appends its model's entry to `src/lib/nav.js`

## Open questions

- **Q1 — Where does the Shell live?**
  - **A** — `@frontierjs/ui`, props-driven. The route, the session, `isActive` and
    sign-out are passed in.
  - **B** — `@frontierjs/sierra/shell`, reading the router and session directly.
    Sierra would then import ui's `Drawer`, which is a new edge.
  - **Recommend A** — ui peers on mesa and css only, and `Form.mesa` already keeps
    that line for the same reason. Every prop is a read the `_module.mesa`
    already makes in its `$:` line.
- ~~**Q2 — How does a page opt out of the frame?**~~ **Answered 2026-10-13 (`FJS-D954`): B — `reset: true` on the page, and Sierra makes it reach every page under a `_module.mesa` that declares it — a few lines in `parseRouteFile`. It is what a reader predicts, since every other layout frontmatter key reaches the pages beneath; it is also unsettled whether the declaring layout itself still renders, and no caller exists to settle it.** 0.2 answered: per page only, and
  a `_module.mesa` that says it is silently ignored.
  - **A** — `reset: true` on the page, and Sierra REFUSES it on a `_module.mesa`
    by name rather than dropping it. A bare directory is one line per page.
  - **B** — `reset: true` on the page, and Sierra makes it reach every page under
    a `_module.mesa` that declares it — a few lines in `parseRouteFile`. It is
    what a reader predicts, since every other layout frontmatter key reaches the
    pages beneath; it is also unsettled whether the declaring layout itself still
    renders, and no caller exists to settle it.
  - **C** — a `bare` list of prefixes in `nav.js`, as four shells do today.
  - **Recommend A** — every bare route in every surveyed app is a single page, so B
    has no caller, and C is a second statement maidtech already makes twice. The
    refusal is owed either way: a key that does nothing and says nothing is the
    defect. B is the move the day a second page lands under one bare directory.
- **Q3 — Which layouts ship in Phase 2?**
  - **A** — `sidebar` and `rail` only. The topbar apps keep their own
    `_module.mesa` over `ui/nav`.
  - **B** — `sidebar`, `rail` and `topbar`. The topbar draws `groups` flat, and
    portal's More menu stays out.
  - **Recommend B** — the scaffold, example and portal are topbar shells, and
    Phase 4 cannot put a new app on the Shell without one. Portal's overflow menu is
    the single-caller field the contract leaves out.
