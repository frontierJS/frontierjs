# Mesa usage audit — 21 apps, 2026-10-12

Read-only audit of `web/` structure and `.mesa` code across 19 prototypes in `fjs-prototypes/`, `example/` and `packages/basecamp`. Question asked: is app code coming out clean, or are apps drifting, hand-rolling what the framework should own, or repeating a shape with no framework noun? Four agents read ~250 files; the census numbers were measured by script over every `.mesa` under `web/src`.

Verdict: **the Resource layer is clean and the kit is winning; the ROUTE layer is where the hand-rolling lives, and most of it traces to the scaffold.** Nobody is fighting the compiler. What they fight is the gap between `list()` and everything a screen needs that is not a list.

## 0. One blocker before anything else

**9 of 19 prototypes cannot build.** `@frontierjs/sierra/junction` was renamed to `@frontierjs/sierra/resource` on 2026-10-08 (`a4e7d9d3`) and the sibling repo was not moved. Dead-import file counts: calendly 14 · chatwoot 18 · connectteam 21 · jazzhr 22 · linear 33 · notion 19 · quo 20 · remnant 14 · transit 40. The rename policy ("every caller moved in the same change") stops at the repo boundary. Fix: one `sed` across `fjs-prototypes/*/web/src`, plus a `fli check` rule or `fli ws:*` step that greps sibling repos for a retired subpath.

## 1. What is clean

- **Resources.** 320 resource files, every one `<script module>` + `createResource`, PascalCase = model name, zero `createResource` outside `resources/` except charter's `ModelData.mesa` (a resource over ANOTHER app via `connectApp`, a legitimate shape Invariant 19 has no clause for). `fli check` already grades `resource-script`, `resource-file-name`, `resource-one-per-file`, `resource-model-miss`.
- **Styling.** Zero color literals outside `theme.css` token blocks (ela, maidtech, sstime, remnant) and darkroom's draw-color DATA. `style=` is almost entirely `--custom-prop: {v}` knobs. Invariant 13 holds everywhere.
- **Kit adoption.** No local Modal, Table, Badge, Tabs, Drawer or Toast anywhere. `toastStore` imported 54× in the scaffold family alone. `$context.form` is touched by zero apps.
- **Reactivity.** Every `$: dep, handler` that loads is paired with a mount call. Every app-WRITTEN `{#each}` is keyed; unkeyed ones are scaffold column loops. No `$$`, no `__`, no `// hack`. `aria-*={false}` absent. `@system` never appears in an edit form.
- **darkroom** proves Mesa fits a non-CRUD editor when the app builds its own Document seam (`lib/edit/document.js` value + history) and keeps Mesa as view: 48/48 keyed, 0 querySelector.

## 2. The scaffold is the root cause of most drift

`login`, `register`, `reset`, `account`, `users/*` are byte-identical scaffold copies in all 10 scaffold-family apps and in ela/maidtech. Nobody rewrites them; they drift by GENERATION of the generator. So a flaw in `packages/cli/commands/project/new.md` or `core/crud-templates.js` is a flaw in 20 apps:

| Scaffold teaches | Count in the wild | Kit already owns |
| --- | --- | --- |
| `window.confirm` on delete (`crud-templates.js:160,480`) | 28 apps-worth of `confirm(` | `ConfirmProvider` / `data-confirm` (notion, ela use it) |
| Login page with no `<form>` — Enter does nothing (`new.md` login) | maidtech + all scaffold family | ela rewrote it with `<form on:submit>` |
| 12-line `record()` + `subscribe` + `ready` + `release` detail boilerplate (`crud-templates.js:420-437`) | ~70 hand-copied sites (ela 31, maidtech 18, basecamp 17) | nothing — `list()` has no `detail()` sibling |
| `style="max-width: 32rem"` inline on every detail form | 7+ apps | a `.narrow` or `--form-inline-size` token |
| bare `<input class="field">` + hand `loading/error` on auth pages | the model every hand form copies | `<Form onsubmit mapErrors>` (basecamp login shows it) |
| `datetime.js` header says "the one clock" | 5 apps ignore it with `toLocale*` / `Intl` | the file nobody reads |

Fix the generator and 20 apps improve on their next `fli make:scaffold`.

## 3. Missing patterns — shapes repeated across apps with no framework noun

Ranked by copies found. Each is a candidate for `decision-rules` (coining a noun).

