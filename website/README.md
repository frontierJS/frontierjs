# FrontierJS Website

`website/` — the public site for FrontierJS.

**It is a Sierra `site/` surface run by `@frontierjs/site-kit`**: `website/`
is the app root, and `website/site/` holds `content/` and nothing else — the
routes, islands, components, data, `public/` and `settings/site.js`. The shell,
the dev entry and the build are site-kit's, so `bun run build` is `site-kit
build site`, prerendering one HTML file per route into `site/dist/`. The twenty-one hand-written HTML pages that used to be the site,
and the `build.js` that vendored a stylesheet for them, are gone — every page
has a ported equivalent.

Two files stay at the app root because they are DATA the surface reads at build
time, not pages: `packages.js`, the one place a package's features are written
down, and `projects.json`, the landscape.

---

## What this site is for

FrontierJS is not short of documentation — `ARCHITECT.md`, `PHILOSOPHY.md`,
`DECISIONS.md`, a README per package. What it has never had is **one page that
makes someone want to read any of them.**

That is this site's primary job: take a person from "never heard of it" to
"I understand the idea and I want to try it" in a single scroll.

Explicit non-goals: it is not the docs, not an API reference, and not a changelog.
Those live in the repo and, later, on a docs subdomain. Every section should end by
handing off to something deeper rather than trying to be it.

## Routes that matter

- `/` — the splash: what is coming, and two doors out. It is one screen and
  hands off rather than arguing.
- `/journey/` — the build-in-the-open journal. **A post is a file**:
  `site/content/routes/journey/<slug>.mesa` with `title`, `description` and `date`
  in its frontmatter, rendered inside `site/content/components/JourneyPost.mesa`.
  The index reads every sibling's frontmatter (`site/content/data/journey.js`), so
  publishing is adding the file; no `date` means a draft, built but unlisted.
- `/pitch/` — the long-form page below, every anchor (`/pitch/#start`) included.
- `/seams/` — one request, every seam it crosses.
- `/splash-tune/` — live controls for the map tour behind the splash and the
  three cloud decks over it, run against the real splash in a frame. Unlisted
  (`robots: noindex`). Tuning ends with *Copy*, pasted over the tour variables
  in `site/content/routes/index.mesa`. The decks are `site/content/public/map/clouds-*.webp`,
  one horizontally-wrapping tile each, cut from a painted cloud sheet; a tile
  that does not wrap shows as a hard edge sliding across the splash.

## The pitch, in the order a stranger needs it

1. **What is it** — a schema-seeded fullstack framework. One `.lite` file seeds
   Data, API, and UI.
2. **Why care** — you write a schema and a six-line service, and get CRUD,
   validation, authorization, pagination, and live updates without writing them.
3. **The differentiator** — other frameworks help you write the glue. FJS derives
   glue you never write. And authorization lives on the Model, so it travels with
   the data instead of being re-implemented in every handler.
4. **Proof** — real code, not prose. Three panels: schema → service → UI.
5. **The map** — the packages, what each is, how mature each is.
6. **The direction** — offline-first, portable, self-hostable, FOSS.
7. **Start** — install, run, and where to read next.

| Anchor      | Section  | Job                                                                     |
| ----------- | -------- | ----------------------------------------------------------------------- |
| `#top`      | Hero     | The one-sentence claim, the schema, and two buttons                     |
| `#idea`     | The idea | One seed, three realms — the mental model, stated once                  |
| `#code`     | See it   | Schema → Service → Resource side by side. The page's center of gravity  |
| `#packages` | Packages | The honest map, with maturity stated per package                        |
| `#extend`   | Extend   | The four extension concepts — Declaration, Hook, Plugin, Provider       |
| `#vision`   | Vision   | Slices, offline-first, one target axis                                  |
| `#start`    | Start    | Install, run an example, read next                                      |

## The tutorial page

