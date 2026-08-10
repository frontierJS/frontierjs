# Idea — Page composition: the tier `@frontierjs/css` never built

**Status: ASSESSMENT + PROPOSAL. UNBUILT.** Dated 2026-08-09. The *exists today*
claims were read off `packages/css/src/` and `vocabulary.js` on that date;
everything under *Proposed* is a suggestion, not a ruling, and the names are
placeholders. Do not cite the proposed sections as behaviour — see `VERIFYING.md`.

---

## Trigger

An outside design system — **ksite**, a marketing-site styling API built on
UnoCSS + remark + Svelte — publishes its conceptual schema as a document: the
formal terms and their relationships, with class names declared to be the
*implementation* of that schema rather than the schema itself.

That is the same claim `@frontierjs/css` makes with `vocabulary.js`, arrived at
from the opposite end of the problem. Comparing the two is useful precisely
because the philosophies agree and the **coverage does not**: ksite is a page
compositor and this package is a component vocabulary, so each one's tiers are
the other's blank space.

The comparison is worth recording for one reason: **the gap is real and it is
ours.** Three of ksite's seven documented open holes are things this package
already closed; two of its tiers are things this package has nothing for at all.

---

## Where the two agree

Not filler — this is the part that makes the disagreements meaningful. Two
systems built for different targets converged on the same four decisions.

**A name is a contract; the class is an implementation detail.** ksite calls its
document "the AST of the design system" and states that CSS class names and
UnoCSS shortcuts are the expression of it. `vocabulary.js` is the same artefact:
54 terms, which element each is, and a `class` field present only when the class
name is not the lowercased term.

**Colour is never the API.** ksite's surfaces are `bg-dark` / `bg-tint`; ours are
a tone plus a treatment (Invariant 13). Neither system lets an author name a
colour at the call site.

**A base shape, composed into by everything above it.** ksite's `brick` is a
Frame — and its own notes are explicit that `brick` covers only part of one:

```
brick = rounding + grid + gap + relative
      = Shape(partial) + Structure(partial) + positioning
```

with Surface, Spacing and Size arriving as modifiers. That split is exactly the
one `foundation/surface.css` and `foundation/chip.css` make: skin in the base,
arrangement composed on top, every composite named in one `:where()` list.

**Arrangement is a separate, skinless vocabulary.** Their `flow` / `centered` /
`lefted` / `righted`; our Layout tier — Stack, Cluster, Center, Split, Container
— which owns one arrangement each and no skin, so it composes onto any term.
Their `flow` and our `Stack` are the same component under two names.

---

## Where ksite's schema maps onto this package

| ksite concept | Here today | Note |
| --- | --- | --- |
| `Frame` | `Surface` + `Chip` | We split the primitive in two, by lineage rather than by scale |
| `brick` | `.surface` | Both are the block base every composite is built from |
| `surface` (bg/overlay/color) | tone recipe in `surface.css` | Ours derives the text colour; see below |
| `spacing` | `--space-*` × `--density` | We have a third axis they do not |
| `structure` | Layout tier | Same names as Every Layout on our side |
| `alignment` | `.center`, `.split` | Partial — we have no `lefted`/`righted` |
| `Section` (macro frame) | `Pane` | **Ours carries no structure template** |
| `Article` (micro frame) | `Card` / `Section` | Ours has no positional role |
| `Article.role` | `ANATOMY` parts | Named parts, not position-implied roles |
| `Content` tier | — | **Nothing.** We style no `p` by design |
| `prose` / `flow` over markdown | — | **Nothing** |
| Heading Group (kicker/title/divider) | — | **Nothing.** This is their open hole #1 |
| `Decoration` (bg image, gradient, motif) | — | **Nothing** |
| `filter-accent` / `filter-primary` | — | **Nothing** |
| `Motion` as a Frame property | `components/overlays.css` | Overlay tier only, centrally owned |
| `Collection` | `items` / `rows` containers | Ours is a container class, not a data contract |

---

## Where we are ahead, and why it is worth keeping

**Contrast is derived, not declared.** ksite hand-writes the cascade:

```
{ 'text-light': '--color-heading:white --color-text:white --text-bold-color:white' }
```

so every surface needs a light and a dark variant chosen by the author, and a
tone whose luminance sits near the middle is a judgement call nobody makes twice
the same way. `chip.css` reads the fill's relative luminance out of the `y`
channel of `xyz-d65` — which *is* WCAG's L, so no approximation is involved — and
derives `--on-fill` from it. One tone name; the text colour is not an authoring
decision. This is the single largest divergence in the package's favour.

**Density is a third axis, and it inherits.** ksite has no counterpart. A tone is
`inherits: false` because it is a fact about one element; density is
`inherits: true` because it is a fact about a region, so `.dense` on a Pane
reaches every Card, Row and Field inside it.

**The schema is data with tests behind it, not a document.** This is the one to
press. ksite's schema lists seven *Known Holes / Open Questions* as prose. That
is exactly the state this package was in before `vocabulary.spec.js` — and when
the check was finally written it found the vocabulary **lying in both
directions**: `table` had a guide page and no term; `chip` and `surface`, the two
lineages, were not in the list at all; and `ANATOMY`'s first run caught VOCAB
naming an element the anatomy could not legally contain (Tooltip as a `<div>`
inside an inline-flex anchor). A schema nothing can check is a schema that is
already wrong somewhere.

