---
id: site-kit-parity
status: assessment
dated: 2026-10-01
---

# Inventory — what `@frontierjs/site-kit` lacks against legacy ksite

**Status: ASSESSMENT — an inventory. No direction is chosen and nothing here is sequenced.**
Dated 2026-10-01. It lists what the ksite stressor left unported, so a choice
of direction starts from a list instead of a re-read. `conversion-ksite.md` is
the pre-port assessment (what the template is, what Sierra already owns, what
is worth taking regardless); this is the after-port remainder, and it restates
none of that file.

Three trees, each read on the date above:

- **legacy** — `~/code/KOBAMI/SITES/ksite/site` (v0.5.0), read-only.
- **the port** — `fjs-prototypes/ksite`: `packages/ksite` (`@kobami/ksite`, the
  engine) and `site/` (its content folder). Its `PLAN.md` § Port ledger is the
  record of each move; the rows below cite it rather than repeat it.
- **site-kit** — `website/packages/site-kit`. It runs `website/site/` from that
  site's `content/` folder (the shell, the dev entry and the build) and holds
  one block, Marquee. Nothing has moved out of `@kobami/ksite` yet, so for
  ksite parity today still means parity of the port.

## 1. Framework rows still open

Re-check each in `ISSUES.md` before planning; these were open on the date above.
FJS-1545, 1551, 1552 and 1553 are closed, which unblocks the Phase 4 static
build and the tarball install. **Neither has been re-run since.**

| Row | Gap | What the port does instead |
| --- | --- | --- |
| FJS-1494 | `autoImport` has no precedence, so a client block cannot replace an engine block and page-local `_X.md` has no spelling | names split across `src/layouts/` and `src/blocks/` |
| FJS-1502 | a remark plugin is given no file path | `enhanceBlock`'s use-site `name`/`slug`/`nested`/`stacked` classes are unported |
| FJS-1539 | nothing reaches a static page's `<head>` | `config/site-scripts.js`, a post-build rewrite of every page |
| FJS-1540 | no host function beside `dist/` | the Plausible proxy and lead fallback (`functions/api/event.js`) are unported |
| FJS-1541 · FJS-D549 | Mesa's frontmatter reader flattens nested YAML | menus and settings converted to `.js` once |
| FJS-1544 | the browser imports `sierra.config.js` whole | the engine hands Sierra `_configPath`, which is undocumented |
| FJS-1554 | `vite-strict-port` greps the one-line delegating config | `fli check` red on the port |
| FJS-1495 · 1500 · 1501 · 1537 · 1538 | unresolved-tag error · heading slug from `{x}` · const in a prop default · `&copy; {expr}` · `undefined` replaces a default | per-site workarounds in the ledger |

## 2. Engine pieces not ported

