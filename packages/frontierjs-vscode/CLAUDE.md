# frontierjs-vscode — package map

**Editor support.** A Litestone language server (`.lite`) plus Mesa editor
support. Uses **npm**, not bun: `npm run build`.

> **`npm run build` is green as of 2026-08-06.** It used to fail on a stale
> parser path; the resolver now probes `core/parser.js` then `parser.js` under
> each base, because the parser moved into `litestone/src/core/`.

---

## Layout

```
src/
  extension.ts        activation — registers both clients
  litestone/
    client.ts         the VS Code side
    server.ts         the language server — diagnostics, completion, hover
  mesa/
    client.ts
    completions.js · hover.js · symbols.js
test/
  lsp-client.js       an LSP client over stdio — the Litestone suite's driver
  lsp.test.js · mesa.test.js · snippets.test.js
  vscode-stub.js      a stand-in editor, so the Mesa providers run under node
scripts/
  build-parser.js     litestone's parser → out/litestone/parser-bundle.js
  bundle.js           the two packaged entry points → self-contained CJS
  verify-package.js   packs, unpacks, tests the artefact
icons/                frontierjs.png (marketplace) · mesa.png · litestone.png (file icons)
syntaxes/ · snippets/ · language-configuration/
out/                  build output, not source
```

---

## What bites here

- **`parse()` returns `schema: null` on any syntax error** — which is the normal
  state while a schema is being typed. Every read must be `result?.schema?.x`.
  The outer `?.` alone is not enough, and the compiler will not catch it if the
  type says non-null. Corollary the tests below encode: **schema-derived
  completions (enum and model names) only appear when the WHOLE document
  parses**; a half-typed field anywhere means scalar types only.
- **`parse()` resolves no imports, so the server splices them itself.** A schema
  that imports a package's models (`import "@frontierjs/auth/schema.lite"`) was
  parsed as if those models did not exist, and every reference to one was an
  error the author could not remove — a relation pointing at it, or an
  `extend model` of it. `withImports()` reads the children with node's `fs` and
  resolves them through the parser's OWN `resolveImportSpecifier`, so the editor
  follows a bare specifier to the same file `parseFile` does. The ROOT is the
  open BUFFER, not the file on disk: an unsaved edit is the state the author is
  looking at. **Ranges are unaffected** — `makeDiagnostic` searches the open
  document's text for the name in the message and never uses a line number — so
  an error about an imported model lands at line 0 rather than at a wrong line.
  Feature-detected off the bundle, like the catalog, so an older litestone still
  gets a server. An import that resolves to nothing is NOT reported: the package
  may simply not be installed here, and a squiggle on a line the author cannot
  act on is worse than a schema that describes less. It went unseen for as long
  as it existed because basecamp — the one real schema in this suite with
  imports — had hand copies instead until 2026-08-24.
- **Block detection is a stack of all block kinds, not a per-keyword counter**
  (`isInsideBlock`). A counter that only increments on its own keyword but
  decrements on every `}` goes negative after any earlier block — an `enum`
  above the models killed completion for the whole rest of the file.
- **Completion context reads the text left of the caret, never the whole line.**
  `attrToken` = typing an attribute name, `inArgsOf` = inside that attribute's
  arguments. A line-wide `includes('@')` looks right until you notice most real
  field lines already carry an attribute, at which point the type list is gone.
- **What the language contains is asked of litestone's catalog, never listed
  here.** `scripts/build-parser.js` bundles `core/catalog.js` beside the parser
  into `out/litestone/catalog-bundle.js`, and `server.ts` derives completion from
  it. The lists that used to be written out in `server.ts` offered 50 field
  attributes against the catalog's 55 and 15 model attributes against 22, and
  never offered `tenancy`, `view`, `trait` or `type` at all — so completion
  silently hid a quarter of the language for as long as anyone had been using it.
  A hand-written inventory has no way to be wrong out loud. `test/lsp.test.js`
  now asserts the offered set against the bundle, so it cannot drift back.
- **The extension bundles litestone, it does not depend on it.** Same mechanism
  as the parser, same three-base resolver, no `exports` entry and no runtime
  dependency — which is why adding this changed nothing in `exports.snapshot.md`.
  A checkout whose litestone predates the catalog falls back to a short built-in
  list rather than failing to start.
- **`ATTR_DOCS` still wins on hover where it has an entry** — it is longer, has
  worked examples and explains the reasoning. The catalog is what the other 29
  words get, which is the difference between hovering `@system` and hovering
  nothing at all. Where the catalog answers, it contributes the two facts prose
  keeps getting wrong: where the word is legal, and what its arguments accept.