**Two of their open holes are closed here.** Their #1 — *"Heading Group has no
container: kicker + title + divider always appear together but have no named
wrapper concept"* — and their #2 — *"Collection item schema is informal, no
formal contract enforced"* — are both the question `ANATOMY` answers: which
children a term expects, `parts` (owns) versus `uses` (borrows), one canonical
markup block each, held in both directions by `anatomy.spec.js`. Their #4
(gap-flow token) and #6 (does `prose` include `flow`) are settled here by the
space ladder and by the ruling that the parent owns the space between children.

---

## The gap — what we genuinely do not have

The honest summary: **this package built app chrome and never built page
composition.** Every term in `Frame` and `Page` is shell — Topbar, Sidebar,
Shell, Screen, Pane, View. There is no vocabulary for a marketing band, and
nothing in the eight tiers describes authored prose.

### 1. Section templates — the real hole

ksite's Section carries a *structure template*, and the template implicitly
assigns the role of its first child:

| Template | Structure | Article-1 role |
| --- | --- | --- |
| `block-with-content` | single column | body |
| `block-with-media` | text + media, always 2 col 1 row | body |
| `block-with-columns` | equal columns, multi-row | body |
| `block-with-grid` | n-up grid | header |
| `block-with-feature` | n-up grid, icon cells | header |

Our `Pane` is *"a labelled major subdivision of a Screen"* and says nothing about
arrangement. An app building a hero, a feature grid or a text-beside-media band
composes it by hand out of Layout helpers every time — which is the definition of
a missing term, and the reason `@frontierjs/ui`'s marketing surface does not
exist either.

One name encoding an arrangement is the good idea here. Whether the *implied
role for child 1* survives is the open question (§Risks).

### 2. A content/prose layer

The package styles **no `p`** — deliberate, it is not classless. That is right
for an app: the app writes elements. It is wrong for anything markdown-driven,
where the author writes prose and never touches a class. ksite's whole Content
tier — Heading Group, Copy, Media, Action, Collection — plus `kicker`,
`preheading`, `accent` exists for that reader, detected by remark rather than
written by hand.

Note the shape of that: **their detection layer is the equivalent of our
declaration layer.** They infer a kicker from ALL CAPS; we would want it stated.
Any `prose` here should be an opt-in scope (`.prose > *`), never a global element
rule, or it fights every consuming app — the same reasoning that keeps `.app` off
a bare `body` selector in `frame.css`.

### 3. Decoration

Background image with `srcset`, gradient, motif, and `filter-accent` /
`filter-primary` / `filter-gray` on SVGs. We have tones and treatments and
nothing else in this space. Cheap to add; a filter that routes an SVG to a tone
is one rule and would compose with the existing tone names for free.

### 4. Positional roles

`nth-1:col-span-full`, `not-first:flow` — position implying role inside a
repeating structure. Economical for authored content. It is also the item here
with the weakest fit against this package's own bar; see below.

---

## Risks, stated before anyone builds this

**A positional role is hard to check, and checkability is the thing this package
is actually good at.** `ANATOMY` holds because a part is a class that ships CSS
and matches a node in a canonical markup block. `nth-1` is a *position*: there is
no class to look up, and "article 1 is the header" cannot be asserted against the
CSSOM the way `.alert-icon` can. Adopting position-implied roles trades the
property that caught five real bugs for terseness. Prefer a named part.

**A Section template is a container, and containers here have a measured cost.**
The package ships no `container-type` and a test enforces it — inline-size
containment measured a `.card` in a `.cluster` collapsing from 83px to 42px, and
the box becomes the containing block for `position: fixed` descendants. A
template tier that reaches for container queries walks into that.

**New vocabulary is a design decision, not a class.** Anything here that ships
CSS must be named in `vocabulary.js` or classified in `NOT_A_TERM` with a reason,
or the suite fails. That is the intended friction: `block-with-media` is five new
terms in a system whose whole argument is that there is one name per concept, and
five terms that are really *one term with a structure argument* would be the
wrong shape. A `Band` term with a stated structure modifier is likelier right
than five templates — but that is a ruling to make, not an assumption to build
on.

**A `prose` scope is the one thing here that can break a consuming app.** Every
other proposal adds a class nobody is forced to write. Prose styles bare
elements, and this package's restraint about bare elements is load-bearing.

---

## What ksite would take from here

Recorded because it makes the comparison two-directional, which is the same
standard the specs in this package hold themselves to.

1. **Derived contrast** in place of the hand-declared `text-light` / `text-dark`
   cascade — one tone name instead of a light and dark variant per surface.
2. **Both-directions testing of the schema.** Their document lists seven holes;
   ours listed none and had eighteen. The forward direction (*every term ships
   CSS*) was true here for four versions while the reverse (*every shipped class
   is a term*) was false the whole time.
3. **Density as an inheriting axis**, which removes the per-component size
   modifier (`.btn-sm` and its 53 siblings) entirely.

---

## Bottom line

Philosophy aligns near-completely; nothing in ksite's schema **conflicts** with
an invariant here. It extends into two tiers this package left empty — page
composition and authored prose — because it was built for websites and this one
was built for applications.

The work, ranked by whether it is worth doing:

| | Item | Worth |
| --- | --- | --- |
| 1 | Section/Band structure vocabulary | **Real gap.** The reason there is no marketing surface in the repo |
| 2 | Decoration: filters, background image, gradient | Cheap, composes with tones already |
| 3 | An opt-in `prose` scope | Needed for anything markdown-driven; the one item that can break a consumer |
| 4 | Positional roles | **Least fit.** Trades checkability for terseness |

None of it is scheduled. `packages/css/PROJECT_STATE.md` is where it would land
if it were.
