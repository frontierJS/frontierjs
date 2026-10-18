---
id: site-hosting
status: proposed
dated: 2026-10-12
---

# Idea — a site is files, and a host is an adapter

**Status: PROPOSED. Steps 1–5 of § The plan are built, each saying what it leaves.** Do not cite this file as
describing behavior — see `VERIFYING.md`.

Cloudflare Pages is deprecated in favor of Workers. The move is the moment to
state what a site owes a host at all: a static site is built, served and proved
without Cloudflare, and Cloudflare is used at the end for DNS and for serving
at the edge. A second host is then a second adapter, not a port.

## What the tree already does

Read 2026-10-12.

- **frontierjs.com is off Pages already.** `website/wrangler.jsonc` is an
  assets-only Worker: no script, `site/dist` served as it is. Three of its keys
  restate Sierra facts by hand — `html_handling: force-trailing-slash` is
  `trailingSlash: 'always'`, `not_found_handling: 404-page` is the `404.html`
  that `postbuild/move-404.js` writes, and `directory` is the outDir.
- **Sierra already writes the host's files in the host's format.**
  `postbuild/redirects.js` emits `_redirects` (the Netlify format Cloudflare
  reads) from the route table, and a redirect route emits no page, so that
  line is its only answer. It merges the app's own file after those rules,
  which for a site-kit site is `content/settings/_redirects` (`FJS-D961`).
- **The proof is already host-neutral.** `website/tests/verify.mjs` serves
  `dist/` with Sierra's `serveSite`, never with wrangler, and so does the
  `site/deploy/` container.
