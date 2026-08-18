# Changes — @frontierjs/email-kit

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

`<!--[if mso]>` was serialised as `<!--[if mso]-->` — a *closed* comment — so
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
escape `"` in a serialised attribute value either, so the payload's own quotes
would close the attribute.)

**Trade-off:** rendering a kit component through Mesa's `renderComponent`
directly now leaves the placeholder and drops the Outlook fallback. Use
`renderEmail` / `renderEmailFile`. A test pins that behaviour rather than
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
