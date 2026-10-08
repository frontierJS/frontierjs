---
id: site-kit-structure
status: partial
dated: 2026-10-04
---

# Idea — site-kit's page structure: what to keep from ksite's schema

**Status: IDEA. UNBUILT; the names are placeholders until `decision-rules` runs
on them.** Dated 2026-10-04. Do not cite as behavior — see `VERIFYING.md`.

The source is legacy ksite's *Design System Schema* document (Frame → Section →
Article → Content → Decoration). **`page-composition.md` already compares that
schema term by term against `@frontierjs/css`** and this file restates none of
it. This file answers the narrower question that one left open: *what shape does
`@frontierjs/site-kit` give a markdown-authored page*, now that site-kit exists
and is meant to absorb ksite's engine (`site-kit-parity.md`).

## Kept — the five ideas worth porting

1. **Two levels: a Section is a full-width band, an Article is a cell inside
   it.** Matches css Principle 2 (a nested section is an `<article>`).
2. **One template word sets the arrangement and each article's role.** The
   author picks a word, not a layout.
3. **`===` splits a block's markdown into articles**, so the author never writes
   markup. The ksite port already does this (FJS-1493).
4. **Fixed styling axes instead of free classes** — surface, spacing,
   structure, alignment. The axes survive; ksite's spellings do not.
5. **A collection item has one shape**: media · heading · body · action.

## Dropped or renamed

| ksite | Why it goes | Instead |
| --- | --- | --- |
| **Frame** as the shared primitive | css's `Frame` tier is the app shell (App, Topbar, Sidebar, Shell); one word, two meanings | No word. Section and Article are enough |
| `brick`, `box`, `flow` | Copies of shipped terms | `Surface`, `Stack` |
| `bg-block-primary`, `bg-dark`, `filter-accent` | A color at the call site — Invariant 13 | tone + treatment |
| `padding-y`, `gap-square` | Spacing per component | density (`dense`/`roomy`), set once on the Section; it inherits |
| six `block-with-*` templates | Five of them are one term with a structure argument (`page-composition.md` § Risks) | Four templates, below |
| `classes:` free string in frontmatter | Nothing checks it | Typed keys: `template`, `tone`, `treatment`, `density`, `align`, `background` |
| eyebrow | css names it | `Kicker` |
| the UnoCSS variants (`nth-1:`, `article:`, `not-first:`) | Implementation of the old engine | Plain CSS inside site-kit; UnoCSS stays an app's opt-in |

## The proposed shape

```
Page
└─ Section  <section>   template · tone · treatment · density · align · background
   ├─ header  <hgroup>    Kicker + h2 + lede, Divider after   (role from template)
   └─ Article <article>   role: body | media | card
```

Each role lands on an element or a shipped term, so a role adds no class of
its own:

| Role | Output | Was |
| --- | --- | --- |
| header | `<hgroup>` | heading group, ksite hole #1 |
| body | `Prose` | body |
| media | `<figure>`, image fills it | media, ksite hole #3 |
| card | `Card` | cell |

Four templates, cut from six:

| Template | Arrangement | Article roles |
| --- | --- | --- |
| `content` | Stack | body |
| `media` | Split | body + media |
| `columns` | equal columns | body × n |
| `grid` | header full width, then cards | header, card × n |

`block-with-feature` folds into `grid` + `align: center` (centered cells with
icons was its only difference). `block-with-text` is `content` with no `===`.

```yaml
---
template: media
tone: primary
treatment: raised
align: center
background: /media/images/team.jpg
---
```

## Reconciling with `page-composition.md`'s refusal of positional roles

That file ranks positional roles **least fit**: `nth-1` is a position with no
class to look up, so it gives up the both-directions checking that caught five
real bugs in css. **This proposal keeps position only as AUTHORING syntax.** The
Section wrapper reads the template and the article's index at build time and
emits the named element (`<hgroup>`, `<figure>`, `.card`), so the rendered page
carries a named part and the CSS never selects by position. Whether that answers
the objection is the first question for review.

## ksite's open holes, answered

- **#1 Heading group has no container** — HTML has one: `<hgroup>`. `Kicker`
  ships in `bars.css`; no heading-group term does.
- **#3 Media role CSS** — `<figure>`, one fill rule.
- **#4 gap-flow token** — density owns section padding, Stack owns the gap
  inside an article. Two owners, two tokens.
- **#5 article-1 role override** — allow `===|media` as the first line of the
  body. Same syntax as articles 2+, no extra frontmatter key.
