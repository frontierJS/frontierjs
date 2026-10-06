---
id: site-kit-structure
status: proposed
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

## Open questions

1. **Positional roles** — does build-time emission of the named part answer
   `page-composition.md` § Risks? (above)
2. **`align`** is the one axis css lacks: `Center` places one child, and
   `start`/`end` are scoped modifiers that do not compose. site-kit's key, or a
   css axis beside tone, treatment and density?
3. **Who owns the templates** — site-kit classes, or a css `Band` term with a
   structure modifier (`page-composition.md`'s guess)? A css term would make
   them available to `@frontierjs/ui` too.
4. **New nouns** — the template names, the role names and `align` go through
   `decision-rules` before any code.

**The first piece to build** is ksite's `Block.mesa` moving to site-kit as
`Section.mesa`, with typed keys in place of `classes` — what
`website/packages/site-kit/PROJECT_STATE.md` § Next already names.
