---
id: site-kit-plan
status: proposed
dated: 2026-10-06
---

# Plan — building out `@frontierjs/site-kit`

**Status: PROPOSED. The order of work; its forks are ruled (`FJS-D604`–`D608`).** Dated
2026-10-06. Do not cite as behavior — see `VERIFYING.md`.

Two papers already hold the material and this one restates neither:
`site-kit-parity.md` is the inventory (what site-kit lacks against legacy
ksite), `site-kit-structure.md` the page shape (Section, Article, templates).
`fjs-prototypes/ksite/PLAN.md` § Phase 4 is the stressor's three steps, and
this plan is what those steps look like once site-kit, not `@kobami/ksite`, is
the engine.

**The goal is FJS-D33 for a marketing site.** A Kobami client site is its
`content/` folder and a version number, and an engine change reaches every
site as a bump. Done means fli's `ksite:*` group (`clone`, `setup`, `update`,
`serve`) and the `[ACTION]` lines in legacy's `CHANGELOG.md` are deleted
because nothing needs them.

## Open questions

The first three are the forks `site-kit-parity.md` left unanswered; the
fourth came out of the website move; the fifth is the seam Phase 2 needs.
All five are ruled.

- ~~**Whose engine is site-kit — ksite's made generic, or a core sized to frontierjs.com?**~~ **Answered 2026-10-06 (`FJS-D604`): A — ksite's engine made generic. Everything `fli ksite:update` overwrote (`src/`, `config/`, `functions/`, `public/theme/`) moves to site-kit, except what is the cleaning-company template: its blocks, the lead widget, its theme. `@kobami/ksite` shrinks to those.**
  - **A** — ksite's engine made generic. Everything `fli ksite:update` overwrote (`src/`, `config/`, `functions/`, `public/theme/`) moves to site-kit, except what is the cleaning-company template: its blocks, the lead widget, its theme. `@kobami/ksite` shrinks to those.
  - **B** — a core frontierjs.com needs: the shell, the build, settings, the head. Every block stays in `@kobami/ksite` until a second engine wants it.
  - **C** — site-kit is ksite renamed: the whole engine moves and ksite is content only.
  - **Recommend A** — frontierjs.com writes `.mesa` routes and uses one block, so B makes the site that needs the least the measure of what is generic, and leaves the markdown dialect, Section and collections in a client package where a second agency's site would have to fork them. Preventing that fork is the reason site-kit exists (its `CLAUDE.md`). C puts one industry's template into a framework package. The line A draws is a test, not a guess: *would a site that is not a cleaning company use this unchanged?*

- ~~**Does the block library move on demand, or all at once?**~~ **Answered 2026-10-06 (`FJS-D607`): A — on demand: a block moves when a site's content names it, the stressor's rule.**
  - **A** — on demand: a block moves when a site's content names it, the stressor's rule.
  - **B** — the whole library, before any client cuts over.
  - **C** — on demand, ordered by a census of what live clients use. Grep every client's `content/` for the tags and `layout:` values it names, rank the blocks by how many sites name them, and port in that order. A block no client names is not ported.
  - **Recommend C** — `conversion-ksite.md` names the library as the bulk of the cost, and B pays it for blocks nobody renders. A is right, but it orders the work by whichever site happens to move first. The census is one command over the client repos (`kobamisites` on GitHub; four trees are local in `~/code/KOBAMI/SITES`), and it turns *parity* into a list with an end.

- ~~**Which tooling gaps in `site-kit-parity.md` § 4 become framework owners?**~~ **Answered 2026-10-06 (`FJS-D608`): A — wire every gap Sierra already owns (`defer-js`, `speculation`, `sierra/analytics`); fix the two filed as Sierra's (FJS-1539 head, FJS-1540 host function) in Sierra; start every gap with no owner (images, per-page JSON-LD, the lead fallback, animations) as site-kit code, and move one to Sierra when a consumer that is not a site-kit site needs it.**
  - **A** — wire every gap Sierra already owns (`defer-js`, `speculation`, `sierra/analytics`); fix the two filed as Sierra's (FJS-1539 head, FJS-1540 host function) in Sierra; start every gap with no owner (images, per-page JSON-LD, the lead fallback, animations) as site-kit code, and move one to Sierra when a consumer that is not a site-kit site needs it.
  - **B** — give each of images, per-page JSON-LD and the static-host function a Sierra owner before site-kit ports it.
  - **C** — all of it stays site-kit code, FJS-1539 and FJS-1540 included.
  - **Recommend A** — *batteries vs. smallness*: site-kit is the battery and stays severable, and a Sierra owner is earned by a second consumer, as *paved road vs. the workaround* measures a road. FJS-1539 and 1540 are already Sierra's rows, so C would build a second owner beside a filed one (Invariant 4).