- **#2 Collection contract** — read item frontmatter against the card shape and
  warn on an unknown key. No per-collection schema yet;
  `content-collections.md` owns the larger version of this.

## Decoration

- **Background image** — a `background:` key rendered as an `<img>` behind the
  section, as the port's `Block.mesa` does with `bgImage`.
- **Overlay** — derived contrast (`--_on-fill` in `chip.css`) handles a TONE
  fill and cannot handle a photo, whose luminance is unknown. A photo band needs
  `--scrim` (`tokens.css`) under the text plus light ink. Whether that is a
  treatment or a site-kit rule is open.
- **`filter-*` on icons** — dropped. An inline SVG drawn in `currentColor`
  takes a tone with no filter.

## Where each piece lives — css, site-kit, the site

**css gets what an app with no markdown would also write. site-kit gets what
exists only because an author writes markdown, plus website nouns. The site
gets one client's brand.** site-kit therefore coins no styling words: it maps
frontmatter onto css words, and each block styles itself in its own `.mesa`.

Sorted from ksite's UnoCSS preset (`uno-preset.frontier.ts`) and `blocks.scss`:

| Lives in | What | ksite spelling |
| --- | --- | --- |
| css, shipped | Surface, Stack, Cluster, Card, Kicker, Divider, Prose, Container, tone, treatment, density, `.pills` | `brick`, `box`, `flexed`, `card`, `preheading`, `mx-text-width`, `mx-content-width`, `danger`, `outlined`, `gap-square`, `padding-*` |
| css, missing | A full-bleed band: background to the viewport, content held to the container width | `bg-block`, `surface-*`, `vw-centered`, `bg-before` |
| | The align axis | `centered`/`lefted`/`righted`, `headings-*`, `btn-*`, `brick-*` |
| | Grid: auto-fit columns, the Layout helper css lacks | `grid-fit-cols`, `grid-odd`, `grid-even`, `matrix` |
| | Media fill and a photo background under `--scrim` | `.img`, `.image`, `bg-image`, `image-background` |
| site-kit | Template → css words, `===` splitting, role emission, Kicker detection | `block-with-*`, `article:`, `nth-1:` |
| | Website blocks, each scoped in its `.mesa` | Marquee, Reviews, Stars, Hours, ServicesTable, SiteMap, LeadForm, the modals, carousel, image-compare, FAQs |
| | Site header, footer, the script-free mobile menu | `.main-header`, `.mobile-menu`, `#nav` |
| | Decoration | `motif-*`, `content-*`, `lock-*`, `rotate-*`, `wiggle` |
| the site, `content/settings/site.css` | Brand color, fonts, one client's one-offs | `theme.scss`, `fonts.scss`, the gradient `hr` |
| dropped | Per-component spacing variables, text-shadow, hover utilities | `gap-x`, `margin-*`, `text-shadow`, `hover-*` |

**Unsure: the site header and footer.** css's Frame tier is app chrome only. They
stay site-kit blocks built from Bar and Nav until a second consumer wants them.

## Open questions

1. ~~**Positional roles — does build-time emission of the named part answer `page-composition.md` § Risks?**~~ **Answered 2026-10-07 (`FJS-D614`): A — yes: position is authoring syntax only, and the build emits `<hgroup>`, `<figure>` or `.card`, the way an ALL-CAPS line before a heading is emitted as `.kicker`.**
   - **A** — yes: position is authoring syntax only, and the build emits `<hgroup>`, `<figure>` or `.card`, the way an ALL-CAPS line before a heading is emitted as `.kicker`
   - **B** — no: every article names its role (`===|media`) and nothing is inferred from position
   - **Recommend A** — the rendered page carries only named parts, so the CSS never selects by position and the anatomy spec can check the output
2. ~~**Where does `align` live?**~~ **Answered 2026-10-07 (`FJS-D620`): A — a css axis beside tone, treatment and density: an inheriting custom property that the Layout helpers and the band read, with `text-align` following it.** `Center` places one child, and `start`/`end` are scoped modifiers that do not compose.
   - **A** — a css axis beside tone, treatment and density: an inheriting custom property that the Layout helpers and the band read, with `text-align` following it
   - **B** — a site-kit frontmatter key that emits css's existing `start`/`end`/`center` modifiers
   - **Recommend A** — ksite spelled alignment four ways (`centered`, `headings-*`, `btn-*`, `brick-*`), and an app centers an empty state or a sign-in card the same way a site centers a band