`/tutor/` is the one page here that sells a COMMAND rather than the framework,
and it is held to a stricter version of *show, don't claim*: every sample on it
is a transcript of a real run or a verbatim lift from the step that produced it.
A paraphrase of `fli tutor`'s output would be the one thing on this site that has
never been executed — on the page whose whole argument is that the tutorial
executes. `tests/verify.mjs` asserts two of those strings survive into the
built page (`tutor.transcripts`), because a sample rewritten into nicer prose
looks identical from every other angle.

It carries no `publishes:` line and should not gain one: it reads no data, so
there is nothing for the build's publish check to grade.

## Principles for anything added here

- **Show, don't claim.** Every assertion should be backed by code the reader can
  see or run. `VERIFYING.md` applies to marketing too.
- **State maturity honestly.** The packages table names what is solid and what is
  not. A framework that overstates readiness burns the trust it most needs.
- **No feature the repo does not have.** Aspirations belong under Vision, clearly
  labeled as direction rather than fact.
- **The code samples are the product.** If a sample needs a paragraph of
  explanation, the API is wrong — fix the API, not the paragraph.

## Design system

The site imports **`@frontierjs/css`**, the project's own design system. This is
deliberate: a design system without a consumer drifts, and this site is the second
one it has — the first, its own `demo/` app, found shipped bugs and core gaps on
first contact, and this should be expected to find more.

Uses only shipped classes: `.container` `.stack` `.cluster` `.split` `.card`
`.btn` `.badge` `.pill` `.table` `.tiles`/`.tile` `.bar` `.navlink` `.h` `.code`
`.text-*` and the tone vocabulary (`.primary` `.muted` `.success` …). The theme
switcher cycles six of them (`default` `sunset` `forest` `midnight` `dark`
`elite`) — it doubles as a live demo of the design system. The package ships
**ten**; `basecamp`, `notebook`, `press` and `field` are the four this page does
not offer, and `press` is the interesting omission — it is the token-surface
probe, so a page that renders correctly under it is a page making no assumption
the token vocabulary cannot carry.

**Local vs deploy path.** The surface imports `@frontierjs/css` as a package and
Vite emits one stylesheet, so there is no href to rewrite and no vendoring step.
That is what `build.js` used to exist for: the hand-written pages linked
`../packages/css/src/index.css` by relative path, which resolves in the repo and
nowhere else, so every deploy had to copy the file and rewrite twenty-one hrefs.

## Commands

```sh
bun run dev       # site-kit dev on :8690 — the routes, client-routed
bun run build     # prerender site/dist/ — one HTML file per route
bun run preview   # serve site/dist/ on :8790, as it deploys
bun run verify    # the drive: the files, then a real browser; exits 1 on a failure
bun run test      # build, then verify — what CI runs
bun run clean     # rm -rf site/dist
```

## Code samples

Every sample on the site is **source** in a `.meta.js` companion, highlighted at
build time by `@frontierjs/toolbelt/glow` and themed by `@frontierjs/css`. No
page ships a highlighter and no page owns a code palette.

That is a change from how the site was written. Thirteen pages marked their
samples up **by hand** — a `<b>` around every keyword, an `<em>` around every
string — and four more carried a copy of the same regex with a slightly
different keyword list, which is how three of them ended up not coloring
`interface`. So on the page whose own principle is *the code samples are the
product*, the code was HTML: copying a sample out of the source gave you tags.

glow marks a token with the ELEMENT that means it (`<strong>` keyword, `<em>`
value, `<sup>` comment) and puts the language on the wrapper, so `code.css`
themes it with element selectors and the samples retint with the theme switcher
— clamped into the tone-as-text window, which is why code stays legible in the
dark themes. `site/content/data/code.js` is the whole of the site's side: `block()`,
`line()` for the pages that light one line at a time, and a sniffer for the
samples that come out of `packages.js` and cannot carry a language of their own.

`tests/verify.mjs` asserts the round trip — every sample's text is compared
against `test/fixtures/samples.json`, lifted from the hand-written pages at the
commit that deleted them, because a highlighter's one catastrophic failure is
silent: it eats a character, the block still looks like code, and the reader
copies a sample that does not work. The fixture is deliberately not
regenerated; the point is that those strings never move again.

