# frontierjs-vscode — layout

The file-by-file map of `frontierjs-vscode`, moved out of `CLAUDE.md` so a turn in this package does not pay for it. `CLAUDE.md` keeps the owners and the traps; hazards are `hazards.md`.

```
src/
  extension.ts        activation — registers both clients
  litestone/
    client.ts         the VS Code side
    server.ts         the language server — diagnostics, completion, hover
    format.ts         the formatter — whitespace only, refuses its own output otherwise
  mesa/
    client.ts
    completions.js · hover.js · symbols.js
test/
  lsp-client.js       an LSP client over stdio — the Litestone suite's driver
  lsp.test.js · mesa.test.js · snippets.test.js · grammar.test.js
  vscode-stub.js      a stand-in editor, so the Mesa providers run under node
scripts/
  build-parser.js     litestone's parser → out/litestone/parser-bundle.js
  bundle.js           the two packaged entry points → self-contained CJS
  verify-package.js   packs, unpacks, tests the artefact
icons/                frontierjs.png (marketplace) · mesa.png · litestone.png (file icons)
syntaxes/ · snippets/ · language-configuration/
out/                  build output, not source
```