3. ~~**Who owns the band and its arrangement?**~~ **Answered 2026-10-07 (`FJS-D621`): B — css: `Band` (question 4) with no structure, and arrangement from the Layout helpers plus a new Grid; site-kit's templates are authoring words that emit `band` + one helper and ship no CSS.**
   - **A** — css: one band term with a structure modifier (`page-composition.md`'s guess)
   - **B** — css: `Band` (question 4) with no structure, and arrangement from the Layout helpers plus a new Grid; site-kit's templates are authoring words that emit `band` + one helper and ship no CSS
   - **C** — site-kit: `Section.mesa`'s scoped styles own all of it
   - **Recommend B** — the Layout tier already owns arrangement ("one arrangement each, no skin, compose onto anything"), so a structure modifier would be a second owner of it; an app gets the band and Grid without site-kit
4. ~~**What is the full-width stripe called, and who owns reaching the viewport edge?**~~ **Answered 2026-10-07 (`FJS-D622`): A — both: a `Band` term (a `<section>` over Surface owning the background slot, a photo under `--scrim`, and block padding from density, with a `.container` inside for width) and a `.bleed` utility for anything else that escapes its parent (an image in Prose, a Divider, an edge-to-edge table on a phone); the escape is ONE rule, `.bleed, .band`, the way `.kicker, .navlist-label` share one.**
   - **A** — both: a `Band` term (a `<section>` over Surface owning the background slot, a photo under `--scrim`, and block padding from density, with a `.container` inside for width) and a `.bleed` utility for anything else that escapes its parent (an image in Prose, a Divider, an edge-to-edge table on a phone); the escape is ONE rule, `.bleed, .band`, the way `.kicker, .navlist-label` share one
   - **B** — the `.bleed` modifier only, no noun: `<section class="surface bleed primary">`
   - **C** — give css's existing `Section` term a class (today it is the bare element inside a Screen, so every app's sections would change)
   - **Recommend A** — a page stripe is a thing an author names, and the escape is a mechanism other things need too; one rule keeps the escape single-owner. `50vw` counts a classic scrollbar, so the spec asserts no horizontal overflow at 360px
5. **The remaining nouns** — Grid, the template names, the role names and `align` go through `decision-rules` before any code. *Grid and `align` passed it and shipped in css on 2026-10-06 (`.grid`, `.align-start`/`-center`/`-end`); the template and role names wait for `Block.mesa`'s move.*
   - **A** — the names in § *The proposed shape*: templates `content`, `media`,
     `columns`, `grid`, and roles `header`, `body`, `media`, `card`.
   - **B** — the `template` key takes the Layout helper's own word (`stack`,
     `split`, `grid`), and roles get no author-facing names, since position is
     the only way an author states one.
   - **C** — adopt ksite's six `block-with-*` names unchanged.
   - **Recommend B** — under `FJS-D621` a template emits `band` plus one helper,
     so a second word per arrangement is a restatement of the helper's, and
     under `FJS-D614` a role is never written, only emitted as the element it
     lands on. That leaves no new noun to coin. C is the set the proposal
     already cut.
6. ~~**What is ksite's `Block.mesa` called once it moves to site-kit?**~~ **Answered 2026-10-08 (`FJS-D654`): A — `Block.mesa`: the authoring noun stays, and a top-level block emits css's `band` plus one Layout helper (`FJS-D621`, `FJS-D622`).** This file's first draft wrote `Section.mesa` as a placeholder, and no ruling took it.
   - **A** — `Block.mesa`: the authoring noun stays, and a top-level block emits css's `band` plus one Layout helper (`FJS-D621`, `FJS-D622`).
   - **B** — `Section.mesa`, the placeholder in § *The proposed shape*.
   - **C** — `Band.mesa`, after the css term a top-level block emits.
   - **Recommend A** — a block is not always a section: the element follows position, `<section>` at the top, `<article>` nested, `<a>` with a `url`, none when unwrapped, so a name for one of the four misleads on the other three. B collides twice, with the HTML element and with css's existing `Section` term that `FJS-D622` declined to reuse, and makes Band's stripe a second word. C names one output of four in the same way. Authors already write `layout: Block`, so A coins nothing.

**The first pieces to build are in css** — built 2026-10-06: Band, `.bleed`,
Grid and the align axis, each named in `vocabulary.js`. Then ksite's
`Block.mesa` moves to site-kit under its own name (question 6), reading typed
keys and emitting those words — what `website/packages/site-kit/PROJECT_STATE.md` § Next
names.