- ~~**Is a site's page folder `content/routes` or `content/pages`?**~~ **Answered 2026-10-06 (`FJS-D606`): A — `content/routes`, as the website has it: Sierra's `routesDir` word, and every Sierra surface's `src/routes`.**
  - **A** — `content/routes`, as the website has it: Sierra's `routesDir` word, and every Sierra surface's `src/routes`.
  - **B** — `content/pages`, as ksite has it, and the word a markdown author uses.
  - **Recommend A** — the folder holds routing syntax (`_module`, `[pkg]`, `.meta.js`), and a site-kit site should not be the one Sierra surface whose folder has another name. `VOCABULARY.md` blesses *Route* as an API noun and leaves *Page* open, so if `pages` is the better UI word, that is a rename across Sierra, not a site-kit exception. ksite's spelling carries no weight (*preservation vs. evolution*).

- ~~**How does `@kobami/ksite` add its blocks, theme and markdown dialect to a site-kit site?**~~ **Answered 2026-10-06 (`FJS-D605`): A — the site names its engine in `content/settings/site.js` (a package name, which is plain data, so FJS-1544 holds), and `site-kit dev|build` loads that package's blocks, layouts, stylesheets, remark plugins and post-build plugins.**
  - **A** — the site names its engine in `content/settings/site.js` (a package name, which is plain data, so FJS-1544 holds), and `site-kit dev|build` loads that package's blocks, layouts, stylesheets, remark plugins and post-build plugins.
  - **B** — ksite ships its own bin that wraps `siteKit()`, and a client runs `ksite build site`.
  - **C** — the client writes a config file that composes the two.
  - **Recommend A** — one command and one shell for every site, and the site states its engine in the one file that is already its own. B gives each engine a second CLI to keep in step with site-kit's. C puts a non-content file back into the client, which is what Phase 4 measures as cost. The key's name, and the noun for what it names, go through `decision-rules` before code.

`site-kit-structure.md` § Open questions holds the page-shape questions, which
gate Phase 3.

## Phases

Each phase ends green on two grades: ksite's baselines in
`fjs-prototypes/ksite/baseline/` (pixel-exact, or each diff a line in its
Port ledger), and the website's `bun run test` matching its pre-phase run.
**A phase is proved from a tarball install**, because a workspace link hides
what only a published engine has (FJS-1552).

**Phase 1 — re-prove the ksite split.** FJS-1551, 1552 and 1553 closed after
ksite's Phase 4 step 1 stalled on them, and nothing has re-run it since. In
`fjs-prototypes/ksite`: `vite build`, the four baselines, then the same from
a packed tarball. File what breaks. This costs one session and decides whether
Phase 2 starts from a working engine package or from new rows.
**Done 2026-10-07: a working engine.** One row broke it, `FJS-1902` (the
prerender skipped a `_module.md` layout), fixed in the same session; after it
the build is 4/4 pixel-exact from the workspace and from a tarball install.
Grade with `baseline/playwright.port.config.ts`: ksite's own config falls back
to serving the legacy site, so a dead port server passes.

**Phase 2 — ksite runs on site-kit's shell.** ksite deletes its own
`index.html`, entry, Vite config and `ksite(import.meta.url)` and runs
`site-kit dev|build site`, with `@kobami/ksite` named in the site's
`content/settings/site.js` (`FJS-D605`). ksite's `content/pages` becomes
`content/routes` (`FJS-D606`). FJS-1554 is moot
for a site with no Vite config, which is worth confirming rather than assuming.
site-kit's CI allowance (`scripts/ci-allowances.json`) comes out here.

**Phase 3 — the generic line moves.** In this order, each a move from
`@kobami/ksite` to site-kit with ksite's baselines green after it:

1. `Block.mesa` → `Section.mesa`, typed keys for `classes:`, per
   `site-kit-structure.md`.
2. The markdown dialect: `===`, and the use-site classes FJS-1502 unblocked.
3. Collections, and menus and settings back to `.md`, which FJS-D549 unblocked.
4. The head: what `config/site-scripts.js` rewrites after the build moves into
   Sierra as FJS-1539's fix.
5. Whatever else `FJS-D604`'s test places on the generic side.

**Phase 4 — a second client** (ksite step 2). Cut one from the engine and
count every file it writes that is not under `content/`. The target is zero,
and each file is either fixed or a line saying why it stays. FJS-1494 (a client
block replacing an engine block) is measured here.

**Phase 5 — an upgrade with no copy** (ksite step 3). Change the engine, bump
it, and both clients take it with no file copied. Then delete `fli ksite:*`,
and ship the codemod (or alias) for every client `theme.scss` that imports
`@/themes/blocks.scss`. Moving site-kit out of `website/` and publishing it is
decided here, once a published engine has been proved.

**Phase 6 — the backlog, on demand.** A block moves when a site that is
moving names it (`FJS-D607`), the § 4 tooling follows `FJS-D608`, and the
content `site-kit-parity.md` § 3 lists comes over with the routes that use it. The open mesa rows the port works around
(FJS-1495, 1500, 1501, 1538) are fixed when a block being moved hits one, not
before.

## Out of this plan

Authoring tooling: the page builder, buildout mode, site-status and SiteChecks
(`site-kit-parity.md` § 2), `on-page-editing.md`, and anchored feedback
(`anchored-feedback.md`). Each sits on site-kit's content model, so each waits
for Phase 3.
