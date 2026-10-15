# site-kit — package map

**`@frontierjs/site-kit`** — the engine of a markdown-authored static site. A
site is `content/` over this package; everything a site would otherwise copy
lives here.

**Private until its first release** (`site-kit-plan.md` Phase 5), so the
website's package pages, which walk `packages/*` and skip `private`, do not
list it yet.

**Its dependencies are what a site-kit build needs that a peer only offers.**
Mesa compiles Markdown and Sierra prerenders through `unified`, the
remark/rehype five and `happy-dom`, all optional peers of mesa; a workspace
link supplied them from the repo, and a registry install has nothing else
that names them (`FJS-2842`). `linkedom` and `turndown` are `fetch`'s.

**Two consumers, one engine.** `website/site/`, and `fjs-prototypes/ksite`,
which names `@kobami/ksite` as its preset. A generic piece here and a ksite fork of
it is the outcome this package exists to prevent.

## Layout

A site is a directory holding `content/` and nothing else; `site-kit
dev|build|preview|check <dir>` runs it. The site directory stays the Vite root, so
`dist/` lands beside `content/` and Sierra's root-relative paths keep meaning
what they mean in any app.

- `bin/site-kit.js` — the command. Bun, because the prerender imports each
  route's companion under the running runtime. It runs the SITE's vite, its
  peer: from a linked site-kit a bare import finds the workspace's copy, and
  Vite looks for a preset's `sass` beside its own (FJS-2026).
  `build --binary` then hands `dist/` to Sierra's `compileSite`
  (`@frontierjs/sierra/site/compile`) for `<dir>/bin/site`; `fli site:build
  --binary` cannot, because it runs the `config/vite.config.js` a site-kit site
  has none of (FJS-2756).
- `config/vite.js` — `resolveSite({ root })`, the site as one object: its
  settings, its `site.js`, its preset and the Sierra config the three compose;
  and `siteKit({ root, port, host, site? })`, the whole Vite + Sierra config
  over it. The check reads the same resolved site, so the directories it
  searches are the build's (`FJS-D962`). `siteKit` owns `target`, `routesDir: 'content/routes'`, `outDir`, `trailingSlash`, and
  the route table's home in `<site>/.sierra/` (never `node_modules/`, which
  the browser caches `immutable`); the site's
  `content/settings/site.js` default export is spread over it. Order:
  site-kit's keys, then the preset's `sierra`, then the site's, then
  `routesDir` and `markdownLayouts`, which neither a preset nor a site can
  move. `markdownLayouts` is site-kit's `src/layouts`, then the
  preset's, then the site's `content/layouts` when it exists; a later
  directory wins a name. `autoImport` gains the settings module beside the
  preset's or the site's own. `document` merges key by key, the preset's then
  the site's, so a site's own `head` never costs the preset's `jsonLd`.
- `config/content.js` — `content/settings/site.md` is the site's settings, the
  data its pages and its preset read; `site.js` stays its Sierra config.
  `readSettings()` parses the front-matter with `@frontierjs/toolbelt/frontmatter`
  and refuses a key that is not a JavaScript name. `writeSettingsModule()`
  writes `.sierra/settings.js`, one named export per key, which is what
  `autoImport.modules` binds `{company_name}` to. It is a file and not a
  virtual module, because the prerender imports outside Vite and only an alias
  with an absolute target reaches it there. `siteContent()` is the `@content`
  alias and, in dev, rewrites the module when site.md changes. A key added in
  dev is logged, not bound: Vite's `server.restart()` reuses the inline config,
  so `siteKit()` does not run again.
- `config/preset.js` — `loadPreset(name, site)`: the default export's `preset`
  key names a package whose `./preset` export returns `{ sierra, plugins,
  shell, rules }` (FJS-D648, FJS-D962). A rule is `{ id, group, stage, run }`
  with `stage` `source` or `built`; anything else in the list is refused by
  the preset's name. It resolves from the site, and every way of failing to
  load one stops the build by name, because a site built without its preset
  ships every page without its blocks. It also returns the preset's package
  root, the nearest `package.json` naming it.
