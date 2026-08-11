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
icons/                frontierjs.svg → frontierjs.png · litestone-{light,dark}.svg
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
- **Block detection is a stack of all block kinds, not a per-keyword counter**
  (`isInsideBlock`). A counter that only increments on its own keyword but
  decrements on every `}` goes negative after any earlier block — an `enum`
  above the models killed completion for the whole rest of the file.
- **Completion context reads the text left of the caret, never the whole line.**
  `attrToken` = typing an attribute name, `inArgsOf` = inside that attribute's
  arguments. A line-wide `includes('@')` looks right until you notice most real
  field lines already carry an attribute, at which point the type list is gone.
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
- **The marketplace PNG is generated, not drawn.** `icons/frontierjs.svg` is the
  source; regenerate after editing it with
  `convert -background none -density 384 icons/frontierjs.svg -resize 128x128 PNG32:icons/frontierjs.png`.

## Proving a change

**`npm test`** — three suites, 76 assertions, over the built output. It builds
first on purpose: a stale `out/` tests the previous fix and reads as "the change
did not work".

### Litestone — 34 assertions over real LSP/stdio

- `test/lsp-client.js` — a small LSP client (Content-Length framing, requests
  correlated by id, `openDoc()` resolves on the diagnostics notification). No
  sleeps, one server process for the whole run.
- `test/lsp.test.js` — the cases. Diagnostics, the null-schema mid-keystroke
  state, block detection, caret-aware attributes, hover, formatting, and both
  real app schemas in the repo.

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
