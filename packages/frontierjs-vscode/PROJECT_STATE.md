# frontierjs-vscode — Project State
## Last updated: 2026-08-27

> **Picking up cold?** Read the repo-root `HANDOFF.md` first, then this
> package's `CLAUDE.md` — its *What bites here* section is the trap list, and
> every bullet in it is a defect that shipped.

**Green, installable, and ready to publish — nobody has run `vsce publish` yet.**
The two things that were blocking are both settled: the `frontierJS` publisher
exists on the marketplace and holds no extensions, and the manifest points at the
real repository.

---

## Where it stands

| | |
|---|---|
| Litestone (`.lite`, `.litestone`) | Language server — diagnostics, completions off Litestone's own catalog, hover, go-to-definition, formatting, imports spliced from disk. Complete for what the parser exposes |
| Mesa (`.mesa`) | Highlighting, snippets, hover, completions, outline. Diagnostics work where the workspace's own `@frontierjs/mesa` resolves. **Not a language server** — plain vscode providers, no second process |
| Packaging | `vscode:prepublish` bundles with esbuild, because vsce's dependency walk follows bun's symlinks above the extension root. `npm run verify:package` proves the artefact rather than the tree |
| Published | **No.** See below |

The extension is installed locally as `frontierjs.vscode-frontierjs`, and both
suites are run against that copy as well as against the tree and the unpacked
`.vsix` — a green suite over `out/` cannot see whether an editor loads it, which
is how this package sat uninstalled while every check passed.

---

## Publishing

The `frontierJS` publisher exists and is empty, so `vscode-frontierjs` would be
its first extension. What remains is one credential and one command:

```bash
npx vsce login frontierJS     # paste an Azure DevOps PAT with Marketplace > Manage
npm run publish               # vsce publish --no-dependencies
```

**The manifest publisher must match the marketplace ID exactly** — `frontierJS`,
capital JS. It was `frontierjs` until 2026-08-27 and would have been rejected
against the PAT.

`vscode:prepublish` runs the build and the esbuild bundle, so `npm run publish`
cannot ship a stale `out/`. Run `npm run verify:package` first anyway: it is the
only check that proves the artefact rather than the tree.

`"private": true` does not block `vsce publish` — vsce 2.32 reads it nowhere —
and is worth keeping, because it does block `npm publish`.

Everything else the marketplace asks for is in place: a 128×128 RGBA icon, a
LICENSE, a `CHANGELOG.md`, declared `capabilities`, `repository`/`bugs`/
`homepage`, and `engines: ^1.85.0` — new enough that the empty
`activationEvents` is filled implicitly from `contributes.languages`.

**The first publish burns the version.** `0.1.0` cannot be republished with
different bytes; a fix after it is `0.1.1`.

---

## Test suite

`npm test` builds first on purpose — a stale `out/` tests the previous fix.

| Suite | Assertions | What it drives |
|---|---|---|
| `test/lsp.test.js` | 46 | The built server over real LSP/stdio, one process for the run |
| `test/mesa.test.js` | 36 | The providers against a stubbed editor, with the REAL compiler |
| `test/snippets.test.js` | 6 | Every `$` in every body of both snippet files |

`npm run test:nobuild` skips the build while iterating. `FJS_LSP_SERVER` and
`FJS_MESA_CLIENT` point the first two at any copy — an unpacked `.vsix`, or the
one installed in an editor.

`npm run verify:package` packs, unpacks somewhere with no `node_modules` above
it, checks the icons and bundles, and then runs both suites against the unpacked
copies. Run it after touching `package.json`, the bundle or the icons.

---

## Known gaps

- **The Litestone server embeds an understanding of `.lite` that the real parser
  owns.** A schema-language change is a change in two places, and this is the one
  that gets forgotten.
- **Mesa has no go-to-definition and no formatting.** Litestone has both.
- **`documentSelector` is `scheme: 'file'` only**, so an untitled buffer gets no
  language server.
- **Nothing here runs in a real editor.** `@vscode/test-electron` downloads a VS
  Code build per run, so the providers are driven against `test/vscode-stub.js`
  instead. For anything neither suite can show you, F5 a dev host.