The port took only what `index.md` and the four graded routes name: **29 of
legacy's 99** `src/blocks` + `src/layouts` + `src/components` names
(`ls … | sed 's/\.svelte//' | sort -u`, diffed against the port's `.mesa`).

- **Content blocks:** Banner · BlogPosts · Posts · RecentPosts · BookingButton ·
  Button · Calendly · Carousel · CleaningForAReason · Collage ·
  CommercialServicesTable · ExitModal · Faqs · FeaturedImage · FormResponse ·
  Iframe · ImageCompare · ImageSlider · Img · JobApplicationButton ·
  LeadFormModal · Link · List · Markdown · Offers · Pdf · PricingResponse ·
  Providers · QuickLinks · QuoteButton · Rating · RatingBadge · Script · Search ·
  Service · ServiceAreas · Services · ServicesGroups · Sidebar · Slideshow ·
  SocialMedia · SocialRatings · Spacer · SplitView · TableOfContents · Team ·
  TeamPreview · Track404 · Trust1 · Video · YoutubeVideo · Anchor ·
  Annotations · Dropdown · Tabs · Page-H1 · Page-Paragraph.
- **The `Dyna*` trio** (DynaBlock, DynaButton, DynaMedia): runtime-chosen
  components. Mesa has no `<svelte:component>`; the port's answer for a list is
  destructuring to a capitalized name (ledger), which may not cover these.
- **Out by the stressor's scope call, still legacy features:** PageBuilder,
  Previewer, PreviewComponents, SiteStatus, SitePages, SiteChecks, SiteHead.
  SiteHead's job is FJS-1539's; the buildout half is `conversion-ksite.md`
  § *The app says which of itself is unfinished*.
- **Themes:** `basic.scss` and `dark-night.scss` (ksite, blocks, blog and the
  port's own `components.scss` came over).

## 3. Content the template ships that the port does not

`find content/<dir> -name '*.md' | wc -l`, legacy → port:

| Dir | Legacy | Port | Missing |
| --- | --- | --- | --- |
| pages | 32 | 6 | the ungraded routes |
| collections | 24 | 15 | `faqs`, `offers`, `services`, `team` |
| blocks | 22 | 8 | |

## 4. Runtime and build tooling

Some of this has a Sierra counterpart that the port never wired; the rest has
no owner. Which is which, per `conversion-ksite.md` § *Already answered here*:

| Legacy | Sierra owner | Port |
| --- | --- | --- |
| `core/lazy-loader.js`, `preload.js` | `postbuild/defer-js.js`, `speculation.js` | unwired |
| `core/tracking.js` (Plausible/GTM), the `ka-*` click convention | `sierra/analytics` (`track()`, imperative) | unported; the convention has no counterpart |
| `core/schemaGeneration.js` per-page JSON-LD | none | site-wide Organization/WebSite graph only, in `site-scripts.js` |
| `core/fallback.js` (`sendBeacon` lead mirror) | none | unported |
| `core/animations.js`, `attentionTracker.js`, `YTLite.js` | none | unported |
| `scripts/make-images.js`, `imageMaker.js` (480/1080/1920 WebP, AVIF, `-mobile`) | none | plain `<picture><img>` |
| `scripts/gfont.js`, `purge-css.js`, `find-large-files.js` | none (`css-delivery.md` is nearest for purge) | unported |
| `scripts/deploy-site.js`, `config/master-sitemap.js` | none for a static host (FJS-1540) | unported |
| `scripts/check` | none | ported as `ksite-check`, minus site-status, `deploy_check` and `generator.test.js` |
| the markdown dialect beyond `===` (`==mark==`, `:icon:`, `\|>` split, kicker detection, autolinks) | `mesa.remarkPlugins` / `rehypePlugins` | only `===` and the heading/link classes |

## 5. The move itself (PLAN.md Phase 4, steps 2–3)

- **Draw the generic/ksite line inside `@kobami/ksite`.** What is the
  cleaning-company template (`CleaningForAReason`, the lead widget, the theme)
  versus what frontierjs.com would also use. Nothing has measured it.
- **A second client from the engine**, counting what it writes that is not
  content (step 2).
- **An engine bump taken by both sites with no copy** (step 3). That retires
  fli's `ksite:*` group (`clone`, `setup`, `update`, `serve`) and the
  `[ACTION]` lines in legacy's `CHANGELOG.md`.
- **Every existing client's `theme.scss`** imports `@/themes/blocks.scss`,
  which became `@ksite/themes/blocks.scss`: a codemod line or an alias.
- **site-kit's CI exemption** (`scripts/ci-allowances.json`) goes with the
  first piece that lands, per its `PROJECT_STATE.md`.

## Forks a direction has to pick

Listed, not answered.

- **Whose engine is site-kit?** It could be ksite's engine made generic, with
  ksite extending it (the intent in site-kit's `README.md`), or a smaller core
  that frontierjs.com needs, with ksite's blocks staying in `@kobami/ksite`.
- **Port on demand or port the library?** The stressor ported blocks on demand.
  Parity with legacy means the ~70 remaining components, and
  `conversion-ksite.md` already names the block library as the bulk of the cost.
- **Which section 4 gaps become framework owners** (images, JSON-LD, a
  static-host release) **and which stay engine code.**