Doing it found four gaps in glow, all in `FJS-515`: it could not highlight
`.lite`, SQL or shell, and could not highlight a transcript at all.

## What the port bought

Thirteen hand-written pages each carried a copy of the topbar, the footer and
the same 429-byte theme script; eight package pages were 25-line shells that a
classic script filled in on load, and every demo page built its whole content
from JavaScript. So the site a crawler read was mostly empty divs.

Now there is one layout, one theme switcher, and **every page's content is in
its file**. The interactive parts are ten islands that move
selections rather than build pages. `tests/verify.mjs` asserts both halves:
what is in the files, and that each widget still works in a real browser.

Five framework defects came out of doing it — `FJS-500`, `FJS-501`, `FJS-508`,
`FJS-509` and `FJS-515` in the root `ISSUES.md`. The first is the one worth
reading: a prerendered page did not escape its own text.

**Deploy is `bun run deploy`** — the build and the drive, then `wrangler deploy`
of `site/dist/` as an assets-only Cloudflare Worker on frontierjs.com
(`wrangler.jsonc`). A failing drive stops it before the upload.
Wrangler signs in once with `wrangler login`, or reads `CLOUDFLARE_API_TOKEN`.
`www.frontierjs.com` is a redirect rule on the zone, not a second route. The
build writes `sitemap.xml` and `robots.txt` against `siteUrl` in
`site/content/settings/site.js`, and a pre-paint theme script into every page.

`packages/site-kit/` is `@frontierjs/site-kit`, the engine this site and later
ksite's client sites depend on — private and unlisted. It is a member through the root `website/packages/*` glob; see its `CLAUDE.md`.

`website` is a root workspace member, so `bun run --filter '*' test` and CI's
`tests` phase reach it. Its `test` script is the build followed by `verify`, the
browser drive, so it needs Chrome (`$FJS_CHROME`, which the CI workflow sets).
`verify` prints every check's value and exits 1 naming the ones that failed.

## Before publishing

**The install commands are checked against npm on every drive.**
`install.published` reads every `npm i @frontierjs/…` out of the built pages and
asks the registry. It found two that could never have worked: `@frontierjs/basecamp`,
which is `private` and never publishes because it is an application rather than a
library, and a marketplace install for an extension with no publisher account.
Both now say what you actually do. No network is a named skip;
`FJS_REQUIRE_REGISTRY=1` makes it fatal.

**The set of packages is checked too.** The build refuses a publishable
`@frontierjs/*` that no entry in `packages.js` describes — the hole is silent
otherwise: the build is green, the stack page looks complete, and the only
symptom is a visitor who never learns the thing exists. Fourteen of them sat
that way. Holding one back is a named entry with a reason in
`site/content/data/packages.js`, and a `private` package needs none, since its own
manifest already says so.

Do not write a version number on this page. The root README's
[Publishing status](../README.md#publishing-status) is the list, and a number in
marketing copy is a second origin nothing regenerates — this file is where the
last one rotted for months.

**The install commands pin.** An `npx` or `npm create` names the minor read
off that package's manifest at build time (`site/content/data/pin.js`), so the copy
carries no number and a visitor never runs whatever landed this morning.
`install.published` fails a range npm has no version in — a manifest bumped and
not yet published.

One thing still to check on the way out, the kind that goes stale without
rendering wrong:

- **The package maturity notes in the table are a snapshot.** Re-verify against
  the root `CLAUDE.md` — per `VERIFYING.md`, status claims go stale fastest, and
  a table claiming a package is further along than it is burns the trust this
  page exists to earn. Nothing checks this and nothing can: it is a judgement.

## Later

- Docs subdomain; this page links out rather than growing.
- **Playground** — Litestone over SQLite WASM in the browser, so the hero's schema
  box becomes editable and shows the derived API live. Highest-value addition by
  some distance, and the offline-first direction
  (`IDEAS/offline-first-and-release.md`) makes it structurally cheap: the same
  engine already runs on both sides.
- A slice registry, once `IDEAS/slices.md` is real.
