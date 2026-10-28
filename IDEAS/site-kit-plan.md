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
fourth came out of the website move; the fifth is the seam Phase 2 needs,
and the sixth is the name that seam is spelled with.

- ~~**Whose engine is site-kit — ksite's made generic, or a core sized to frontierjs.com?**~~ **Answered 2026-10-06 (`FJS-D604`): A — ksite's engine made generic. Everything `fli ksite:update` overwrote (`src/`, `config/`, `functions/`, `public/theme/`) moves to site-kit, except what is the cleaning-company template: its blocks, the lead widget, its theme. `@kobami/ksite` shrinks to those.**
  - **A** — ksite's engine made generic. Everything `fli ksite:update` overwrote (`src/`, `config/`, `functions/`, `public/theme/`) moves to site-kit, except what is the cleaning-company template: its blocks, the lead widget, its theme. `@kobami/ksite` shrinks to those.
  - **B** — a core frontierjs.com needs: the shell, the build, settings, the head. Every block stays in `@kobami/ksite` until a second engine wants it.
  - **C** — site-kit is ksite renamed: the whole engine moves and ksite is content only.
  - **Recommend A** — frontierjs.com writes `.mesa` routes and uses one block, so B makes the site that needs the least the measure of what is generic, and leaves the markdown dialect, Section and collections in a client package where a second agency's site would have to fork them. Preventing that fork is the reason site-kit exists (its `CLAUDE.md`). C puts one industry's template into a framework package. The line A draws is a test, not a guess: *would a site that is not a cleaning company use this unchanged?*

- ~~**Does the block library move on demand, or all at once?**~~ **Answered 2026-10-06 (`FJS-D607`): A — on demand: a block moves when a site's content names it, the stressor's rule.**
  - **A** — on demand: a block moves when a site's content names it, the stressor's rule.
  - **B** — the whole library, before any client cuts over.
  - **C** — on demand, ordered by a census of what live clients use. Grep every client's `content/` for the tags and `layout:` values it names, rank the blocks by how many sites name them, and port in that order. A block no client names is not ported.
  - **Recommend C** — `conversion-ksite.md` names the library as the bulk of the cost, and B pays it for blocks nobody renders. A is right, but it orders the work by whichever site happens to move first. The census is one command over the client repos (`kobamisites` on GitHub; four trees are local), and it turns *parity* into a list with an end.

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

- ~~**What is the `content/settings/site.js` key that names `@kobami/ksite`, and what is the noun for what it names?**~~ **Answered 2026-10-08 (`FJS-D648`): A — `preset: '@kobami/ksite'`, and the noun is *Preset*: a package that contributes blocks, layouts, stylesheets and build plugins to a site-kit site.** `FJS-D605` left both to `decision-rules`. The key sits in the default export beside `siteUrl`, which is site-kit's contract for that file; site-kit reads it and strips it before the rest reaches Sierra. The named package exports one entry that returns its blocks, layouts, stylesheets, remark plugins and post-build plugins, and a name that does not resolve to one fails the build by name.
  - **A** — `preset: '@kobami/ksite'`, and the noun is *Preset*: a package that contributes blocks, layouts, stylesheets and build plugins to a site-kit site.
  - **B** — `engine: '@kobami/ksite'`, `FJS-D605`'s own word.
  - **C** — `theme: '@kobami/ksite'`, as Jekyll and Hugo spell it.
  - **Recommend A** — *familiarity vs. precision*: UnoCSS, Docusaurus and Babel all use preset for a package the consumer names that adds a bundle of contributions to a host tool, and the word fits whole. B gives every site two engines: `FJS-D604` made site-kit the engine and shrank ksite to the template it carries, and `ARCHITECT.md` already refuses *engine* for a Rig. C is the closest ecosystem match, but `theme:` is already the switcher's key in this same file and `@frontierjs/css`'s word for a class on `<html>`. `extends` is not an option: it is tsconfig's word for merging two configs of the same shape, which this is not.

