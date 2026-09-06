# Changes — @frontierjs/email-kit

## 2026-09-05 — four defects the audit found, fixed

**[FJS-928](../../ISSUES.md#fjs-928) — a `<Button>`'s Outlook fallback escaped nothing.** The
VML is built as a string and spliced into the finished document, which is the design's whole
point (happy-dom ends the comment early, so the markup has to stay out of the DOM) and was also
what removed the last escaping in the path. A `text` of `Pay <![endif]--><img …> now` put the
`img` OUTSIDE the conditional comment, so it reached every client rather than Outlook; an `href`
carrying a `"` broke out of the VML attribute. The anchor beside it escaped both correctly all
along, which is what hid it: one half of one component was safe and the unsafe half is the one
nobody re-parses. `>` is escaped for a reason beyond attributes — a comment ends at a literal
`-->`, so escaping `<` alone leaves the block closable.

**[FJS-929](../../ISSUES.md#fjs-929) — `<Avatar name="   " />` threw**, taking the whole email
with it. A whitespace-only name is truthy, trims to empty, and `[0]` is then `undefined`. An
empty name was fine, which is why it was never seen: the guard was on the wrong emptiness.

**[FJS-930](../../ISSUES.md#fjs-930) — `<Section padding>` did nothing.** Its spacer rows were
siblings of the section table, and a `<tr>` with no table ancestor is discarded by the parser
rather than by the renderer — so they were in the rendered string all along and every substring
assertion agreed with the broken version. Moved inside the `<tbody>`, which is what the prop's
own doc comment already claimed, and the section's `bgcolor` now runs through the padding.

**[FJS-931](../../ISSUES.md#fjs-931) — `width="undefined"`.** A quoted interpolation stringifies
an unset prop; a bare `{width}` omits the attribute. `Image` documented the trap it shipped —
*Always specify width for Outlook* — while its own default emitted a value Outlook cannot read.

[FJS-933](../../ISSUES.md#fjs-933) closed alongside them: the component map in `index.js`
is still a literal, so no bundler has to see a `readdirSync`, but the keys are now asserted
against the directory. And [FJS-932](../../ISSUES.md#fjs-932) is fixed in mesa — the plain-text
fallback ran adjacent blocks together, and this package is the only consumer of `result.text`.

The suite is 102 tests, from 77. Each fix was measured against its own removal: 3 red, 1, 2, 2.
`Section`'s is asserted through a **real parse**, since the string is where the broken version
looked correct. Still never opened in a real mail client.

## 2026-09-05 — three of the nine guards named a prop that does not exist

The advice a guard prints is its whole value, and it is a string, so every test written the
day before passed on all three: `Address` told a caller to pass `region` and `postcode` when
it takes `state` and `zip`; `Stars` said `rating` when it takes `count`; `Avatar` offered
`src` for a real image, and it has no image — it draws a letter. Advice that fails when taken
is worse than none.

Fixed, and the check is derived rather than restated: every bare backticked identifier in an
advice string is asserted to be an `export let` of that component, read out of the same file.
It is red against any of the three originals. `TwoCol` is the shape that forces the rule to be
about identifiers — its backticks hold `<div slot="left">`, which is markup and not a prop.

Found by an audit of the package rather than by a caller, which filed six ids: an injection
through `<Button>`'s Outlook fallback ([FJS-928](../../ISSUES.md#fjs-928), the sharp one),
`<Avatar name=" " />` throwing ([FJS-929](../../ISSUES.md#fjs-929)), `<Section padding>`
emitting rows no client keeps ([FJS-930](../../ISSUES.md#fjs-930)), `width="undefined"`
([FJS-931](../../ISSUES.md#fjs-931)), a plain-text fallback that runs blocks together
([FJS-932](../../ISSUES.md#fjs-932)) and the hand-kept component map in `index.js`
([FJS-933](../../ISSUES.md#fjs-933)).

## 2026-09-05 — every component is rendered by something, and one that cannot take children says so

The suite went from 34 tests to 77.

**Two components had never been rendered by anything.** `Header` and `Link` were in neither
the suite nor the `WelcomeEmail` template, so they worked by luck rather than by evidence; four
more — `Heading`, `Text`, `Review`, `TwoCol` — were reached only through the whole-document
template render, which asserts the document and not the component, so a break in one showed up
as a byte count nobody checked. Every component in the directory is now rendered on its own,
and the list is READ from the directory rather than written out, because a hand-kept list is
what let two of them fall out of it.

**A component that cannot render children now says so.** Mesa drops children handed to a
component with no matching `<slot>`, in silence — fourteen of these take children and eight
cannot, so a caller had no way to tell which kind they were holding, and getting it wrong
rendered an empty button rather than an error.

`Button` is the case that decided the shape. Its label goes into the anchor AND into the
Outlook VML, which is built as a STRING in `<script>` and percent-encoded into a data
attribute — slot content is DOM and never a string, so a `<slot>` there would label the anchor
and leave every Outlook recipient an unlabelled button. Refusing the children and naming the
prop is the answer; accepting them halfway is worse than dropping them.

`refuseChildren(component, $.slots, advice)` warns once per component per process — a list
renders the same component many times and a warning per row is a warning nobody reads — and
takes a whole sentence rather than a fragment, because half of these take no content at all
and *pass nothing instead* is not advice anybody can act on. `TwoCol` is guarded too: it has
named slots, so it is not slotless, and its default children were dropped just the same.

Every refusal is tested against a component that legitimately keeps its children, since a guard
that warned on everything would satisfy any test that only asked about the refusal. 11 of the
77 are red without the guard.

The underlying rule is the language's, not this kit's, and is filed as `FJS-926`.

## 2026-08-17 — paths resolve on Windows, and the phantom option is gone (`FJS-052`)

`index.js` built 24 component paths and `COMPONENTS_DIR` from
`new URL(...).pathname`, which on Windows keeps a leading slash before the drive
letter (`/C:/…`) — not a path any fs call accepts. Two of `render.js`'s compiler
probes did the same.

**The obvious replacement is also wrong here, and that is the finding.**
`fileURLToPath(new URL(rel, import.meta.url))` throws *The URL must be of scheme
file* under this package's vitest environment: happy-dom installs its own global
`URL`, and `fileURLToPath` refuses an instance of it. Twelve of 34 tests went red
on it — the same trap mesa's map records for its Vite suites, met from the other
side.

The spelling that is correct on every platform AND in both environments is to
resolve the directory once from `import.meta.url` — a STRING, which the function
does accept — and `path.join` from there. `render.js:42` already did exactly
that.

Also: the documented `autoImport: true` option that nothing implemented is gone
from the docs. A documented option that does nothing is a feature which does not
exist wearing the face of one that does.


Newest first.

## 2026-08-10 — the ratchet can see this package

Added a `typecheck` script and a `tsconfig.json`. This was the one workspace
member with neither, so Invariant 14's ceiling could be neither raised nor
lowered for it — not because it was clean, but because nothing measured it.
`checkJs` is off, matching mesa and css, so it starts at 0 and stays absent from
`scripts/typecheck-baselines.json`. Found by `bun run ci`, which now says so
rather than walking past.

## 2026-08-06 — the kit can be used from outside itself

34 tests. Driven by `example/` for the first time, which is what found all of
this: every defect below is invisible from inside the package.

- **`exports` could not serve the specifier the README documents.** The map was
  `"./components/*" → "./components/*.mesa"`, so
  `@frontierjs/email-kit/components/Email.mesa` resolved to `Email.mesa.mesa`.
  Mesa requires the `.mesa` suffix in the specifier — that is how it recognises
  a component import at all — so the documented form was the only one that could
  work, and it was the one that did not. Added the extension-carrying pattern;
  the extensionless form still resolves.
- **Templates outside this package could not import its components.** Mesa's
  `compileTree` resolved every `.mesa` import as a path. Fixed there; see mesa's
  `CHANGES.md`.
- **A `subject` export may now be a function** of the render data, which is what
  a subject that names a record needs. Also fixed in mesa.


## 2026-08-06 — the name is `@frontierjs/email-kit`, and the tests run again

34 tests, and this is the first time that number has been true in a while.

**Named.** `@frontierjs/mesa-email` is gone (`FJS-D15`). `package.json` already
said `@frontierjs/email-kit`; the old name survived in the README, `index.js`,
`render.js` — including the peer-dependency error a user would actually read —
`PROJECT_STATE.md`, mesa's docs, and the test filename, now `email-kit.test.js`.
The kit is named for what it is, not for what it is built on: `@frontierjs/ui`
is a Mesa component kit too and is not called `mesa-ui`.

**Every test in the package had been failing.** Two causes, one here and the
real one next door:

- This package probed for mesa's renderer at `../mesa/render-component.js` — the
  layout before mesa moved its sources into `src/` — so both sibling candidates
  missed. Worse, the "is this a missing module?" test read only Node's phrasing
  (`ERR_MODULE_NOT_FOUND`, `Cannot find module`) while Vite and vitest say
  `Failed to load url … Does the file exist?`, so a missed candidate was
  rethrown as a real error and the loop never reached the specifier that works.
  Both fixed: the paths point at `mesa/src/`, and the bundler's phrasing counts
  as not-found.
- In mesa: `findMesaDir()` put temp render modules in the OS temp dir whenever
  the process was not started inside `packages/mesa`, and a bare
  `@frontierjs/mesa/runtime.js` cannot resolve from there. See mesa's
  `CHANGES.md` for 2026-08-06.


## 2026-08-03 — added to the monorepo; two silent rendering defects fixed

The kit arrived as `packages/email-kit`. Before this it existed only on
another machine — `packages/mesa/email-kit.test.js` pointed at an absolute
`/tmp/mesa/email` path and was entirely `.skip`ped. **That file is deleted**;
the kit brings its own suite, and removing it took Mesa from 27 skipped tests
to **zero**.

### The bulletproof button was shipping its Outlook fallback to everyone

`<!--[if mso]>` was serialized as `<!--[if mso]-->` — a *closed* comment — so
the VML behind it became live markup and `<v:roundrect …>` parsed as
`<v :roundrect="" …>`. Every recipient on every client saw the button twice.

happy-dom, which the static renderer runs in, ends a conditional comment early
when certain tags appear inside it: a namespaced attribute (`xmlns:v`) does it,
so does a multi-line opening tag, so do some `style` values. `{@html}` had been
used to protect the block and cannot — `{@html}` sets `innerHTML`, which *is*
the DOM.

`Button.mesa` now keeps the VML out of the DOM entirely: percent-encoded into a
`data-mso` attribute, spliced back by `expandMsoPlaceholders()` in `render.js`
once the HTML is a string again. (Percent-encoded, not raw — happy-dom does not
escape `"` in a serialized attribute value either, so the payload's own quotes
would close the attribute.)

**Trade-off:** rendering a kit component through Mesa's `renderComponent`
directly now leaves the placeholder and drops the Outlook fallback. Use
`renderEmail` / `renderEmailFile`. A test pins that behavior rather than
letting it be discovered.

### The plain-text alternative was full of markup artefacts

Fixed upstream in Mesa's `htmlToText`: `<style>`/`<script>`/`<head>` contents
were read as prose; conditional comments were not handled, so every CTA
appeared twice; `&#847;` (the preheader's zero-width padding) printed
literally, because entity decoding was a fixed list of six; and the hidden
preheader was included, duplicating the opening line.

The two conditional-comment shapes need **opposite** treatment — the
downlevel-hidden block goes, the downlevel-revealed markers go but their
content stays. Deleting everything that matches `<!--[if … <![endif]-->`
removes the real anchor and the text loses every link it had.

### Also

- `getMesaRender()` had no bare-specifier candidate, so a consumer installing
  from npm always hit "install the peer dependency" no matter how correctly
  they had installed it. It also swallowed every failure with
  `catch { continue }`, which reported a missing dependency for a syntax error
  inside `render-component.js`. Real errors now propagate; the message lists
  what was tried.
- `test` now uses the package's own `vitest.config.js`, which already sets
  `pool: 'forks'` and a 30s timeout, instead of pointing at mesa's config and
  re-supplying only `pool` on the command line.
