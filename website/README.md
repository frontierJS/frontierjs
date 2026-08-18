# FrontierJS Website

`website/` — the public site for FrontierJS. One page, no build step, no framework.

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

## Sections (single page, nav scrolls to each)

| Anchor      | Section  | Job                                                                     |
| ----------- | -------- | ----------------------------------------------------------------------- |
| `#top`      | Hero     | The one-sentence claim, the schema, and two buttons                     |
| `#idea`     | The idea | One seed, three realms — the mental model, stated once                  |
| `#code`     | See it   | Schema → Service → Resource side by side. The page's center of gravity  |
| `#packages` | Packages | The honest map, with maturity stated per package                        |
| `#extend`   | Extend   | The four extension concepts — Declaration, Hook, Plugin, Provider       |
| `#vision`   | Vision   | Slices, offline-first, one target axis                                  |
| `#start`    | Start    | Install, run an example, read next                                      |

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

**Local vs deploy path.** `index.html` links `../packages/css/index.css` so the
file renders correctly when opened straight from the repo, and so authoring always
happens against the real stylesheet rather than a stale copy. `bun run build`
vendors the package into `dist/css/` and rewrites that href on the way out — the
source file is never modified.

## Commands

```sh
bun run dev       # serve the source at :3400, styled by the live packages/css
bun run build     # produce dist/ — vendored CSS + rewritten href
bun run preview   # serve dist/ exactly as it deploys
bun run clean     # rm -rf dist
```

`dev` serves the page at `/` and maps `/packages/css/*` straight to the package
directory, so editing a token in `packages/css` and reloading shows the change.
There is deliberately no bundler: the site is one HTML file and the design system
is plain CSS with no build step, so "building" means vendoring and one href
rewrite. Anything more would be a build step this project does not need.

`preview` has no such mapping — a broken vendor step shows up as an unstyled page
there rather than in production. `build` also fails loudly if the expected href is
missing, since a missing stylesheet is not a browser error, just an unstyled page.

Deploy target is any static host: `bun run build`, publish `dist/`.

`website/` is not in the root workspace globs (`packages/*`), so it is not picked
up by the root `bun run build`. Add `"website"` to the root `workspaces` array if
you want it built with everything else.

## Before publishing

**The install commands now resolve.** Every publishable package is on npm, so
the `npm install` the page shows no longer 404s — which was the one hard blocker
on putting this in front of anyone. The root README's
[Publishing status](../README.md#publishing-status) is the list; do not restate
it here, and do not put a version number on this page. A number written into
marketing copy is a second origin that nothing regenerates, and this file is
where the last one rotted for months.

Two things still to check on the way out, both of them the kind that go stale
without rendering wrong:

- **The package maturity notes in the table are a snapshot.** Re-verify against
  the root `CLAUDE.md` — per `VERIFYING.md`, status claims go stale fastest, and
  a table claiming a package is further along than it is burns the trust this
  page exists to earn.
- **The install command should pin, not float.** Below 1.0 a caret pins the
  minor, and `latest` on an alpha framework hands a visitor whatever landed this
  morning.

## Later

- Docs subdomain; this page links out rather than growing.
- **Playground** — Litestone over SQLite WASM in the browser, so the hero's schema
  box becomes editable and shows the derived API live. Highest-value addition by
  some distance, and the offline-first direction
  (`IDEAS/offline-first-and-release.md`) makes it structurally cheap: the same
  engine already runs on both sides.
- A slice registry, once `IDEAS/slices.md` is real.
