# frontierjs-vscode — package map

**Editor support.** A Litestone language server (`.lite`) plus Mesa editor
support. Uses **npm**, not bun: `npm run build`.

> **The compiler is resolved by probing, not by a fixed path.** `core/parser.js`
> then `parser.js` under each base, because the parser's location inside
> litestone has moved once and a single hardcoded path fails the build.

---

## Where things are

`docs/layout.md` is the file-by-file map; read it when a change touches a file
this list does not name. The owners that matter on most turns:

- `src/extension.ts` activation — registers both clients.
- `src/litestone/server.ts` the language server (diagnostics, completion, hover) · `src/litestone/client.ts` the VS Code side · `src/litestone/format.ts` the whitespace-only formatter.
- `src/mesa/client.ts` registers vscode providers directly; `src/mesa/{completions,hover,symbols}.js` are plain JS.
- `scripts/build-parser.js` bundles litestone's parser and catalog into `out/litestone/` · `scripts/bundle.js` makes the two entry points self-contained CJS · `scripts/verify-package.js` proves the `.vsix`.
- `test/lsp-client.js` drives the Litestone suite over stdio · `test/vscode-stub.js` stands in for the editor so the Mesa providers run under node.
- `syntaxes/` · `snippets/` · `language-configuration/` · `icons/`; `out/` is build output, not source.

## What bites here

The fifteen that bite most; the full catalog is `docs/hazards.md`, read it
before touching the server, the resolver, a grammar, the icons or packaging.

- **`parse()` returns `schema: null` on any syntax error** — the normal state while typing. Every read is `result?.schema?.x`; schema-derived completions appear only when the WHOLE document parses.
- **`parse()` resolves no imports, so the server splices them itself** (`withImports()`), rooted at the open BUFFER; an import that resolves to nothing is NOT reported.
- **Block detection is a stack of all block kinds, not a per-keyword counter** (`isInsideBlock`) — a counter goes negative after any earlier block.
- **Completion context reads the text left of the caret, never the whole line** (`attrToken`, `inArgsOf`).
- **What the language contains is asked of litestone's catalog, never listed here** — a hand-written inventory hid a quarter of the language; `test/lsp.test.js` asserts the offered set against the bundle.
- **A document is parsed by the APP's litestone, the bundle is the fallback** (`FJS-1404`) — `parserFor()` walks up to the nearest `node_modules/@frontierjs/litestone`; only `parse` and the import splice move over.
- **Never synthesize an attribute name from a bare word** — `wordAt()` scans back through `@`; anything unprefixed is not an attribute.
- **`allowJs` is load-bearing**, and **the providers are `import`ed, not `require`d** — without either, Mesa throws at activation or on the first hover, where nothing tests it.
- **`await import(p)` cannot load the compiler** — tsc rewrites it to `require()`; the specifier must be opaque: `new Function('specifier', 'return import(specifier)')`.
- **The compiler is the workspace's own, resolved at runtime** (`@frontierjs/mesa`, entry `src/compiler.js`); the extension-root fallback is `context.extensionPath`, never `__dirname`.
- **Only a QUOTED name in a compiler message names a variable** — a word-boundary match underlined `let a = 1`.
- **`$name` in a snippet BODY is a VS Code variable** and an unknown one expands to nothing; every literal `$` is `\\$` (`test/snippets.test.js`).
- **A grammar fails in complete silence** — a rule that matches nothing colors nothing; only `test/grammar.test.js` grades a `.tmLanguage.json`.
- **Emmet in `.mesa` is three separate failures** — an object setting a user already has REPLACES `emmet.includeLanguages` whole, suggestions need `[mesa]` `showExpandedAbbreviation: always`, and Tab loses to `insertBestCompletion` on keybinding weight; a user keybinding is the answer and this package ships none.
- **The formatter may change whitespace and nothing else** (`FJS-1341`) — `formatLite` refuses any output whose tokens differ from the input.
- **Packaging cannot use vsce's dependency walk** — bun's symlinks escape the extension root, so `vscode:prepublish` runs `scripts/bundle.js`; `parser-bundle.js` must sit beside `server.js`. `out/` is build output; a locally installed `mesa-language-support` copy may be what the dev host is showing.

---

## Proving a change

**`npm test`** — four suites over the built output. It builds
first on purpose: a stale `out/` tests the previous fix and reads as "the change
did not work".

### Litestone — over real LSP/stdio

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

### Mesa — against the built `out/mesa/`

- `test/vscode-stub.js` — stands in for the editor (`Module._load` intercepts
  `require('vscode')`), because there is no protocol to drive these providers
  over and the alternative, `@vscode/test-electron`, downloads a VS Code build
  per run. **The compiler is the real one**: the defect the suite exists for was
  a resolver hunting a renamed package, which a fake compiler resolves happily.
- `test/mesa.test.js` — activation, all five compiler-resolution routes and the
  none-found case, diagnostics from analysis errors and from a `compile()` that
  throws, the debounce, and each of the three providers.

### Grammars — tokenized with `vscode-textmate`

`test/grammar.test.js` loads the real `.tmLanguage.json` and asserts SCOPES.
Every case is paired with the shape one character away — `module` beside
`defer`, `<script>` beside `<scripture>` — because a rule that swallowed
everything satisfies any assertion that only asks about the case that broke.
The corpus row is the half the hand-written cases cannot make: every
`<script…>` open tag in every `.mesa` file in the workspace, graded per BLOCK,
since most files carry a module block AND a plain one and a per-file check is
answered by whichever one still works.

`source.js` and `source.css` are empty stubs — VS Code supplies them. They
cannot be left unresolved: a block whose `patterns` is nothing BUT an
unresolvable include is dropped whole, so `<style>` reported as broken for a
reason that existed only in the harness.

Mutation-checked: reverting `script-block`'s begin to `(<)(script)(>)` reds 6.

### Snippets — no build needed

`test/snippets.test.js` walks every body of both snippet files: a `$` must be
escaped, a tabstop, or one of the 33 real VS Code variables. It exists because
the editor's own complaint arrives once, in a log, naming nothing.

Mutation-checked too: dropping `allowJs` reproduces
`Cannot find module './hover'` at activation, and turning the opaque dynamic
import back into `await import(p)` turns every resolution case red.

`npm run test:nobuild` skips the build while iterating. For anything none of the
suites can show you, load the extension in a VS Code dev host (F5) — and
uninstall the older `mesa-language-support` copies first.

**`npm run verify:package`** proves the ARTEFACT rather than the tree: it packs,
unpacks the `.vsix` somewhere with no `node_modules` above it, checks every icon
and grammar `package.json` names is inside, that neither bundle bare-requires
something unshipped, and that the Mesa providers and the opaque dynamic import
survived bundling — then runs four suites against the UNPACKED copies
(`FJS_LSP_SERVER`, `FJS_MESA_CLIENT` and `FJS_SYNTAXES` point them at any copy).
Run it after touching `package.json`, the bundle, the icons or a grammar — a `.vsix` that builds is not an
extension that runs, and the marketplace is where that difference shows up.

<!-- layout-named: the file names fli done grades a new module against, kept here because done.js reads this file by path. The map itself is docs/layout.md.
build-parser.js bundle.js catalog-bundle.js client.js client.ts completions.js extension.js 
extension.ts format.ts hover.js package.json parser-bundle.js server.js server.ts symbols.js 
verify-package.js
-->
