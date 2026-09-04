# The style guide

The interactive reference: 54 pages, every component live, eight themes —
all 54 vocabulary terms have a page. The first two are not reference pages at
all:

- **Utilities → How things behave** — the part the vocabulary cannot teach:
  who owns the space between two boxes, what order to decide padding and gap
  in, and whether the child shapes the parent or the parent constrains the
  child. It counts its own evidence from the live stylesheet.
- **Reference → Footprint** — what the bundle weighs against Bootstrap, Bulma,
  Pico, Foundation and Open Props, and then the half that matters: where their
  class counts come from. 59% of Bootstrap's class names are the same ideas at
  five widths and 34% of Bulma's are one color helper at every step of a
  lightness ramp, against 12% here — which is the multiplication argument from
  **Why this one** stated as a number a reader can recount rather than agree
  with. Our figures are read from the live CSSOM as the page renders; theirs
  are frozen constants with a version and a date on every row, because
  fetching a competitor's CSS at render time would break the page offline and
  silently re-measure whatever the CDN serves next year. The page ends with
  the four commands that produced every number, and states what the table does
  *not* support — eight themes are in our bundle, no grid ships at all, and
  nothing on either side is tree-shaken.
  **Our own 23 are listed by name**, because a share is a number nobody can
  check and 23 names is one anybody can — and listing them is what showed the
  columns count spelling rather than meaning. Ten are one rung each of the
  space and type ladders, not `.gap` at a breakpoint; three are substring
  false positives the grep cannot avoid (`.bordered` contains *red*), counted
  anyway rather than quietly exempted. The number that is genuinely zero is
  the one the column is named after: **no breakpoint variant of anything
  ships**, while `countResponsiveClasses()` finds the 8 classes that do change
  at a width and keep their name while doing it.
- **Reference → Cheat sheet** ends with **Every class, searchable** — all 166
  classes the stylesheet ships, read out of the live CSSOM, each with what
  kind of class it is, one line saying what it is, and which files declare it.
  Twelve kinds — term, anatomy, modifier, utility, theme, tone, heading,
  container, treatment, a11y, density, and a residue of six that are none of
  those. The a11y group is identified by the folder a class ships from rather
  than by name, but only after `NOT_A_TERM` has had its say, so a register
  entry always beats a display rule.
  **Every one of the 166 notes is specific to that class** — `.dense` says
  *tightens every space rung by 20%*, not *the density axis*, because the
  badge beside it already said the axis. They are derived: the density
  multiplier and the size utilities are measured off probes, a modifier's
  scope and declarations come out of its own selectors, a theme reports its
  measured primary and how many tokens it overrides. Zero rows share a note
  with another row of the same kind, which is checkable and was checked.
  Type `header` and get `.surface-header`, `.section-header`, `.dialog-close`;
  type `tables.css` and get everything that file declares. **Kind toggles**
  sit above it — pick several and you get the union, `All` resets them without
  clearing what you typed. Pressed is `[aria-pressed]`, never a class, and the
  pressed fill is not chosen here: setting `--bg-mix` hands it to `chip.css`,
  so a toggle gets the same derived contrast-safe fill as any toned control. The kinds come from
  `vocabulary.js` — VOCAB for terms, ANATOMY for parts and their owner,
  NOT_ANATOMY and NOT_A_TERM for the two registers of *deliberately something
  else*. A row reading `unclassified` would mean a class nothing names, which
  the suite refuses to allow, so the table is also a test result.
- **Foundation → The two axes** — the one diagram in the guide. A tone and a
  density are the same idea pointed at different problems, and what separates
  them is one line of `@property`. Hand-built inline SVG, so `var(--…)` inside
  it resolves against the live theme and the drawing follows the switcher.
  **Every number on it is read or measured while the page renders** — the mix
  percentages and the two luminance constants out of the authored CSS via
  `tokenValue()`, the twelve rungs and three densities off probe elements in
  the document. A diagram is the easiest thing in a repo to leave stale,
  because nothing renders wrong when it rots; this one goes wrong visibly.
  The same facts follow it as tables, which is also what makes it readable at
  a phone width the 11px SVG labels are not.
- **Structure → Anatomy** — which children each term expects, and one
  canonical markup block for each. Every fact on it is read from `ANATOMY`
  in `../vocabulary.js`; nothing on the page is written by hand.
- **Learn → Pick a term** — a decision wizard that answers the question the
  other 48 cannot: which term you want in the first place.