- `check/` — `site-kit check <dir>`, exported as `@frontierjs/site-kit/check`
  (`runCheck`, the finding helpers, `withSchema`, `healthFindings`). `run.js`
  merges a preset's rules into the kit's (a shared id replaces, the rest
  append after the kit's groups), runs each, and turns a throw into one
  `check-crashed` finding. `context.js` is what a rule reads: `resolveSite()`'s
  `settings`, `sierra` and `preset`, the content files, and for the built
  stage `dist/` (or the live site), with a note when `dist/` is older than
  `content/`, the kit or the preset. `html.js` reads a page with regexes.
  `rules/` is one file per group: `content` (components, merge-fields,
  dividers, frontmatter), `crawl` (robots, redirects, sitemap, canonical),
  `meta`, `links` (`distOnly`: resolving a live site's links means crawling
  it), `schema`. `schema/` is the JSON-LD auditor forked from
  `WEBSITE-TOOLS/site-auditor/val/`, exported as
  `@frontierjs/site-kit/check/schema/*` so a preset's own checks build on it;
  it is lint-excluded so a re-sync stays a diff. The kit has no launch mode
  and no tool-page notion: a preset's rule grades its own leftovers
  (`atLaunch` is the one field the printer reads for it).
- `config/public.js` — `presetPublic({ dir, site })`: `public/` at the
  preset's root, served in dev and emitted in the build beneath the site's
  `content/public/`, which wins a path both have. Found, never a preset key.
  The dev middleware runs ahead of Vite's own public one, so it checks the
  site's file itself; the build skips a path Vite copies from the site. A
  preset's `public/_redirects` or `_headers` is refused: Sierra writes both.
- `config/redirects.js` — `siteRedirects()`: emits `content/settings/_redirects`
  (where every ksite client keeps its campaign links) as `_redirects`, which
  Sierra's post-build merges with the routes' `redirect:` rules (`FJS-D961`).
  Refuses `content/public/_redirects`, which Vite would copy to the same path.
- `config/dialect.js` — `siteDialect()`, the Markdown dialect every site
  compiles under, ahead of a preset's own passes, and a post-build check.
  `config/dividers.js` (remark) turns `====` into a Band and `===` into an
  `<article>`, as markup rather than a `<Block>` tag, because Sierra binds a
  tag by scanning the source before a remark plugin runs. `config/prose.js`
  (rehype) emits kickers, `<mark>` and tel:/mailto: links. A divider word
  that is not a css look word is the site's class; the check stops the build
  when no stylesheet in the output defines it (`FJS-D918`). It runs as a
  Sierra config plugin's `closeBundle`, which Sierra calls once the pages are
  written; `vite dev` never checks.
- `config/images.js` — `siteImages()`, responsive images (`FJS-2737`): every
  local raster `<img>` in the built pages gets WebP variants and a `srcset`
  (`FJS-D932`, WebP only by `FJS-D926`). A variant is
  `dist/assets/<name>-<hash>.<width>.webp`, Vite's shape, because that is what
  Sierra's `isHashedAsset` serves immutable; any other name is revalidated on
  every view (`FJS-2755`). A tag stating one dimension gets the other from the
  photo; a stated pair is kept. The last Sierra config
  plugin, so it sees each page after the check and a preset's steps. The
  transformer is handed in and `Bun.Image` by default, so it needs Bun; the
  cache is `<site>/node_modules/.cache/site-kit/images`, keyed by the source's
  hash. A block that knows its layout states `sizes`; otherwise the step
  derives it from the rendered `width`. `data-original` opts a tag out. It
  refuses a site with `offline` set: Sierra runs config plugins after the
  offline shell digests the pages.
- `fetch/run.js` — `site-kit fetch <dir> <url|sitemap>`: an existing site's
  pages into `content/routes/` as Markdown, `<meta>` as front-matter, and an
  image a config's `transform` names downloaded under `content/public/`. A
  sitemap index is walked three levels, and `<image:loc>`-style extension
  entries are dropped before the page list is read. The config is a module
  whose `config` export `validateFetchConfig()` grades: an unknown key warns,
  a wrong type stops the command.
- `src/collection.js` — `collection(glob)`, exported as
  `@frontierjs/site-kit/collection`: an eager glob over a collection's `.md`
  to `[{ slug, frontmatter, Body }]` in file-name order (code unit, as
  ksite's sites are named). The glob stays a literal in the block, because
  Sierra's prerender expands one only in a `.mesa` or `.md` it compiles; a
  glob here would reach neither it nor a pre-bundled dependency.
- `src/tel.js` — `telHref(phone)`, exported as `@frontierjs/site-kit/tel`:
  the one owner of a number as an E.164 `tel:` href, used by the prose pass
  and by a preset's blocks that link `company_phone`. The check's
  `tel-format` rule flags any other spelling on every page.
- `src/block-look.js` — the one owner of what a look word may be and where its
  class lands, imported by both `Block.mesa` and `config/dividers.js`.
- `config/shell.js` — `siteShell({ html, entry })`, the kit's own pair or a
  preset's `shell`. Serves `index.html` for a site whose root has none: a dev
  middleware for HTML requests, and a `load` of the root's `index.html` id in the
  build, so it emits as `dist/index.html`, the file the prerender reads. Also
  resolves `virtual:site-kit/styles` to the site's `content/settings/site.css`
  (empty without one); the entry imports it after `@frontierjs/css`, so it
  reaches every prerendered page as a main-build stylesheet.
- `index.html`, `src/main.js` — the dev shell and the dev entry. The entry is
  `/@site-kit/main.js`: a package name in a script `src` 404s in dev, and an
  inline module script needs an `index.html` on disk.
- `src/layouts/Block.mesa` — what `layout: Block` names (FJS-D654), exported
  as `@frontierjs/site-kit/layouts/Block.mesa`. The element follows position:
  a Band with a `.container` at the top, an `<article>` nested (inside another
  Block, known through `$context`, or stated `nested`), an `<a>` with
  a `url`, the stated `tag` otherwise. Six typed keys, each checked against
  `@frontierjs/css/vocabulary.json` at render, so the list of good values is
  css's, never a copy (FJS-D823); `classes:` is refused. A consumer that runs
  without css's reset must clip `overflow-x` on the root, because a Band is
  `100vw` and a classic scrollbar makes that wider than the page.
- `src/blocks/` — content blocks, one `.mesa` each, exported as
  `@frontierjs/site-kit/blocks/<Name>.mesa`.
  - `Marquee.mesa` — a row sliding sideways forever, CSS only so a static page
    needs no script. The slot renders twice; the second copy is `aria-hidden`.
- `test/blocks.mjs` — every block and layout compiles to parseable JS, plus
  each one's render assertions. Renders pass `tmpDir: test/`, because Mesa
  otherwise writes its temp module inside mesa's own package, where
  `@frontierjs/css` does not resolve.
- `test/preset.mjs` — a named preset is loaded, or `siteKit()` refuses by name;
  dev serves its `public/` and steps aside for the site's.
- `test/content.mjs` — `collection()`, the settings module and its refusals.
  `test/content-build.mjs` is a real `site-kit build` that binds a setting
  bare, lists a collection and reads a nested menu, through the prerender,
  and ships a preset's `public/` beneath the site's, and serves
  `content/settings/_redirects` beside a route's `redirect:` through serveSite.
- `test/dialect.mjs` — the dialect through Mesa's `compileMd`, and the check
  called by hand. `test/words-build.mjs` runs `site-kit build` on a site it
  writes under `test/`, which is the only proof Sierra calls the check.
- `test/check.mjs` — a site written and built under `test/`: each kit group
  fires on the defect planted for it, a preset rule runs with the settings
  and flags, one replaces `headings` by id, a throwing one is `check-crashed`,
  the command exits 1 and `--json` parses. `bun`, for `Bun.YAML`.
- `test/images.mjs` — the image step over a `dist/` it draws, with the real
  `Bun.Image`, so `bun test/images.mjs` and never `node`.
- `test/fetch.mjs` — `site-kit fetch` against a site it serves: a sitemap
  index, the image swap and download, `--prefix`/`--strip`, and a bad config
  refused.

## Proving a change

`bun run test` here for the blocks, then `website/`'s own `bun run test` — the build and the verify drive over the site
that consumes it. A change to the preset seam is proved by ksite as well:
`bun run build` in `fjs-prototypes/ksite`, graded with
`baseline/playwright.port.config.ts`. Those baselines use Playwright's
default color threshold, which passes a page whose light stripe went white,
so a change to what a block emits also needs an exact pixel diff of the
build before against the build after. A linked workspace never puts a file
under `node_modules/`, so a defect that only a published engine has
(`FJS-1552`, `FJS-2842`) shows only from a registry install:
`bun run proof:upgrade` in `fjs-prototypes/ksite` publishes site-kit, ksite
and the four framework peers to a local registry, builds each client from
`content/` alone, then proves a bump reaches it (`FJS-D988`). Moving this
package breaks every `link:` consumer until `bun link` is run here again.