- **`@from`'s first argument is the model name, PascalCase** — `@from(Lead, …)`.
  litestone's docs used to show the lowercase form, which does not parse. Probe
  the parser before copying a doc example into a completion list.
- **Never synthesise an attribute name from a bare word.** Hover used to try
  `word`, `'@'+word`, `'@@'+word`, so `function slug(…)` documented itself as
  the `@slug` transform — as would any model or field named `trim`, `email`,
  `url`. `wordAt()` already scans back through `@`, so an attribute arrives
  prefixed; anything unprefixed is not one.
- **Mesa is not a language server** — it registers vscode providers directly, so
  there is no stdio protocol to drive it over and no separate process. It is
  loaded from `extension.ts` like the Litestone client.
- **`allowJs` is load-bearing.** `mesa/{hover,completions,symbols}.js` are plain
  JS; without it tsc emits none of them and the first `require('./hover')` throws
  at activation, which is why Mesa was switched off for months.
- **The providers are `import`ed, not `require`d.** esbuild leaves a computed
  require alone, so a bundled `.vsix` would ship without them and throw on the
  first hover — where nothing tests it.
- **`await import(p)` cannot load the compiler.** tsc under `module: commonjs`
  rewrites it to a `require()`, and `require()` of mesa's ESM throws in the
  extension host. The specifier has to be opaque to both compilers:
  `new Function('specifier', 'return import(specifier)')`.
- **The compiler is the workspace's own, resolved at runtime** — the package is
  `@frontierjs/mesa` with its entry at `src/compiler.js`. It was
  `@mesa/compiler/compiler.js` when the resolver was written, so every candidate
  missed and diagnostics silently offered to be configured instead. The
  extension-root fallback comes from `context.extensionPath`, never `__dirname`:
  that is `out/` bundled and `out/mesa/` from tsc, two different depths.
- **Only a QUOTED name in a compiler message names a variable.** Matching a
  declared variable on a word boundary anywhere in the message underlined
  `let a = 1` for `bind:group={missing} — 'missing' must be a top-level let
  variable`, because "must be a top-level" contains a standalone `a`.
- **`$name` in a snippet BODY is a VS Code variable, and an unknown one expands
  to nothing.** `"$onCleanup(() => { $2 })"` inserted `(() => { })` — the call
  gone, the text silently swallowed. Both languages here write `$` as ordinary
  text, so every literal one is `\\$`. The editor's only complaint is one line in
  the extension host log at startup naming neither snippet nor file; the test is
  `test/snippets.test.js`. A `prefix` is exempt — it is typed, not expanded.
- **A locally installed copy contributes the same `mesa` language id, and one of
  the two wins.** Two older `mesa-language-support` builds sat in
  `~/.vscode/extensions` for months, so what an editor showed was not necessarily
  this tree. Check that directory before believing a dev host.
- **The Litestone server embeds an understanding of `.lite`** that the real
  parser owns (`packages/litestone/src/core/parser.js`). Any schema-language
  change is a change in two places, and this is the one that gets forgotten.
- **`out/` is build output.** Editing it looks like it works until the next build.
- **Packaging cannot use vsce's dependency walk.** bun installs
  `vscode-languageclient` and friends as symlinks into the workspace root's
  `.bun` store, so vsce follows them above the extension root and refuses with
  `invalid relative path: extension/../../…`. `--no-dependencies` packs, and
  ships an extension whose first `require()` throws where nothing tests it —
  so `vscode:prepublish` runs `scripts/bundle.js`, which rewrites
  `out/extension.js` and `out/litestone/server.js` as self-contained CJS.
  `vscode` stays external (the host provides it) and so does
  `out/litestone/parser-bundle.js` — `server.js` require()s it by a computed
  path and it must sit beside it.
- **The icons are RASTER and the repo holds no source for them.** They were cut
  from three 1536x1024 design sheets, which are kept on disk as
  `icons/*.image-ref.png` and are ignored by BOTH git and vsce — so a fresh
  clone has the icons and not the sheets, and `icons/*.png` is the master
  wherever you are. There is no `frontierjs.svg` and no `convert` line any more:
  the pipeline that note described produced the three-line placeholder these
  replaced. Sizes are what the sheet held — the art is never upscaled, so
  `mesa.png` and `litestone.png` are odd-sized square canvases (168, 166) with
  the tile centred at its native pixels rather than resampled into a round
  number. The marketplace icon must be 128x128 and is the one that was scaled.
