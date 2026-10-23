# frontierjs-vscode — what bites here

The full hazard catalog for `frontierjs-vscode`, moved out of `CLAUDE.md`. The fifteen that bite most often stay there; this is every one, verbatim.

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
  act on is worse than a schema that describes less. This suite's own fixtures
  cannot see it: the one real schema in them with imports is basecamp's.
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
- **A document is parsed by the APP's litestone, the bundle is the fallback**
  (`FJS-1404`). An install's bundle is frozen at its build and its version
  never moved, so an old install called correct schemas broken. `parserFor()`
  walks up from the document to the nearest
  `node_modules/@frontierjs/litestone/src/core/parser.js` and imports it once
  per realpath — the Mesa client's opaque dynamic import, since `exports` has
  only an `import` condition and `require.resolve` misses it. Only `parse` and
  the import splice move over; the lexer and the catalog stay the bundle's. The
  Output channel says which parser each app got, and an edit to a linked
  litestone is read on the server's next start.
- **`ATTR_DOCS` still wins on hover where it has an entry** — it is longer, has
  worked examples and explains the reasoning. The catalog is what the other 29
  words get, which is the difference between hovering `@system` and hovering
  nothing at all. Where the catalog answers, it contributes the two facts prose
  keeps getting wrong: where the word is legal, and what its arguments accept.
- **`@from`'s first argument is the model name, PascalCase** — `@from(Lead, …)`.
  litestone's docs used to show the lowercase form, which does not parse. Probe
  the parser before copying a doc example into a completion list.
- **Never synthesize an attribute name from a bare word.** Hover used to try
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
- **A grammar fails in complete silence — no compiler, no runtime.** A rule that
  matches nothing colors nothing, which is the same picture as a file with
  nothing to color. `script-block` began `(<)(script)(>)` and so matched the
  bare tag alone: every `<script module>` — the data half of every Resource file
  in a Sierra app, 117 of them here — rendered as plain text with `module`
  reported as a boolean attribute. Both block rules take an attribute list now.
  A `.tmLanguage.json` is only graded by `test/grammar.test.js`, which tokenizes
  it; nothing else in this package reads one.
- **`configurationDefaults` for an OBJECT setting is defeated by any user who
  has that key at all.** The manifest contributes
  `emmet.includeLanguages: { "mesa": "html" }`, which is what gives `.mesa`
  Emmet — `table` + Tab. VS Code does not deep-merge an object setting across
  scopes: a `settings.json` carrying its own `emmet.includeLanguages` REPLACES
  the default whole, so a user with `svelte` and `twig` in there silently has no
  mesa mapping and no diagnostic anywhere says so. Nothing this package ships
  can fix that from its side; the answer is the key in their settings.
- **The mapping alone gives no Emmet SUGGESTIONS.** Emmet's completion
  provider returns early for any MAPPED language unless
  `showExpandedAbbreviation` is `always` — `(mapped || jsx) && value !==
  'always'` in its own source — so with the common
  `inMarkupAndStylesheetFilesOnly`, an abbreviation never reaches the suggest
  widget. The setting is `language-overridable`, so the manifest defaults
  `"[mesa]": { "emmet.showExpandedAbbreviation": "always" }` rather than
  changing it everywhere. A user with their own global value still needs the
  `[mesa]` block in their OWN settings — a language default does not outrank
  a user setting.
- **Neither of those is why Tab does nothing — the KEYBINDING loses on weight.**
  Emmet's Tab binding is registered at weight 100
  (`editor.emmet.action.expandAbbreviation`, `kbExpr` only
  `editorTextFocus && tabDoesNotMoveFocus && config.emmet.triggerExpansionOnTab`)
  and `insertBestCompletion` — the binding `editor.tabCompletion: "on"` turns on
  — at 190, so Tab triggers suggest and accepts the best word instead. The best
  word is the abbreviation the author just typed, so it re-inserts the same text
  and reads as nothing happening, which is why this is diagnosed as an Emmet
  configuration problem and never is. A USER keybinding outranks both:

      { "key": "tab", "command": "editor.emmet.action.expandAbbreviation",
        "when": "editorTextFocus && !editorReadonly && !editorTabMovesFocus &&
                 editorLangId == mesa && !suggestWidgetVisible && !inSnippetMode" }

  Safe, because Emmet runs a plain `tab` when it finds no abbreviation. This
  package ships no such binding — taking Tab for a language is the author's
  call, not an editor extension's. VSCodeVim is not involved: its own Tab
  binding is `vim.mode != 'Insert'`.
- **A locally installed copy contributes the same `mesa` language id, and one of
  the two wins.** Two older `mesa-language-support` builds sat in
  `~/.vscode/extensions` for months, so what an editor showed was not necessarily
  this tree. Check that directory before believing a dev host.
- **The Litestone server embeds an understanding of `.lite`** that the real
  parser owns (`packages/litestone/src/core/parser.js`). Any schema-language
  change is a change in two places, and this is the one that gets forgotten.
- **The formatter may change whitespace and nothing else** (`FJS-1341`). A line
  is aligned only if it OPENS a field at the model body's depth, and
  `formatLite` refuses any output whose tokens — through litestone's lexer,
  `tokenize` in `parser-bundle.js` — differ from the input. Reading every model
  line as `name type` plus attributes is what cut `-> paid` off every transition. The
  suite formats every `.lite` in the workspace with the aligner ALONE, so a
  misread shape fails there instead of being silently refused in an editor.
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
  the tile centered at its native pixels rather than resampled into a round
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
- **`CHANGELOG.md` is for the marketplace.** It is the name the Changelog tab is
  generated from and no other name works, so it ships in the `.vsix`; the
  engineering history is git (`FJS-D675`), and `PROJECT_STATE.md` is
  `.vscodeignore`d. The extra
  root markdown file is answered by an allowance in `scripts/ci-allowances.json`.
- **`capabilities` is a security statement, not metadata.** Mesa diagnostics load
  the workspace's OWN compiler and call it, so `untrustedWorkspaces.supported` is
  `false` — an extension declaring nothing is disabled in a restricted workspace
  anyway, which is the right behavior reached by accident rather than a stated
  one. `virtualWorkspaces` is `false` because the server is a node process and
  both languages resolve through the filesystem.
