# Sierra — package map

**UI meta-framework.** File-tree routing → a route table, a Vite build over the
Mesa compiler, `createResource` for talking to Junction, prerendering for the
`static` target, and a postbuild pipeline. Depends on Junction and Litestone
outputs; **nothing here may be imported by them** (Invariant 1).

`bun run test` — the runner is **vitest**. `bun run test:safety` is separate and
runs against a real Litestone client.

---

## Layout

```
src/
  index.js               — public entry

  scanner/               — routes dir → route tree
    walk.js              recursive directory walk
    classify.js          what each file is (page, layout, error, …)
    parse-frontmatter.js YAML frontmatter
    build-tree.js        the node tree
    generate-manifest.js writes config/routes.js

  router/                — the runtime router
    index.js, match.js, internals.js (used by RouterView.mesa),
    signals.js, prefetch.js, page-fields.js (the fields the router owns on `page`)

  build/                 — the Vite side
    index.js             createSierraViteConfig — start here
    mesa-plugin.js       Mesa compilation + reactivity hints
    scanner-plugin.js    runs the scanner
    schema-plugin.js     .lite → client-side model schemas
    slot-rewrite.js      compile-time slot rewriting
    prerender.js         routes declaring `render: static` → HTML
    island-bundle.js     one chunk per island the static build needs
    static-safety.js     proves a prerendered page is publishable
    warnings.js, dev-overlay.js, devtools-plugin.js, hmr-client.js, hmr-inject.js

  junction/              — the API seam
    index.js             WebSocket client integration
    resource.js          createResource — coerce → blankToNull → validate
    field-rules.js       schema → field rules; toFieldErrors. LEAF: no client import
    schema-registry.js   modelNameFor / schemaFor

  islands/loader.js      — find island markers in prerendered HTML and mount
  postbuild/             — sitemap, redirects, llms.txt, 404, theme, defer, markdown
  devtools/  presence/  theme/  analytics/  fetch/  virtual/
  components/            — RouterView.mesa, ChainRenderer.mesa
```

---

## What bites here

- **`createResource` coerces, blank-strips and validates by default.** A create
  that used to 400 at the server now throws `ResourceValidationError` in the
  browser with no request made, and an untouched text box writes NULL not `''`.
  Opt out with `{ validate: false }` — the test is `!== false`, so a
  threaded-through `undefined` does not disarm it.
- **`field-rules.js` is deliberately a leaf** — no Junction-client import, so it
  runs in plain Node and can be *compared* against Junction's server rules rather
  than being a copy of them. Keep it that way.
- **`find()` answers the list envelope; `findData()` is the rows.** And the FIRST
  argument to `find` is the filter — `find({ limit: 100 })` filters on a column
  named `limit`, which matches nothing and says nothing (`FJS-109`).
- **A prerendered route must prove its data is publishable.** Reads are tapped
  around `load()` and compared to `@@gate`, fail-closed; the escape is per-route
  `publishes: N` (FJS-081).
- **A mounted ancestor is authoritative** for nested islands — test a marker with
  `isConnected`, not `parentNode`.
- **Sierra exports no module-level signal, and the `externalSignals` map is
  gone** (`FJS-060`). State is plain objects — `page`, `status`, `theme` — that a
  component makes reactive with a `$:` path watch. A module-level signal would be
  reactive nowhere: a bare template read of one is only rewritten if the
  consuming build names it, by hand, in another package, and omitting an entry
  is silent. `tests/no-module-signals.test.js` asserts the absence. `signal()`
  survives for `presence(channelId)`, which returns one from a call.
- **The plugin passes `externalReactivityHints: 'strict'`.** An uncovered member
  read on an imported object is reported — Mesa's default only reports it when
  the file already watches some other path on the same import, which says nothing
  about the component that watches nothing, and that is the component that
  shipped the bug. Measured free: 0 warnings over all 218 `.mesa` in this repo.
  A deliberate one-time read says `var`.
- **A missing auto-import does not fail a build.** Mesa compiles a reference to
  an undefined name without complaint, so the symptom is a component that
  renders as nothing. Only what reached the bundle separates *injected* from
  *silently skipped* — `tests/auto-import-build.test.js` asserts on chunk
  content for that reason, and its assertions were checked against a negative
  control rather than trusted for passing.

## Proving a change

`bun run test` + `bun run test:safety`, then in `example/`: `verify` and
`verify:build` for router/resource/build; `verify:public` for anything touching
prerender, islands or static-safety. Root `CLAUDE.md` §Running things has the
full map.