- **Learn → Why this one** — an audit against Tailwind, Bootstrap, Bulma,
  Pico, Open Props, Radix Themes and Web Awesome, arranged so the
  disqualifying answers come first. Every number it states about *this*
  package is counted from `vocabulary.js` and the live CSSOM at render time,
  because a comparison page is the easiest place in a repo to leave a stale
  number: nothing renders wrong when it rots. Its worked example carries a
  live `<style>` — the `.brand` tone the sample declares is the one the
  preview renders — and measures the result's contrast in the reader's
  browser rather than asserting it.

## Run it

```sh
open packages/css/guide/index.html      # file:// works
```

or, for DevTools and a phone on the same network:

```sh
bun run demo        # serves the WORKSPACE root, not the package
# → http://localhost:5173/packages/css/guide/
```

## What is here

| File            | What it is                                                          |
| --------------- | ------------------------------------------------------------------- |
| `index.html`    | The shell. `<link>`s the real `../index.css`, then the scripts below. |
| `guide.js`      | Data, page builders, and a hash router. One file, plain JS.          |
| `guide.css`     | The guide's own chrome (`.sg-*`) plus a few preview utilities.       |
| `decisions.js`  | The Learn wizard's routing tree. Questions and near misses only — every fact about a term is read from `../vocabulary.js`. |
| `search.js`     | The search: the tokeniser, the ranker, and the term entries built from `../vocabulary.js`. It also owns `slugify`. |

Every code block carries a **copy button** — `code()` wraps its own output in
`.relative` with the control as a SIBLING of the `<pre>`, because `.code`
scrolls and a button inside it slides away with the first long line. What it
copies is the **authored source**, held in `CODE_SRC` by index and reset per
render, not `pre.textContent`: `mark: true` turns `•x•` into a `<mark>` and
removes the bullets, so textContent would hand over a string a character short
that looks perfect. Measured, all 178 blocks round-trip identically today — the
array is correct by construction rather than a fix, and the Code page documents
the one syntax that would break the cheaper version. `navigator.clipboard` is
secure-context only and `file://` is not one, so there is a textarea fallback.

`code(src, lang)` highlights with glow; **`lang: 'txt'` skips it entirely**.
There is no "no language" mode in glow — an unknown one still gets the
common-word rules — so a plain diagram would come out with "Bootstrap"
colored as a keyword.

`guide.js` is an **ES module**, because it imports `glow()` from
`@frontierjs/toolbelt` by relative path to highlight the samples. `vocabulary.js`,
`decisions.js` and `search.js` stay classic scripts: `test/run.js` inlines their source
into a page whose specs are classic scripts, and a module's `export` would
throw there. A module can still read a classic script's top-level binding, so
`guide.js` sees both.

The design system CSS is **linked, never copied**, so the guide cannot drift
from the source — the same rule the JSX version established in v0.6.

## How it is put together

Each nav entry is one function returning an HTML string, registered in the
`PAGES` map at the bottom of `guide.js`. A page that needs behavior hangs an
`init(root)` off its own function; the router calls it after mount.

Two rules worth knowing before editing:

- **Interactivity is wired by delegation from `data-*` attributes**, never by
  inline handlers, so the markup in a preview stays copy-pasteable — what you
  read is what you would write in an app.
- **The page host node is replaced on every render, not refilled.** Listeners
  added by `init` go with it, so no page has to clean up after itself. Refill
  it instead and every second visit doubles up the handlers.

- **Three files are tested, and they are the three that are not markup.**
  `vocabulary.js` is checked in both directions against the real CSSOM,
  `decisions.js` against the vocabulary — including the direction nothing else
  would catch, that every shipped term is reachable by some path through the
  wizard — and `search.js` against both, that every term is the first hit for
  its own name *and* for its class name. Add a component and forget the wizard
  and `bun run test` says so.

## Search

`⌘K` / `Ctrl+K` anywhere, or `/` when the caret is not in a field. It searches
terms, page titles, section headings and body text, so a class name typed out
of an app's markup — `.list-row`, `surface-header` — lands on the section that
documents it.

**The corpus is harvested, not written down.** `buildSearchIndex()` renders all
51 pages into a detached node once, at idle after boot (~150ms), and reads the
sections back out of the markup using the same `tagSections()` the live render
uses — so a result's href and the id it lands on are produced by one function,
and a heading that gets edited is re-indexed by existing rather than by being
remembered. A written index of a 51-page guide would go stale on the first edit
and go stale silently: a missing entry looks like a page with less in it.

The ranker is in `search.js` so a spec can hold it, and the ladder is steep on
purpose — a title hit outranks any weight of body text, because a guide repeats
its own vocabulary constantly and ranking mentions near titles answers "card"
with whichever page happens to talk about cards the most. Frequency only breaks
ties, capped at +5.

Adding a page: write the function, add it to `PAGES`, add its id to `NAV`.
The "coming soon" fallback is derived from the same map, so a nav entry with
no page says so rather than rendering blank.
