---
id: conversion-ksite
status: assessment
dated: 2026-09-09
---

# Assessment — Converting a Svelte/Routify static-site template onto Sierra

**Status: ASSESSMENT. It reads two trees and proposes nothing.** Dated
2026-09-09. Every count below was produced by running a command against
`/home/j/code/KOBAMI/SITES/ksite` or against this tree on that date, and each
command is given beside its number so a re-derive is a rerun rather than a second
audit. Nothing here may be cited as behavior of either system — see
`VERIFYING.md`.

## Scope, and what this file is not

Two records already own parts of this subject and this one restates neither.

- **The collection half is `content-collections.md`.** *A directory of markdown
  files is a validated, queryable set* is argued there, including the finding
  that Sierra's `.md` plumbing is built and used by nobody. Every collection row
  below points at it.
- **The styling half is `page-composition.md`.** That file already compares
  ksite's compositor vocabulary to `@frontierjs/css`'s component vocabulary and
  concludes the two cover each other's blank space.

What is left — and what this file is — is everything a conversion raises that
neither covers: the block library, the image pipeline, site-wide settings, the
markdown dialect, and the host.

## What ksite is

A template for content-driven marketing sites: pages authored in Markdown with
embedded Svelte components, prerendered to static HTML, deployed to Cloudflare
Pages. Svelte 5 + Routify 3 + Vite 6 + mdsvex + spank + UnoCSS + sharp.

`find <dir> -type f | wc -l` and `find <dir> -type f -exec cat {} + | wc -l`:

| Layer | Files | Lines |
| --- | --- | --- |
| `src/blocks` — the marketing block library | 75 | 5,852 |
| `src/components` | 25 | 3,439 |
| `src/scripts` — remark/rehype processors and build steps | 12 | 1,969 |
| `config` — vite, routify plugin, uno preset, svelte/mdsvex | 10 | 1,761 |
| `src/core` — runtime, JSON-LD, analytics, lead fallback | 11 | 1,741 |
| `src/themes` | 5 | 1,321 |
| **engine** | **138** | **~16,100** |
| `content/` — one built-out site | 121 | 4,724 |

The engine is copied forward into each client site; `content/` is the site. A
page is markdown with no import statements at all:

```md
---
title: Cleaning Service
---
<Hero />
<Trust />
<CallToAction />
```

## The headline

**The mechanism the template is built around is already native to Sierra, and it
was reached from the other end.** ksite's `remark-content-processor.js` resolves
`<CapitalizedComponent />` in a markdown body through four locations and writes
the import; Sierra's `auto-import-plugin.js` scans configured directories
recursively and injects the same import before the Mesa compiler runs, for
`.md` and `.mesa` alike.

Checked by compiling rather than by reading. `compileSource` over a `.md` source
containing `<Hero name="x" />` and `<CallToAction />` emits:

```js
Hero($$el1, {name: `x`}, null);
CallToAction($$el2, {}, null);
```

with frontmatter arriving as component props. So the authoring model ports
unchanged, and the conversion is a library port rather than a mechanism port.

## Already answered here

Read off the tree on the date above.

| ksite | Owner in this tree |
| --- | --- |
| `.md` pages as routes | `scanner/classify.js` — `ROUTE_EXTENSIONS = {'.mesa', '.md'}` |
| `<Component />` with no import | `build/auto-import-plugin.js` |
| frontmatter reaching the page | `compiler-md.js` — frontmatter becomes exported props |
| `_module` layouts, `[...404]`, dynamic segments | the scanner |
| `all` / `published` / `indexed` / `redirects` route lists | `scanner/generate-route-table.js` — the same four |
| spank prerender | `build/prerender.js`, plus `getStaticPaths` and **static-safety**, which has no ksite counterpart: the build taps the client and refuses to bake gated data |
| sitemap, robots, `_redirects`, llms.txt, `404.html` | `postbuild/` — all five |
| `SiteHead.svelte` | a route's `head()` |
| lazy-loader and preload | `postbuild/defer-js.js`, speculation rules |
| whole-app hydration | islands — a prerendered page ships no script unless one is declared |
| Plausible / GTM | `sierra/analytics` |
| UnoCSS | supported alongside `@frontierjs/css` as an app layer (Invariant 13) |

## What a conversion would have to answer

Ordered by what it costs, not by what it is.

**The block library.** Seventy-five blocks and twenty-five components,
~9,300 lines, and none of it has an owner here: `@frontierjs/ui` is application
UI — `Table`, `Combobox`, `Form`, `DatePicker` — and carries no Hero, no
call-to-action, no reviews, no FAQ, no team grid. Both systems are signal-based
with similar component syntax, so this is translation rather than redesign, and
it is still the bulk of the work. Whether it becomes a package is a *batteries
vs. smallness* question and is not settled here.

**Content collections.** Seven directories of markdown — reviews, faqs, services,
team, features, process, offers — each read by the block that renders it.
`content-collections.md`, unchanged by this reading.

**Site-wide settings.** ksite merges `content/settings/site.md` frontmatter into
every page, which is where `company_name`, `company_phone`, the SEO defaults and
the feature flags come from. Frontmatter here is per-file and nothing merges.
It is the same shape as a collection of one and probably belongs to that record
rather than to a mechanism of its own.