- ~~**What may a word after a divider (`====|.duo.reverse`, `===|.featured`) name?**~~ **Answered 2026-10-12 (`FJS-D918`): A — checked: a css look word (a Layout helper, a tone, treatment or density, `align-*`), placed where Block places it, or a class the site's built stylesheets define; any other word stops `site-kit build` naming the file, the divider and the word.** `FJS-D823` refused `classes:` on a Block because nothing checks a free string, and a divider's words are one. A ksite client's pages are mostly its own words (Luminous Heart: `duo` 12, `centered-prose` 17, `count-3`), styled by its own stylesheet.
  - **A** — checked: a css look word (a Layout helper, a tone, treatment or density, `align-*`), placed where Block places it, or a class the site's built stylesheets define; any other word stops `site-kit build` naming the file, the divider and the word.
  - **B** — typed only: css look words plus one segment name the site stylesheet keys on, as a block's `name`; every client's divider lines and stylesheet are rewritten.
  - **C** — free, as ksite had it.
  - **Recommend A** — it answers `FJS-D823`'s reason rather than its spelling: the string is checked, against what the site actually ships, so a typo fails and a client's content ports unchanged. B makes every client pay a rewrite for the same guarantee, and C reopens the hole `FJS-D823` closed.

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
**Done 2026-10-08.** The key is `preset` (`FJS-D648`). `@kobami/ksite`'s
`config/vite.js` became `config/preset.js`, a function of the site returning
`{ sierra, plugins, shell }`; its `index.html` moved into the package, and the
site is `content/` plus `deploy/`. Two rows were found and fixed:
`FJS-2025` (Sierra's post-build overwrote a `robots.txt` outside
`<root>/public`) and `FJS-2026` (a linked site-kit ran the workspace's vite).
Graded 4/4 pixel-exact four ways: build and dev, from the workspace and from a
tarball install of both packages. The website's `bun run test` is identical
to its run before the phase. FJS-1554 is moot, confirmed: `fli check` reports
*no vite config*. The CI allowance had already gone in `edfd6ace`.

**Phase 3 — the generic line moves.** In this order, each a move from
`@kobami/ksite` to site-kit with ksite's baselines green after it:

1. `Block.mesa`, keeping its name (`FJS-D654`): typed keys replace
   `classes:`, and a top-level block emits `band` plus one Layout helper, per
   `site-kit-structure.md`.
   **Done 2026-10-09.** site-kit ships `src/layouts/Block.mesa` and owns
   `markdownLayouts`. ksite loads the parts of `@frontierjs/css` a Block emits
   into (tokens, tones, Surface, Layout, Band), and its theme states css's
   tokens in its own values. Its content says `template: split` and
   `tone: muted`, and what the keys cannot state (three breakpoint rules) went
   to the site's `styles.scss`. ksite's Uno preset gave up the six tone words
   it defined and nothing used. Graded by an exact pixel diff against the
   build before, since the baselines pass a stripe gone white: identical at
   six widths, in build and dev, from the workspace and a tarball install, but
   for one heading's antialiasing on `/services/` (ksite's Port ledger).
2. The markdown dialect: `===`, and the use-site classes FJS-1502 unblocked.
   **Done 2026-10-12.** site-kit owns `====` (a Band), `===` (an article),
   `====|block`, the words after `|` (`FJS-D918`: a css look word, or a
   class the built stylesheets define, else the build stops by name),
   kickers (`p.kicker`), `==mark==` and phone and email links. Position emits
   no class (`FJS-D614`), so `segment-N`, `article-N` and ksite's
   `span.preheading` and `mark.accent` are gone. ksite gave up its copy and
   keeps only its heading and link classes. Graded by an exact pixel diff:
   identical on ksite's four routes at six widths, from the workspace and a
   tarball install, and dev renders the same bands with no console error.
   Luminous Heart is the first client with `====`; its port (Phase 4) rekeys
   its stylesheet and drops six divider words its theme never defines, which
   the check will refuse.
3. Collections, and menus and settings back to `.md`, which FJS-D549 unblocked.
   **Done 2026-10-12.** A site's settings are `content/settings/site.md`,
   each key bound bare through a module site-kit writes to
   `.sierra/settings.js`, since the prerender runs outside Vite and reaches
   no virtual module. `site.js` keeps the Sierra config. `@content` is
   site-kit's alias, and `@frontierjs/site-kit/collection` shapes a block's
   eager glob into `{ slug, frontmatter, Body }` items in file-name order.
   ksite's menus, `site.md` and `whats-included.md` are its legacy files
   again. Graded by a byte diff of the built `dist/`: identical from the
   workspace, and from a tarball install identical apart from the
   stylesheet's hash, where one UnoCSS inspector rule no element uses comes
   only from the workspace scan. Dev renders every route from both installs,
   and an edited value reaches a bare `{company_name}` on reload.