- **`serveSite` answers `_redirects` as the host does** and never serves it or
  `_headers` ([`FJS-2717`](../ISSUES.md#fjs-2717), closed). It answers the
  exact-path rules Sierra emits and refuses any other shape at start.
- **The cache rule lives only in `serveSite`'s `cacheFor`.** Nothing tells a
  host that HTML revalidates and a hashed asset is immutable. (Step 2 since.)
- **Host functions are what still holds ksite on Pages**
  ([`FJS-1540`](../ISSUES.md#fjs-1540)): a same-origin Plausible proxy and a
  `sendBeacon` lead fallback written to Cloudflare KV.

## The shape — four layers, and only one knows Cloudflare

| Layer | Holds | Owner |
| --- | --- | --- |
| Build | `dist/` with `_redirects`, `_headers`, `404.html`, and the host functions bundled to one entry | Sierra's build and postbuild |
| Site defaults | what every static site wants, preset rather than written per site | site-kit, as a pass-through over Sierra |
| Adapter | `dist/` and the function entry → what one host runs | Sierra; the Cloudflare adapter is the only code naming Cloudflare |
| Control plane | DNS, deploy records, preview hostnames, owner editing | `packages/basecamp`, whose edge connector already writes Cloudflare DNS (`cloudflare-edge.md`) |

**A host function is a web-standard handler.** `export default (request, env)
=> Response`, the signature Workers, Bun, Deno and Netlify all run. A file
under the functions directory answers its own path, the Pages convention, so
ksite's `functions/api/event.js` keeps its URL. **`env` carries strings
only**: the Cloudflare adapter drops every binding before calling a function,
so KV, D1 and Durable Objects are unreachable from site code by
construction. The lead fallback posts to an FJS API rather than to KV.

**The Bun adapter is what keeps the exit real.** `serveSite` mounts the same
function entry before its static answers, so every drive runs the site the
way a non-Cloudflare host would. A site that passes its drives under `serveSite`
and fails on Cloudflare is an adapter defect, never a site defect. Sierra's
Vite dev mounts the same entry, or else a page that posts to a function
(ksite's lead loader) fails only in dev. This is the same gap as `document`,
which dev does not apply either (`site-kit-plan.md` Phase 3 step 5).

### site-kit's pass-through

Sierra owns the mechanism. site-kit presets it for a markdown site, layered
the way `config/vite.js` already layers config — site-kit's keys, then the
preset's, then the site's — so a site writes nothing a static site always
wants:

- the functions directory is `content/functions`, beside `content/routes`;
- `trailingSlash: 'always'` and the `404.html` page, which the adapter turns
  into Cloudflare's two `assets` keys rather than a site stating them;
- `_headers` emitted from `cacheFor`, the one cache rule, which `serveSite`
  keeps applying directly;
- the Plausible proxy switched on. Sierra derives the proxy from
  `analytics:`, because `analytics/tag.js` already owns Plausible's URLs
  (`apiHost`), and the tag has to point at the path the proxy answers. If
  site-kit wrote the proxy, two owners would hold one URL;
- a preset contributes functions the way it contributes `plugins`, which is
  where ksite's lead fallback goes;
- `site-kit deploy <dir>` builds, runs the Cloudflare adapter, and calls
  wrangler — the site states only what cannot be derived (question 4).

## Preview and editing — three things with three homes

| Thing | Who | Lives where |
| --- | --- | --- |
| The ask panel: alt-click to source, a Claude edit, Undo | a developer | the local Vite dev server (`on-page-editing.md`, built) |
| Anchored review: pins and threads on a preview | a client or teammate | a `site-kit build --preview` (`FJS-D838`) deployed by the same adapter to a preview hostname; its store is `FJS-D839`'s V2 question (`anchored-feedback.md`) |
| Owner editing: the site's owner changes their own content | a site owner | an FJS app — question 3 |

**Owner editing keeps the site static.** Content's source of truth stays git
(`content/`); the editor writes it, publish is a commit, the commit builds,
and the build goes out through the adapter. Nothing editable runs at the edge.
**The live preview can render in the browser** for a markdown route, because
Mesa's `compileMd` runs there (`owner-editing.md` 0.2 measured 18–30 ms per
compile in Chrome, with a 187 KB gzipped bundle). A `.mesa` route also needs
every module it imports, as a module the page can load, which today only a
Vite dev server provides. A hosted Vite dev server per site is the heavier answer and buys only
the ask panel, which is a developer's tool.

*Basecamp* in `anchored-feedback.md`'s option B is the Basecamp product, where
Kobami's client feedback goes. `packages/basecamp` is the fleet app, and is a
candidate host for that file's option A.

## Open questions

1. ~~**Where a host function lives, and what it is**~~ **Answered 2026-10-12 (`FJS-D919`): A — a file under a functions directory, answering its own path as on Pages; `export default (request, env) => Response`; `env` strings only; Sierra bundles the directory to one entry every adapter mounts.** (`FJS-1540`).
   - **A** — a file under a functions directory, answering its own path as on
     Pages; `export default (request, env) => Response`; `env` strings only;
     Sierra bundles the directory to one entry every adapter mounts.
   - **B** — no host functions: anything dynamic is a route on an FJS `api/`,
     which puts a running server behind every marketing site.
   - **C** — functions named in settings as module paths, which separates the
     URL from the file that answers it.
   - **Recommend A** — the web's own signature means no adapter rewrites a
     function, the Pages path convention moves ksite's functions with their
     URLs, and dropping bindings from `env` is the line that keeps site code
     off Cloudflare.
2. ~~**Who owns the host files and the adapters.**~~ **Answered 2026-10-12 (`FJS-D920`): A — Sierra owns `_redirects`, `_headers`, the function bundle and each adapter; site-kit is a pass-through that presets the static-site defaults, layered site-kit, then preset, then site, as `config/vite.js` does.**
   - **A** — Sierra owns `_redirects`, `_headers`, the function bundle and each
     adapter; site-kit is a pass-through that presets the static-site defaults,
     layered site-kit, then preset, then site, as `config/vite.js` does.
   - **B** — site-kit owns all of it and Sierra stays unaware of hosts.
   - **C** — `fli` owns the adapters, as a deploy concern, and Sierra the files.
   - **Recommend A** — Sierra already writes `_redirects` and `404.html` and
     already owns `serveSite`, so the adapter sits beside the files it reads.
     A Sierra `site/` surface in an app gets the same adapter without site-kit.
     The pass-through is what makes a markdown site state nothing, and it is the
     layering site-kit already does for Vite.
3. ~~**Where owner editing and preview deploys live.**~~ **Answered 2026-10-12 (`FJS-D921`): A — a module of `packages/basecamp`, the app that already holds the Cloudflare account, the DNS writes and the release record.**
   - **A** — a module of `packages/basecamp`, the app that already holds the
     Cloudflare account, the DNS writes and the release record.
   - **B** — a new FJS app for site editing alone.
   - **C** — inside each site: an admin route and a host function that writes
     to git.
   - **Recommend A** — the credentials, the DNS and the deploy record are
     already there, and C puts auth and writes on the edge, which this file
     exists to keep dumb.
4. ~~**Does a site state anything a deploy cannot derive?**~~ **Answered 2026-10-18 (`FJS-D1213`): A — nothing: the Worker's name is `siteUrl`'s host with dots as dashes (`frontierjs.com` → `frontierjs-com`), the adapter writes `.sierra/wrangler.json`, `website/wrangler.jsonc` is deleted, and a deploy with no `siteUrl`, or whose host makes a name past Cloudflare's 63 characters, is refused by name rather than truncated.** Every key of
   `website/wrangler.jsonc` has a source but one: `assets.*` from
   `trailingSlash`, `404.html` and the outDir; `routes` from the host in
   `siteUrl`; `compatibility_date` an adapter constant; the account the
   deployer's environment; the www redirect a zone rule. Only `name` has none.
   - **A** — nothing: the Worker's name is `siteUrl`'s host with dots as dashes
     (`frontierjs.com` → `frontierjs-com`), the adapter writes
     `.sierra/wrangler.json`, `website/wrangler.jsonc` is deleted, and a deploy
     with no `siteUrl`, or whose host makes a name past Cloudflare's 63
     characters, is refused by name rather than truncated.
   - **B** — A, plus an optional `host: { name }` in `site.js` for a name that
     must differ.
   - **C** — `packages/basecamp`'s App row names it, as Vercel and Netlify keep
     a linked id, and the deploy asks basecamp.
   - **D** — `host: { name, domain }` in `site.js`, as first asked.
   - **Recommend A** — a site-kit site has exactly one `siteUrl`, so the name
     derived from it is unique per site and the site writes no key. B is an
     option no site needs, since keeping the name `frontierjs-site` is
     preservation. C makes a deploy depend on basecamp being up. D states the
     domain twice. The cost is that a domain change deploys a new Worker
     rather than renaming the old one. Deriving the name from the domain has no
     precedent found: Cloudflare's own adapters (SvelteKit, Astro, OpenNext)
     have the user write `name`, and Vercel and Netlify keep the id in a
     linked state file.

## The plan

Each step adds its case to the website's `verify` drive before it is done.

1. ~~**`serveSite` honors `_redirects`** and refuses to serve `_redirects` and
   `_headers` (`FJS-2717`).~~ Done. The website has no redirect route, so the
   case is `packages/sierra/test/site-serve.test.js`.
2. ~~**`_headers` from `cacheFor`.**~~ Done: `postbuild/headers.js` owns
   `cacheFor` and writes `/*` revalidated, `/assets/*` immutable, and an exact
   rule per unhashed file under `assets/`, every rule after the first
   detaching first, because Cloudflare applies every match and joins two
   values with a comma. Static builds only, the app's own `_headers` after.
   Proved by `test/site-serve.test.js` and the website drive's `host.headers`,
   which ask every file of both `serveSite` and `headerUnder`, and by hand
   under `wrangler dev` on the website's build. Left: the first real deploy
   confirms it on Cloudflare's edge. `serveSite` sends only the cache rule,
   so an app's own `_headers` lines are not applied in a drive.
3. ~~**Host functions** (question 1): bundled to one entry, mounted by
   `serveSite`; ksite's two move. Closes `FJS-1540`.~~ Done for the entry and
   the mount (`functions:` config key, `.sierra/functions.js`,
   `test/site-functions.test.js`). The Vite dev mount and the compiled-binary
   mount are done (`FJS-2775`). Left: the Plausible proxy derived from
   `analytics:` (`FJS-2893`), and the bundling the adapter does in step 4.
4. ~~**The Cloudflare adapter**: the Worker entry (functions first, then
   `env.ASSETS.fetch`) and the generated wrangler config; `site-kit deploy`.~~
   Done for frontierjs.com: `site/cloudflare.js` writes `.sierra/wrangler.json`
   and, with functions, `.sierra/worker.js`, whose handler is
   `postbuild/function-handler.js` (no `node:` import, so wrangler bundles it
   without `nodejs_compat`). `run_worker_first` lists the function paths only,
   so a page never wakes the script and a function still beats a page at its
   path. `site-kit deploy <dir> [--dry]` ships the dist the last build wrote,
   not a rebuild, so `bun run deploy` ships what the drive passed.
   `website/wrangler.jsonc` is deleted (question 4). Proved by
   `test/site-functions.test.js`, the website drive's `host.worker`, and by
   hand under `wrangler dev`. Left: ksite leaves Pages, which waits on its
   Plausible proxy (`FJS-2893`). The first real deploy of frontierjs.com
   creates the Worker `frontierjs-com`, so frontierjs.com's custom domain
   moves off `frontierjs-site`, which is then deleted by hand.
5. ~~**Preview deploys** of `site-kit build --preview` through the same adapter.~~
   Done: Sierra's `preview: true` (static only) stamps `data-fjs-loc` in the
   build and the prerender, relative to the root, and adds `X-Robots-Tag:
   noindex` to `/*` in `_headers`. `site-kit deploy --preview [name]` uploads
   that dist as a version of the same Worker, aliased by the git branch or the
   name (`FJS-D1221`, `FJS-D1222`). The adapter reads which kind a dist is
   from its pages, so a deploy refuses a stamped one and a preview refuses an
   unstamped one. The derived config gains `preview_urls: true`.
   `site-kit preview` is now `site-kit serve` (`FJS-D1223`). Proved by
   `test/site-functions.test.js`, `test/site-serve.test.js`, a preview build
   of the website under `wrangler dev` (`noindex` on every path, the cache
   rule unchanged), and `--dry` both ways. Left: no upload has run. The first
   needs the Worker, so it waits for step 4's first real deploy. A dashboard
   *Deploy version* on a preview still ships it. A file outside the site root,
   such as a linked site-kit's own block, stamps an absolute path, the rule
   Mesa applies in dev too. Basecamp's record of previews (`FJS-D921`) is not
   built.
6. ~~**Owner editing** gets its own idea file.~~ Done: `owner-editing.md`,
   whose six questions are ruled (`FJS-D1225`–`FJS-D1230`).

## The nine (`decision-rules`, answered before any edit)

1. **Origin** — removes copies: wrangler's three hand-written keys become
   derived, `cacheFor` stays the one cache rule with `_headers` its emission,
   and the route table stays the one origin of a redirect.
2. **Concept** — no new noun. *Host function* is `FJS-1540`'s phrase;
   *adapter* is the word SvelteKit and Astro use for this exact role, and
   `packages/basecamp/docs/ADAPTERS.md` already uses it.
3. **Complexity** — the problem's: every static framework that deploys to
   more than one host grew adapters, and Pages' `functions/` is the prior art.
4. **Predictability** — one `dist/` and one function entry under every host;
   a function sees the same `env` shape under Bun and under Workers.
5. **Derived** — the wrangler `assets` keys from `trailingSlash`, `404.html` and
   the outDir; the Plausible proxy from `analytics:`; `_headers` from `cacheFor`.
6. **Owner** — Sierra's postbuild owns `_redirects` and `404.html`, `serveSite`
   owns local serving, `config/vite.js` owns site-kit's layering, basecamp's
   edge connector owns DNS. Each step adds to one of them.
7. **Boundary** — a function's signature is the web's `Request` and
   `Response`; `env` is strings; an adapter is a function from `dist/`, the
   function entry and settings to what a host runs.
8. **Failure** — a function importing `cloudflare:` is refused at bundle time
   by name, since it would pass every drive and fail only on the other host. A
   binding absent from `env` reads `undefined`, as a missing variable does on
   any host.
9. **Silence** — *stays true:* what a drive serves is what a host serves.
   *What fails:* the verify drive's redirect case (step 1) and function case
   (step 3). That Cloudflare applies the same files is `none` — no drive
   deploys to Cloudflare — until a post-deploy check exists.

Adjudications: *batteries vs. smallness* (site-kit is the severable battery;
the adapter is Sierra's, with one seam per host) and *familiarity vs.
precision* (Pages' function paths and the `_redirects` format are taken as the
ecosystem has them). Tier: Assessment (`IDEAS/`).