**Build-time responsive images.** `make-images.js` scans source and content for
image references and generates 480/1080/1920 WebP through sharp, adds AVIF for
eager and mobile images, and detects a `-mobile` source file; the src string
carries the configuration (`?width=768&loading=eager&fetchpriority=high`), and
`Image.svelte` renders a `<picture>` with per-format srcsets. Nothing in this
tree does any of it. A `File` column is runtime storage and a different problem.

**The markdown dialect.** `==text==`, `:icon-name:`, `Heading |> split`, `====`
and `===` dividers, ALL-CAPS kicker detection, bare phone and email autolinking.
**Half of this is already reachable**: `compileMd` accepts `remarkPlugins` and
`rehypePlugins`, and Sierra never passes them from config. Wiring that through
is the cheapest item on this page and it makes the whole dialect portable as the
plugin ksite already has.

**Structured data.** LocalBusiness, Organization and WebSite JSON-LD, with
`company_address` parsed into a PostalAddress and hours and rating carried
through. No owner here.

**The host.** ksite deploys to Cloudflare Pages, and two of its features are
Pages Functions: a first-party Plausible proxy and a `sendBeacon` lead-capture
fallback to a KV endpoint. A Sierra `site/` surface releases as `serve.js` plus a
Dockerfile. A client marketing site wants a CDN and not a container, so either
the surface grows a static-host release — the build already emits exactly what
Pages serves — or a converted ksite keeps its own deploy script.

**Smaller, and app code rather than framework:** menus as content, the `ka-*`
click-tracking convention, the attention tracker, the Google Fonts localizer,
the drag-and-drop `PageBuilder`, and the `/site-status/` buildout mode. The
Playwright visual-regression suite is outside either framework and stays where
it is.

**One with no obvious owner either way:** ksite purges its single emitted
stylesheet by walking the built HTML. `@frontierjs/css` ships whole and nothing
here prunes it. `css-delivery.md` is the nearest record.

## Worth taking regardless of any conversion

Six things this template does that are good independently of whether a ksite is
ever converted. Ordered by what they would be worth here, not by what they cost.
Each was checked against this tree on the date above; three of them found nothing
to check against.

**Configuration rides on the reference.** An image is configured from the src
string itself — `/media/images/hero.jpg?width=768&loading=eager&mobile=true` —
rather than from a props table beside it. The declaration and the use are the
same characters, so they cannot drift, and the build reads the same string the
page does. It is the argument for a `@`-attribute on a column, one realm over.

**The build scans for what it must generate.** `make-images.js` walks source and
content for image references and generates only the variants somebody actually
referenced; there is no manifest for anyone to maintain. The same instinct as
Sierra's scanner and the static-safety tap — the build finds out rather than
being told — applied to assets, which is the one place this tree does not apply
it.

**The app says which of itself is unfinished.** Pages carry `buildoutStatus` and
`buildoutNotes`, a `/site-status/` route lists every page with its state, and
both fields are stripped before launch. Sierra reads `status: draft` in four
places and **every one of them is a filter** — dropped from `published`, dropped
from `indexed`, dropped from the sitemap. Nothing surfaces it, so a half-built
app looks exactly like a finished one. *What of this is not done* generalizes far
past a marketing site and is a question `fli gui`'s front page cannot currently
answer.

**Behavior by class convention, with no wiring.** Any element carrying a `ka-*`
class fires the correspondingly-named analytics event on click, and a `tel:` link
fires `call`. Nothing is imported and no handler is registered. Sierra's
analytics is `track()`, an imperative call somebody has to remember at each site,
which is the shape that fails when the person editing the page never opens a
`.mesa` file.

**A submission that cannot be lost.** `fallback.js` mirrors form data to a
key-value endpoint through `sendBeacon` on `pagehide` and `visibilitychange`,
deduped by a content hash, so a third-party form post that fails does not lose
the lead. `sendBeacon` appears nowhere in this tree. Junction's transactional
outbox is the same idea one hop later; this is the hop before it, which the
outbox cannot see because the service was never reached.

**Breakpoints named for the content.** `textWidth` (45rem), `contentWidth`
(70rem) and `blockWidth` (160rem) sit beside `2xs`–`6xl` rather than replacing
them. `@frontierjs/css` ships no breakpoint scale at all — its token layer
carries no media queries — so if one is ever added, this is the axis to add it
on: it is the same rule as naming a tone instead of a color, one dimension over.

Three more were considered and are not on this list because they already have an
owner: the block interior-styling variants are `page-composition.md`, the
collection model is `content-collections.md`, and the first-party analytics proxy
is a property of the host rather than of a framework.

## What the reading suggests, and does not

**The conversion is a library port with four framework gaps behind it** — images,
collections, settings, structured data — and one wiring omission that costs
almost nothing to close. That is a different conclusion from
`conversion-maid-tech.md`, which found nothing needed adding for the hard parts:
an application converts onto realms that exist, and a *site template* converts
onto a realm this framework has deliberately kept small.

Any estimate of how long that takes is judgment rather than measurement and is
recorded as judgment: the block library dominates everything else, and the four
gaps are each smaller than it. No sequencing is proposed here — the record that
would carry one is `content-collections.md`, which already holds the first step.