4. The head: what `config/site-scripts.js` rewrites after the build moves into
   Sierra as FJS-1539's fix.
   **Done 2026-10-12.** Sierra's `document` gained `meta`, `links` and
   `jsonLd`, head()'s keys for every page, escaped by the same owner. site-kit
   merges `document` key by key, preset then site. ksite deleted
   `site-scripts.js` and states `bodyAttrs`, `bodyEnd` and its Organization
   graph in `document`. Graded by a byte diff of `dist/`: identical but for
   the JSON-LD `<script>`, unchanged, moving ahead of the stylesheet link.
   Playwright 4/4.
5. Whatever else `FJS-D604`'s test places on the generic side.
   **Measured 2026-10-12; first move done.** Every file left in
   `@kobami/ksite`, against the test:
   - **Moves.** (a) A preset's `public/`: **done.** site-kit finds `public/`
     at the preset package's root and ships it beneath the site's own, the
     site winning a path both have (`config/public.js`). ksite deleted
     `config/theme-assets.js`; its `dist/` is byte-identical, from the
     workspace and from a tarball install. (b) The check's generic half:
     the built-stage rules (sitemap, canonical, titles, descriptions,
     headings, social, links, images, JSON-LD against schema.org's
     vocabulary) and the source-stage components, layouts, dividers, robots
     and redirects rules. Every site-kit site has those, and ksite's
     `config/names.js` restates site-kit's layout order for the components
     rule, a second origin that only this move removes. The template
     leftovers, `launch_date` and `ksite-checks.js` (its business graph)
     stay, so the move needs a seam for a preset's rules.
     **Done 2026-10-13 (`FJS-D962`).** `site-kit check <dir>` on the one
     bin; a preset returns `rules`, and one with a kit rule's id replaces
     it. The check reads `resolveSite()`, the object the build is made from,
     so `names.js` is gone. ksite keeps a `Template` group and its
     structured-data rule over the kit's auditor; `check:site` reports the
     same findings as before, one for one. Learned: a peer on the
     unpublished site-kit fails `bun install` (as Phase 5 says), so ksite
     imports `@frontierjs/site-kit/check` without declaring it until Phase 5.
     The first run on frontierjs.com found `FJS-2829`.
   - **`document` in dev: done 2026-10-13 (`FJS-D971`, A).** Sierra
     applies `document` to `index.html` for a `static` target, in dev and in
     the build, through `wrapDocument()`'s own serializer; an attribute
     stated in both places is refused naming both. The probe found three
     restaters, not one (ksite, `example/site`, the `fli make:site`
     scaffold), and all three now state it once. ksite's `src/main.js` keeps
     re-running the lead loader per navigation, reading the list from the
     page's `bodyEnd` scripts instead of restating the URL. ksite's `dist/`
     is identical apart from the stylesheet hash, which moved with two
     `@frontierjs/css` tokens from another lane.
   - **Stays, by the test.** The theme, its Uno preset and `rehype-content.js`'s
     heading and link classes (the look; a repo package ships no utility
     classes, Invariant 13). The shell (`Page`, `Header`, `Footer`,
     `PageHero`, `Nav`, `SiteMap`, `Logo`), whose markup is that stylesheet's
     contract. The business blocks (reviews, stars, hours, services, the
     lead, booking and phone buttons). The Organization graph and the
     `siteUrl`/`name`/`description` mapping, which read ksite's setting
     names (`company_name`, `seo_description`); they are generic only once
     site-kit names a settings vocabulary, and no other site has a `site.md`.
   - **Generic in function, moved on demand (`FJS-D607`).** `Image`, `Link`,
     `Button`, `Spacer`, `Icon`. Their classes (`.image`, `.img`,
     `.link-header`) are ksite's stylesheet hooks, so the first site that is
     not ksite and names one decides what site-kit's emits (Phase 4).
   - **Held to `site-hosting.md`** (`FJS-D919`–`D921`: Sierra owns the host
     files, the function bundle and the adapters; site-kit presets them).
     **Redirects: done (`FJS-D961`).** A site's own are
     `content/settings/_redirects`, as every legacy client has them
     (maid.tech's are live campaign links). site-kit emits the file, and
     Sierra merges it with the routes' `redirect:` rules, routes first,
     refusing one path sent two places. A `_redirects` in `content/public/`,
     and a `_redirects` or `_headers` in a preset's `public/`, stop the build
     by name. The check's `redirects` rule ports without ksite's
     `redirects-file-replaced` warning, since the file is no longer replaced,
     and reads `content/settings/_redirects`. A preset's `functions/`
     is found at the package root `loadPreset` returns, the way `public/` is,
     so Sierra's functions option takes directories in order (the site's
     first) rather than one. `FJS-D971` ruled the wider rule with
     `document`: Vite dev runs what the static build ships. Host functions
     (ksite's lead loader posts to one) and `_redirects` in dev are built
     when a site first needs one there.
6. Responsive images ([`FJS-2737`](../ISSUES_ARCHIVE.md#fjs-2737)), the first client's
   largest gap: the Luminous Heart port ships 20 MB of photos at source size.
   `site-kit-images.md` holds the measurement, the prior art and the design: a
   postbuild step over the prerendered pages, a content-addressed cache, and
   `Bun.Image` under `FJS-D311`'s seam. Its two forks (where images are found,
   which codec) wait on a ruling. Ahead of Phase 4 so the second client is not
   cut with the gap.
   **Built 2026-10-12** (`FJS-D926`, `FJS-D932`): `config/images.js`. On the
   Luminous Heart port a phone at 3x fetches 60% fewer image bytes and a
   desktop 75% fewer; ksite grades 4/4.
   **Leftovers done 2026-10-13.** Variants are `assets/<name>-<hash>.<w>.webp`,
   so Sierra's one cache rule serves them immutable (`FJS-2755`). `Image`
   forwards `sizes` and the hero's background states `100vw`; the logo was
   measured and left (89 of 99 client logos are SVG). `Image` no longer
   guesses a height, and the step derives it from the photo, so ksite's
   `/about-us/` stops jumping 238 px on load. Exact pixel diff after load:
   identical on ksite and Luminous Heart at five widths; ksite grades 4/4.
   Art direction stays on demand (`FJS-D607`), and so does the move into
   Sierra (`FJS-D608`) (`site-kit-images.md` § Left).

**Phase 4 — a second client** (ksite step 2). Cut one from the engine and
count every file it writes that is not under `content/`. The target is zero,
and each file is either fixed or a line saying why it stays. FJS-1494 (a client
block replacing an engine block) is measured here. The client is Luminous
Heart, whose port Phase 3 step 2 already names; its legacy repo kept a list
of the ten engine files it edited (`KSITE-CHANGES.md`), which is the fork
this phase has to show is gone.

**Done 2026-10-13: three files, against the legacy repo's 282.** The table,
file by file, is `fjs-prototypes/ksite/PLAN.md` § Phase 4, step 2.

1. [x] The cut: Luminous Heart's `content/` in an empty directory, site-kit
   and ksite installed as packed tarballs, and only what the build refuses
   without written by hand. Count each file outside `content/` against the
   legacy repo's.
   **Done.** The client writes `package.json`, `bun.lock` and `.gitignore`.
   Its build matches Luminous Heart's linked build: the same files, every
   page the same apart from asset hashes, and a byte-identical stylesheet.
   Four of the six dependencies are framework peers, named only because the
   published versions are older than the workspace's (Phase 5). The deploy
   files are `site-kit deploy`'s (`site-hosting.md` step 4); the Plausible
   proxy is `FJS-2893`.
2. [x] Grade the ten `KSITE-CHANGES.md` rows against site-kit: fixed in the
   engine, moot, or still needed. One still needed in an engine file is the
   FJS-1494 case.
   **Done.** Five were already fixed: the opening `====`, `width` driving
   images, the content files engine blocks hard-imported, Nav's crash on a
   missing route, and kickers. The `hours.md` key and the Routify error are
   moot. `.services` stays as the template's look, and the client restyles it
   in its own stylesheet, which is content. Two were open in the engine:
   non-E.164 `tel:` links and `overflow-x: hidden`. No row needs a client
   block to replace an engine block, so FJS-1494 stays open until a client
   needs that.
3. [x] Fix in the engine each row 2 leaves open, and delete the client's
   workaround for it.
   **Done.** `telHref` (`@frontierjs/site-kit/tel`) is the prose pass's and
   ksite's three blocks', which clears `tel-format` on all 23 pages. ksite's
   `html` and `body` clip rather than hide, and Luminous Heart's override is
   deleted. Its sticky header stays pinned at 390 and 1280 px; forcing
   `hidden` back unpins it.
4. [x] Prove: the cut's build against Luminous Heart's linked build, ksite's
   four baselines and an exact diff of its build, site-kit's suite and the
   website's `bun run test`.
   **Done.** ksite's baselines pass 4/4. Screenshots of its four routes at
   five widths are byte-identical before and after. Luminous Heart's seven
   routes at five widths are byte-identical with and without its override.
   The site-kit suite passes 160 checks, and the website's `bun run test`
   passes.

**Phase 5 — an upgrade with no copy** (ksite step 3). Change the engine, bump
it, and both clients take it with no file copied. Then delete `fli ksite:*`,
and ship the codemod (or alias) for every client `theme.scss` that imports
`@/themes/blocks.scss`. Publishing site-kit is also when `@kobami/ksite`
declares it as a peer: bun fetches a peer's metadata from the registry, so a
peer on an unpublished package fails every `bun install`, workspace included. Moving site-kit out of `website/` and publishing it is
decided here, once a published engine has been proved.

Ruled 2026-10-13 with the owner: the bump is proved on a local registry
before anything reaches npm, site-kit moves to `packages/` now, `@kobami/ksite`'s
registry is picked at the real publish, and `ksite:fetch` becomes site-kit's.

1. [x] Move site-kit to `packages/site-kit`, every caller in the same change,
   and drop the `website/packages/*` workspace glob. It is a framework
   package to be published, and `fli ws:pub` reads `packages/*` only.
   **Done 2026-10-14 (`FJS-D988`).** It has a Packages-table row and a
   `typecheck` script (clean), and its `CHANGES.md` is `docs/CHANGES.md`. A
   `link:` consumer holds the old path until `bun link` is run in the new
   one, which ksite and Luminous Heart both needed.
2. [x] Delete `fli ksite:*`. `fetch` (a page or sitemap to Markdown and
   images) is generic by `FJS-D604`'s test, so it becomes `site-kit fetch`
   writing `content/routes`. Luminous Heart's `port/convert.mjs` and the
   `theme.scss` rewrite (`@/themes/` to `@ksite/themes/`, a codemod and not
   an alias) read the legacy dialect, so they become `@kobami/ksite`'s bin.
   **Done 2026-10-14.** `fli ksite:*`, `make:fetch-config` and `core/peer.js`
   are deleted, and so are fli's `linkedom` and `turndown`. `site-kit fetch`
   is `fetch/run.js`, with a test against a site it serves. `ksite port`
   (`packages/ksite/port/convert.js`) takes Luminous Heart's two lists as
   `--drop-words` and `--drop-blocks`, names every legacy file it does not
   port rather than dropping it, and reproduces Luminous Heart's `content/`
   byte for byte, apart from its hand-written `llms.txt`.
3. [x] Prove the bump on a local registry: publish the four framework peers,
   site-kit and ksite at one version, install ksite's site and the Luminous
   Heart cut from it, change the engine, publish the next version, update
   both clients, and diff. The proof is a saved script, not a scratch one.
   **Done 2026-10-14.** `bun run proof:upgrade` in `fjs-prototypes/ksite`
   (`baseline/upgrade.mjs`, the Luminous Heart site as its argument) passes
   16 of 16. Each client is `content/` and a `package.json` naming only
   site-kit and ksite, and builds the same files as its linked build. After
   site-kit 0.1.1 and ksite 0.7.1 are published, `bun update` takes both,
   the build carries both changes, and nothing but `package.json` and
   `bun.lock` changed. ksite declared site-kit as a peer and installed. The
   first run found [`FJS-2842`](../ISSUES_ARCHIVE.md#fjs-2842): a registry install
   could not compile Markdown or prerender, because mesa's optional peers had
   only ever come from the workspace. site-kit now depends on them.
4. [ ] The real publish, behind the owner's go: the framework peers through
   `fli ws:pub`, site-kit's first release, `@kobami/ksite`'s registry picked,
   ksite declaring site-kit as a peer, and the Luminous Heart cut dropping the
   four peers it names only because npm was behind.

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