- **A file icon has to survive 16px, and most of that sheet did not.** The
  explorer renders these at 16 and the extension's own frontiersman is mud at
  that size — a hat and a coat need more pixels than a tree row has. The two
  that ship are silhouettes with one idea each (a sun behind a butte, a feather)
  and were chosen by rendering them at 16 on both a dark and a light ground
  rather than by looking at the sheet. Check any replacement the same way.
- **One PNG serves both `light` and `dark`.** Both file icons carry their own
  dark document ground, which reads on either theme; the pair exists in the
  manifest because the schema is a pair. `@frontierjs/css`'s theme classes have
  nothing to do with it.
- **Whether a language icon is SHOWN is the file icon theme's decision, not
  this manifest's.** A theme that maps `.mesa` itself wins, and Seti — the
  default — maps by extension and falls through to its own generic file. So an
  icon that is correct here can be invisible in an editor, and the only way to
  know is to look at one. Nothing in `npm test` or `verify:package` can see it:
  both check that the FILE is shipped and named, which is the half that used to
  be wrong.
- **There are two changelogs and the marketplace reads only one.** `CHANGELOG.md`
  is the name the Changelog tab is generated from and no other name works, so it
  ships in the `.vsix`; `CHANGES.md` is the engineering history and is
  `.vscodeignore`d, along with `PROJECT_STATE.md`. Writing an entry in
  `CHANGES.md` alone changes nothing a user of the extension ever sees. The fifth
  root markdown file is answered by an allowance in `scripts/ci-allowances.json`.
- **`capabilities` is a security statement, not metadata.** Mesa diagnostics load
  the workspace's OWN compiler and call it, so `untrustedWorkspaces.supported` is
  `false` — an extension declaring nothing is disabled in a restricted workspace
  anyway, which is the right behaviour reached by accident rather than a stated
  one. `virtualWorkspaces` is `false` because the server is a node process and
  both languages resolve through the filesystem.

## Proving a change

**`npm test`** — three suites, 88 assertions, over the built output. It builds
first on purpose: a stale `out/` tests the previous fix and reads as "the change
did not work".

### Litestone — 46 assertions over real LSP/stdio

- `test/lsp-client.js` — a small LSP client (Content-Length framing, requests
  correlated by id, `openDoc()` resolves on the diagnostics notification). No
  sleeps, one server process for the whole run.
- `test/lsp.test.js` — the cases. Diagnostics, the null-schema mid-keystroke
  state, block detection, caret-aware attributes, hover, formatting, imports
  spliced from disk, and both real app schemas in the repo.

Every case there is a defect that shipped. **A document that fails to parse is a
case worth asserting, not invalid input** — it is what the editor sees on almost
every keystroke, and it is what used to take the server down.

The suite is mutation-checked: reverting `isInsideBlock`, the caret-aware
attribute detection, or the null-schema guards each turns it red (the last one
reproduces the original `Cannot read properties of null (reading 'models')`).

### Mesa — 36 assertions against the built `out/mesa/`

- `test/vscode-stub.js` — stands in for the editor (`Module._load` intercepts
  `require('vscode')`), because there is no protocol to drive these providers
  over and the alternative, `@vscode/test-electron`, downloads a VS Code build
  per run. **The compiler is the real one**: the defect the suite exists for was
  a resolver hunting a renamed package, which a fake compiler resolves happily.
- `test/mesa.test.js` — activation, all five compiler-resolution routes and the
  none-found case, diagnostics from analysis errors and from a `compile()` that
  throws, the debounce, and each of the three providers.

### Snippets — 6 assertions, no build needed

`test/snippets.test.js` walks every body of both snippet files: a `$` must be
escaped, a tabstop, or one of the 33 real VS Code variables. It exists because
the editor's own complaint arrives once, in a log, naming nothing.

Mutation-checked too: dropping `allowJs` reproduces
`Cannot find module './hover'` at activation, and turning the opaque dynamic
import back into `await import(p)` turns every resolution case red.

`npm run test:nobuild` skips the build while iterating. For anything neither
suite can show you, load the extension in a VS Code dev host (F5) — and
uninstall the older `mesa-language-support` copies first.

**`npm run verify:package`** proves the ARTEFACT rather than the tree: it packs,
unpacks the `.vsix` somewhere with no `node_modules` above it, checks every icon
`package.json` names is inside, that neither bundle bare-requires something
unshipped, and that the Mesa providers and the opaque dynamic import survived
bundling — then runs both suites against the UNPACKED copies (`FJS_LSP_SERVER`
and `FJS_MESA_CLIENT` point them at any copy). Run it after touching
`package.json`, the bundle or the icons — a `.vsix` that builds is not an
extension that runs, and the marketplace is where that difference shows up.