1. **Detail-record store** — ~70 copies, scaffold-born. **Done, as `record(id)` grown rather than a `detail(id)` noun** (`decision-rules` Q2/Q6: `record()` already owns one row, live): `row.value`, `row.loaded` and `row.error()` are tracked, and the view is released with the component that made it (`packages/sierra/src/resource/record.js`). `editPage` uses it. The ~70 copies still work and are not migrated.
2. **Enum member → tone.** 29 files carry `const TONE = {…}`; 32 maps in basecamp+example, five verbatim copies of the same health map. `example/lib/status-tone.js` and `Deployment.mesa`'s `DEPLOY_TONE` are two attempts at a home; neither is used by the pages beside them. **Refused** (`FJS-D817`): a `.lite` file names no UI word, so the map stays UI-realm — once, in the resource's `<script module>` (§ 5 rule 12), never in a route. `FJS-1980` reopens it.
3. **Envelope unwrap by hand.** 141 sites of `?.data ?? x` across 21 apps (serpgrid 25 copies of `rowsOf`): ~110 on `find`, 28 on `invoke`. **Done** (`FJS-D937`): `find` answers the envelope (`FJS-D76`, unchanged), and `invoke` answers what the method returned — a custom method's array is now the array on HTTP, the socket and in process. `fli check`'s `envelope-hedge` flags `x?.data ?? x` and `Array.isArray(x) ? x : x?.data`; example, basecamp and orion are clean. The prototypes are not migrated — serpgrid alone flags 46.
4. **Screen-load state** — `let rows=[]; let error=null; let loading=true; let busy=null` + try/finally. ~50 basecamp routes, ~20 example. `busy === row.id` per-row flag in 26 basecamp routes.
5. **`service.find` + local rows + live re-grade.** 16 basecamp files carry `READS = new Set([...]); service.on('*', …)`, each with a DIFFERENT reads list (`widgets/live.js` extracted it for widgets; routes kept their copies; `volumes/index:81` admits it does not settle, `FJS-139`). serpgrid: 50 `service.find` vs 3 `list()`. transit/portal: 24/40 `list()`, 0 `find`. The store is the answer; `find` is easier to reach for.
6. **App store spellings.** `export const s = watchProxy({…})` (remnant, linear, notion, serpgrid) · raw object + shadow `_w` proxy (chatwoot, portal — reads of the raw object are INERT) · callback Set (quo `phone.js`). One documented shape, or `createStore()`.
7. **Load once the session is known** — four spellings: `$: { if (session.user) }` · handler + immediate call · `started` flag + `onMount` + `$: session.checked` · `sessionReady.then()` in a lib.
8. **Debounced reload on service events** — `setTimeout`/`clearTimeout`/`$.onDestroy`: chatwoot, calendly, quo ×5, basecamp poll loops ×5, sstime ×2.
9. **Link-holder portal** — `location.hash` token → redeem → `history.replaceState` → raw fetch: lago, jazzhr, chatwoot, serpgrid p/r/w, portal, transit, ela survey. Seven spellings; no `page.hash`, no client noun for a session the server ruled on (`FJS-D340`). **`page.hash` dropped**: all eleven sites read the fragment once at mount, which `location.hash` already answers. The gap is the client half of `FJS-D340`'s redeem, which is a bearer-access question rather than a kit one.
10. **Authenticated file download** — fetch with bearer → blob → `<a download>` → revoke: six copies (serpgrid, transit, sstime, portal, darkroom, charter, chatwoot). Three of them build `Authorization` by hand from `getClient().token`. **Done**: `download(blob, filename)` in `@frontierjs/ui/utils`. The auth half was already `client.fetch` (§ 5 rule 20), and the transit copies revoke the URL in the same task as the click, which can cancel the save.
11. **Nav table + shell** — every `_module.mesa` is rewritten; sstime `lib/shell/nav.js`, serpgrid `NAV`, portal `MORE`, ela/maidtech `nav.js` with `sectionFor/tabsFor`, basecamp/example "nav list is also the ⌘K palette". A `Shell` with a `nav.js` contract (groups, section tabs, bare prefixes, drawer copy). **Owner's question**, `IDEAS/ui-kit-gaps.md` § Open questions (recommend a paper first).
12. **Icon.** Five local `Icon.mesa` (ela, maidtech, quo, serpgrid, sstime), three distinct implementations. Kit ships none. **Owner's question**, `IDEAS/ui-kit-gaps.md` § Open questions (recommend none: css § Icons ships no icons by design, and the copies agree).
13. **Drain every page** — ela `readAll()`, maidtech `KanbanColumns` drain (145k requests before the stop conditions were learned, `FJS-2617`). `list()` needs `all()`. **Done**, as `list({ all: true })` rather than a method: `load()` resets the window to page one, so a drain the caller runs once is lost at the next filter change. The window is grown inside each load, and stops on an error and on a page that adds nothing. maidtech's `KanbanColumns` drain is replaced by it.
14. **Form over a custom method's input** — jazzhr apply, connectteam `assign`, calendly availability rule, sstime `amend`, chatwoot reply. `<Form>` has no story for a method that is not create/patch.
15. **Tenant/workspace scope** — notion/linear `lib/workspace.js` (copied), serpgrid `lib/agency.js`, chatwoot `loadMe`: `watchProxy` + localStorage + hand `x-workspace-id` header + raw fetch.
16. **Report** (transit) — `X.query.js` + `X.mesa` + `X.email.mesa` + runner: one noun, three targets, same split as a Resource. Deserves a folder beside `resources/`.
17. Smaller: `nameOf(id)` over a roster (5), fractional rank `lib/rank.js` copied linear→notion (`FJS-D366` owes it), latest-wins async guard `mine === asked` (4), `matchMedia` breakpoint listener (ela ×2), per-field debounced autosave (ela `TicketSummary`), undo-able toast (ela), pin-to-bottom scroller (quo), pointer drag (darkroom, remnant ×2; **done** as `@frontierjs/ui/drag`, darkroom's promoted — remnant's two and serpgrid's lack `pointercancel`), recovery-code card (example + basecamp byte-near).

## 4. Leaky abstractions — DOM escapes and what Mesa lacks

Where apps reach past Mesa, they say why, and the reasons cluster:

- **No after-commit hook.** `queueMicrotask(() => requestAnimationFrame(fn))` hand-rolled as `afterDraw` (basecamp `workbench:119`), `$.tick().then(querySelector(...).scrollIntoView)` (ela, remnant ×6). Document `$.tick` as sufficient or ship the primitive.
- **Scroll a keyed row into view / focus a child.** 21 querySelector in remnant, 13 in basecamp, 3 in ela: all `[data-id=…]` lookups that `bind:this` on an `{#each}` child cannot do. One instance's selector finds another instance's node once two mount.
- **Global listeners two ways.** `<mesa:window on:keydown>` in shells; `window.addEventListener` + manual removal in workbench, registers, pages (`pages/index:122,138` never removes — leaks across navigations).
- **`{@attach}` torn down by an unrelated import watch** (`FJS-D404`/`FJS-2616`). ela ships `const DRAG_FOCUS_WORKS = false` as a permanent feature flag.
- **`const` over a getter is a constant.** ela `AssignmentBoard:90`, `TrackerDay:119` and the scaffold's `[id].mesa:58` all carry the same discovery comment; not in `mesa.md`.
- **Field-rules gaps patched per app.** portal registers a `tokens` control by column name because `String[]` loses `items`; charter `validate: false` because a server hook fills a required column (`FJS-095` shape).
- **Hand-rolled drafts drop `version`.** 6 of 10 basecamp `draft = {...row}` editors patch without `version` — silent overwrite under `@version`.
- **Unkeyed each over rows WITH controls** (the real FJS-325 hits among ~150 benign ones): basecamp `apps/[id]:722` (18-row textarea per file, index-keyed, `dropFile(i)` rebinds), `flags/index:345`, maidtech `users/current:112`, transit `Dashboard.mesa` ×4 over live rows.

## 5. Rules for an agent writing Mesa — not yet in `ui-hazards/mesa.md`

1. **`load(); $: dep, () => load()` — two lines, that order, together.** The handler form never runs at mount; this pairing is the idiom. Not `$.onMount(load)` + handler (double load when dep settles during boot). Not a `started` flag.
2. **A `const` initialized from a getter on an imported handle (`list.rows`) is a constant.** The compiler derives from the expression text and cannot see a signal behind a getter. `let` + braced `$: {}`, or read the getter in the template.
3. **`find()` answers the envelope; `invoke()` answers what the method returned. Never `r?.data ?? r`.** Use `findData()`; if a custom method answers an envelope, fix the service.
4. **`list()` is the page's list. `service.find` in a route means YOU own live re-grading** — and 16 copies of `READS = new Set` is the price. Use `find` only to fold rows client-side, and say so.
5. **A hand-rolled edit draft carries `version`.** `draft = {...row}` → `patch(id, draft)` without it is a silent overwrite.
6. **A module store is `export const s = watchProxy({...})` and every read AND write goes through it.** A raw-object twin makes readers inert; a callback Set is a second runtime.
7. **Never `import { onMount } from '@frontierjs/mesa/runtime'` in an instance `<script>`.** `$.onMount` is the door; the bare import is `<script module>` only.
8. **A DOM read after a write is `bind:this` + `await $.tick()`, never `document.querySelector` from a component.** The selector finds another instance's node.
9. **A `window`/`document` listener in a route is `<mesa:window on:x>`.** A hand `addEventListener` without a matching `$.onDestroy` outlives the screen.
10. **Index-keyed `{#each}` over rows that hold a control is a rebind on delete.** A row with `<Input>`/`<Textarea>`/a revoke button takes `(row.id)`; `i` is identity only when nothing else is. A column loop inside a `<Table>` snippet may stay unkeyed.
11. **`x = x` after mutating or destructuring into `x` carries a one-line comment naming the rule**, or the next edit deletes it.
12. **A tone map for an enum lives once, in the resource's `<script module>`**. Never in a route (`FJS-D817` refused a schema home).
13. **`style="--knob: {v}"` is the only inline style.** Read it in `<style>`. A layout property (`left`, `top`) is `style:left`. A color that is DATA (a picker value, a draw color) is a value, not styling.
14. **A `.mesa` with a PascalCase name under `routes/` is a component the scanner skips.** transit and remnant rely on it; sierra's layout does not say so.
15. **A resource file with no markup half says why in a comment below `</script>`** (`quo/resources/Call.mesa`), so "no form" reads as a decision.
16. **Delete through `ConfirmProvider`, never `window.confirm`** — and the fix is in `crud-templates.js` first.
17. **A `$:` list that closes over live rows sits ABOVE the `$:` that reads it** (basecamp `_module:85`). Ordering is undocumented.
18. **`aria-current={(page.route, isActive(...)) ? 'page' : null}` — the leading read IS the dependency.** General case: a function reading reactive state out of sight gets no subscription; name the path in the expression.
19. **A paging loop over `more()` stops on `rows.length` unchanged AND on `error`, never on `hasMore` alone** (`FJS-2617`).
20. **A client fetch that needs the session goes through the client, never `getClient().token` into a raw `fetch`.**

## 6. Suggested order

1. Fix the dead import across 9 prototypes (one command), then grade it.
2. Scaffold: `ConfirmProvider`, `<form>` on login, drop the inline `max-width`, extract `resource.detail(id)` and use it in `editPage`. **Done** — delete is `ConfirmationPopover`, and the detail half became `record(id)` grown (§ 3.1).
3. Decide three nouns through `decision-rules`: `detail(id)`, `x-tone`, the invoke/find envelope rule. **Done** — `detail(id)` became `record(id)` grown (§ 3.1), `x-tone` was already refused (`FJS-D817`, § 3.2), and the envelope rule is `FJS-D937` (§ 3.3).
4. Fold § 5 into `ui-hazards/references/mesa.md` (rules 1, 2, 6, 7, 8, 9, 11, 17, 18) and `resources-and-forms.md` (3, 4, 5, 12, 15, 19, 20); 10, 13, 14, 16 into sierra/ui CLAUDE.md. **Done** 2026-10-13, each rule probed before it went in. `mesa.md` took 1, 6, 10 and 11 as amendments to existing entries and 2, 8+9 and 17+18 as three new ones; `resources-and-forms.md` took 3, 4, 12+15, 19 and 20; 13 went to `build-output-and-frontierjs-css.md` and 16 to the ui `AGENTS.md` confirm row. Corrections the probes made: rule 1's `$.onMount(load)` loads one id twice, and the existing entry had recommended it; rule 17 holds only through a function — a direct read of a later `let` is reordered and works; rule 18's local function stays put under a watch while an imported one re-runs (RULE 64); and `$: x = store.y` is not an import watch, which is new. **Dropped:** 5 — `service.patch` runs the resource pipeline, which fills the version the screen read or refuses (`FJS-D468`), so § 4's *drafts drop `version`* bullet is not a silent overwrite; 7 — the bare `onMount` import is the same function from the same file and runs identically; 14 — sierra's README already states it (`scanner/classify.js`). `$.tick()` is sufficient for § 4's first bullet.
5. Kit: `Icon`, `Shell`/nav contract, `list().all()`, a `download` helper, a `drag` attachment, `page.hash`. **Done** 2026-10-13 for three, each through `decision-rules` before the edit. `list({ all: true })` (sierra `list.js`, 5 tests; without the no-progress stop the suite hangs, the `FJS-2617` freeze). `download(blob, filename)` (ui `utils.js`, saved by Chrome in `download.spec.mjs`). `drag` (`@frontierjs/ui/drag`, `drag.spec.mjs`, red under both a missing capture and a missing cancel listener). **Dropped:** `page.hash` (§ 3.9). **Owner's questions:** `Icon` and the shell (`IDEAS/ui-kit-gaps.md`). The prototypes are not migrated, except maidtech's drain. Remnant's `Sheet.mesa` and `peek.js`, and serpgrid's `GridCompare`, still lack `pointercancel`.
6. `fli check` candidates: retired-subpath import · unkeyed each over a row with a control · `window.confirm` · ~~`?.data ??` in a `.mesa`~~ (`envelope-hedge`, § 3.3) · `const TONE` in `routes/`.

Per-app scores (1–5, structure + idiom): starters 5 · jazzhr, connectteam, linear, lago, sstime, transit, charter, darkroom, ela, maidtech, example 4 · calendly, chatwoot, notion, quo, serpgrid, portal, remnant, basecamp 3.
