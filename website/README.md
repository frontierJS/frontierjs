# FrontierJS Website

`website/` — the public site for FrontierJS.

**It is a Sierra `site/` surface**: `website/` is the app root, `website/site/`
is the surface, and `bun run build` prerenders one HTML file per route into
`site/dist/`. The twenty-one hand-written HTML pages that used to be the site,
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
executes. `site/test/verify.mjs` asserts two of those strings survive into the
built page (`tutor.transcripts`), because a sample rewritten into nicer prose
looks identical from every other angle.

It carries no `publishes:` line and should not gain one: it reads no data, so
there is nothing for the build's publish check to fail closed on, and
`publishes: 0` would silence a proof rather than raise a bar (`fli check`'s
`static-publishes-0`).

## Principles for anything added here

- **Show, don't claim.** Every assertion should be backed by code the reader can
  see or run. `VERIFYING.md` applies to marketing too.
- **State maturity honestly.** The packages table names what is solid and what is
  not. A framework that overstates readiness burns the trust it most needs.
- **No feature the repo does not have.** Aspirations belong under Vision, clearly
  labelled as direction rather than fact.
- **The code samples are the product.** If a sample needs a paragraph of
  explanation, the API is wrong — fix the API, not the paragraph.

## Design system

The site imports **`@frontierjs/css`**, the project's own design system. This is
deliberate: as of 2026-08-02 that package had no consumer inside the framework, and
a design system without a consumer drifts. Its own `demo/` app found 8 shipped bugs
and 4 core gaps on first contact; this site is the second consumer and should be
expected to find more.

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
bun run dev       # vite dev on :8690 — the routes, client-routed
bun run build     # prerender site/dist/ — one HTML file per route
bun run preview   # serve site/dist/ on :8790, as it deploys
bun run verify    # the drive: the files, then a real browser
bun run clean     # rm -rf site/dist
```

## Code samples

Every sample on the site is **source** in a `.meta.js` companion, highlighted at
build time by `@frontierjs/toolbelt/glow` and themed by `@frontierjs/css`. No
page ships a highlighter and no page owns a code palette.

That is a change from how the site was written. Thirteen pages marked their
samples up **by hand** — a `<b>` around every keyword, an `<em>` around every
string — and four more carried a copy of the same regex with a slightly
different keyword list, which is how three of them ended up not colouring
`interface`. So on the page whose own principle is *the code samples are the
product*, the code was HTML: copying a sample out of the source gave you tags.

glow marks a token with the ELEMENT that means it (`<strong>` keyword, `<em>`
value, `<sup>` comment) and puts the language on the wrapper, so `code.css`
themes it with element selectors and the samples retint with the theme switcher
— clamped into the tone-as-text window, which is why code stays legible in the
dark themes. `site/src/data/code.js` is the whole of the site's side: `block()`,
`line()` for the pages that light one line at a time, and a sniffer for the
samples that come out of `packages.js` and cannot carry a language of their own.

`site/test/verify.mjs` asserts the round trip — every sample's text is compared
against `test/fixtures/samples.json`, lifted from the hand-written pages at the
commit that deleted them, because a highlighter's one catastrophic failure is
silent: it eats a character, the block still looks like code, and the reader
copies a sample that does not work. The fixture is deliberately not
regenerated; the point is that those 66 strings never move again.

Doing it found four gaps in glow, all in `FJS-515`: it could not highlight
`.lite`, SQL or shell, and could not highlight a transcript at all.

## What the port bought

Thirteen hand-written pages each carried a copy of the topbar, the footer and
the same 429-byte theme script; eight package pages were 25-line shells that a
classic script filled in on load, and every demo page built its whole content
from JavaScript. So the site a crawler read was mostly empty divs.

Now there is one layout, one theme switcher, and **every page's content is in
its file** — 73 feature rows on the stack page, 15 walkthrough steps, 18 request
seams, 21 landscape projects. The interactive parts are nine islands that move
selections rather than build pages. `site/test/verify.mjs` asserts both halves:
what is in the files, and that each widget still works in a real browser.

Five framework defects came out of doing it — `FJS-500`, `FJS-501`, `FJS-508`,
`FJS-509` and `FJS-515` in the root `ISSUES.md`. The first is the one worth
reading: a prerendered page did not escape its own text.

Deploy target is any static host: `bun run build`, publish `site/dist/`.
The build writes `sitemap.xml`, `robots.txt` and a pre-paint theme script into
every page.

`website` is a root workspace member, so `bun run --filter '*' test` reaches it —
its `test` script is the build, which is the whole of what a static site can be
wrong about at the level a suite can see. The browser drive is `verify` and
needs Chrome.

## Before publishing

**The install commands are checked against npm on every drive.**
`install.published` reads every `npm i @frontierjs/…` out of the built pages and
asks the registry. It found two that could never have worked: `@frontierjs/basecamp`,
which is `private` and never publishes because it is an application rather than a
library, and a marketplace install for an extension with no publisher account.
Both now say what you actually do. No network is a named skip;
`FJS_REQUIRE_REGISTRY=1` makes it fatal.

Do not write a version number on this page. The root README's
[Publishing status](../README.md#publishing-status) is the list, and a number in
marketing copy is a second origin nothing regenerates — this file is where the
last one rotted for months.

Two things still to check on the way out, both of them the kind that go stale
without rendering wrong:

- **The package maturity notes in the table are a snapshot.** Re-verify against
  the root `CLAUDE.md` — per `VERIFYING.md`, status claims go stale fastest, and
  a table claiming a package is further along than it is burns the trust this
  page exists to earn. Nothing checks this and nothing can: it is a judgement.
- **The install command should pin, not float.** Below 1.0 a caret pins the
  minor, and `latest` on an alpha framework hands a visitor whatever landed this
  morning. The drive proves the package EXISTS, not that the range is sane.
- **Three pages are reachable only by URL** — `/index2/`, `/index3/` (earlier
  drafts of the home page) and `/before-after/`, which is real content and the
  only one worth a nav entry. They were unlinked before the port too; the
  question is editorial, not technical.

## Later

- Docs subdomain; this page links out rather than growing.
- **Playground** — Litestone over SQLite WASM in the browser, so the hero's schema
  box becomes editable and shows the derived API live. Highest-value addition by
  some distance, and the offline-first direction
  (`IDEAS/offline-first-and-release.md`) makes it structurally cheap: the same
  engine already runs on both sides.
- A slice registry, once `IDEAS/slices.md` is real.
