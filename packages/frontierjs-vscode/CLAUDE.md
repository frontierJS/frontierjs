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
scripts/build-parser.js   the failing step
syntaxes/ · snippets/ · language-configuration/
out/                      build output, not source
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
- **Mesa support is syntax-only** — highlighting, snippets, symbols. There is no
  Mesa language server, so nothing here diagnoses a `.mesa` file. It is also
  **not loaded at all**: `startMesaClient` is commented out in `extension.ts`.
- **The Litestone server embeds an understanding of `.lite`** that the real
  parser owns (`packages/litestone/src/core/parser.js`). Any schema-language
  change is a change in two places, and this is the one that gets forgotten.
- **`out/` is build output.** Editing it looks like it works until the next build.

## Proving a change

**`npm test`** — 34 assertions driving the built server over real LSP/stdio.
It builds first on purpose: a stale `out/` tests the previous fix and reads as
"the change did not work".

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

`npm run test:nobuild` skips the build while iterating. For anything the
protocol cannot show you, load the extension in a VS Code dev host (F5) and open
a real `.lite` file.
