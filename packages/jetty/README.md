# @frontierjs/jetty

Browser extension framework for FrontierJS. MV3-first, Mesa-rendered, Junction-connected.

> **Status:** Phases 0–8 complete — **432 assertions pass across 10 phase files**
> (`bun run test`, which runs plain `node` over the phases in order).
> Foundational architecture, port protocol, Junction adapter, channels,
> Resources, Islands, dev tooling, Firefox parity, and permission audit + CLI
> are all shipped and tested. See [What's not yet done](#whats-not-yet-done) for
> what is still owed; `docs/future-refactors.md` has the planned post-launch
> work.

## What's here

```
src/
  define/        — defineHarbor, defineDock, defineOptions, definePier, defineIsland
  runtime/       — port protocol, PagePort, harbor registry, channel registry, mount, surfaces
  browser/       — typed cross-browser shim w/ permission errors + audit-miss warnings
  junction/      — adapter contract, default WS adapter, schema cache, auth flow
  resources/     — Sierra-shape API: createResource, createStore, hooks, login/logout
  island/        — content-script runtime: shadow DOM mount, UnoCSS mirror, page-script bridge,
                   chrome.scripting registration
  build/         — Vite plugin pipeline, manifest emitter, auto-gen, discover, config loader
  dev/           — dev WS server + client snippet + classifier, FJS port scheme, orchestrator

bin/
  build-ext.js   — production build CLI
  dev-ext.js     — dev mode CLI w/ file watching + WS broadcast

test/
  phase{0–8}.test.js  — 431 assertions across the architectural layers, run in
                        order by `bun run test`. Ten files (phase2.5 is one)
  fixtures/basic-ext/ — minimal smoke fixture (harbor + dock + 1 island)
```

## Build & test

This package supports both Node 20+ and Bun 1.3+. **`bun run test` runs plain
`node`** over the ten phase files in order — the runner is node, the launcher is
whichever you have.

```bash
bun install
bun run test                   # 431 assertions, all phases, under node
bun run test:bun               # the same phases under bun's runtime
bun run build:fixture          # Chrome build → dist/chrome/
bun run dev:fixture            # dev mode, Chrome only, WS on 8400

# npm works identically — the scripts are the same
npm install && npm test
```

Other build/dev targets: `build:fixture:firefox`, `build:fixture:both`,
`dev:fixture:both`, and `test:phase<n>` / `test:bun:phase<n>` to run one phase
on its own.

After `build:fixture`, load `test/fixtures/basic-ext/dist/chrome/` via
`chrome://extensions` → Developer mode → "Load unpacked".
After `build:fixture:firefox`, load `dist/firefox/` via `about:debugging`
→ This Firefox → Load Temporary Add-on → select `manifest.json`.

## Monorepo layout

This package lives at `packages/jetty/` in the FrontierJS monorepo. Siblings it
reaches for (when present):

- `packages/mesa/` — reactive runtime + compiler. Optional — jetty falls back to
  stub mount if missing, which **passes a `.mesa` file through as JavaScript**
  and fails later at Vite with a parse error inside the component. If a build
  reports `Unexpected JSX expression` at line 1, the compiler was not found.
- `packages/junction/` — WebSocket service client. Optional — jetty falls back
  to its built-in default WS adapter if missing.

Both are `optionalDependencies` (`file:../mesa`, `file:../junction`) with the
published ranges declared as peers, so an install succeeds whether the siblings
are in the tree or come from the registry. Re-install when one shows up.

**An app installs neither.** A surface has one `package.json`, at the app root,
so `@frontierjs/mesa` lives at `<app>/node_modules` and jetty's compiler lookup
walks up from `extension/` to find it — see [Using it in an app](#using-it-in-an-app).

## CLI tools

```bash
jetty-build-ext --root=. --browser=chrome|firefox|both [--verbose]
jetty-dev-ext   --root=. --browser=chrome|firefox|both [--verbose]
                                                       [--launch] [--start-url=URL]
jetty-info      --root=. [--browser=chrome]   # print structure summary
jetty-audit     --root=. [--browser=chrome]   # standalone permission audit
jetty-manifest  --root=. [--browser=chrome|firefox|both]  # print manifest only
```

## Permission audit

Set `permissions.audit` in `jetty.config.js`:

```js
permissions: {
  declared: ['storage', 'tabs'],
  audit:    'warn',  // 'warn' = log; 'strict' = fail build; false = off
}
```

The audit scans built bundles for `chrome.<ns>.*` / `browser.<ns>.*` calls,
maps each namespace to its required manifest permission, and reports:
- **missing** — APIs used but permission not declared
- **unused** — declared but no calls detected (candidate for removal)
- **unknown** — namespace not in the catalog (typo or new API)
- **dynamic** — `chrome[expr]` accesses that the audit can't resolve

Limits: the scanner uses string matching, not AST. Comments are stripped,
but minification can mangle access patterns. Framework-internal indirection
(jetty's own browser shim) is invisible to the audit by design — jetty
auto-adds the perms it needs (`scripting` when islands present).

## Browser support

Both Chrome and Firefox use Manifest V3. Differences jetty handles
automatically per `--browser` flag:

| Field                          | Chrome                   | Firefox                                  |
|--------------------------------|--------------------------|------------------------------------------|
| Background script              | `background.service_worker` | `background.service_worker` (default)<br>or `background.scripts[]` (opt-in) |
| Min browser version            | `minimum_chrome_version` | `browser_specific_settings.gecko.strict_min_version` |
| Stable extension ID (signing)  | n/a (Chrome assigns)     | `browser_specific_settings.gecko.id` (required for AMO) |
| `host_permissions`             | identical                | identical                                |
| `web_accessible_resources`     | identical                | identical                                |
| `permissions` / `options_ui`   | identical                | identical                                |

Firefox-specific settings live under `firefox: {...}` in `jetty.config.js`:
```js
firefox: {
  geckoId:          'my-extension@example.com',
  strictMinVersion: 121,
  // background: { useScripts: true }, // optional: classic scripts[] form
}
```

## Using it in an app

An app gets jetty as the **`extension/` surface** — a sub-project at the app root
beside `api/`, `web/` and `widgets/`, with the same six folders every sub-project
has. Root `README.md` § Project Structure is canonical.

```sh
fli make:extension          # config/, src/harbor, src/dock, test/, deploy/
fli extension:dev           # watch + reload over the dev port (8400)
fli extension:build         # → extension/dist/chrome/ (--browser both for Firefox too)
fli extension:audit         # permissions declared vs. chrome.* actually called
```

Those wrap the `jetty-*` binaries with `--root=extension`, so an app's build and
this package's tests are one program. `fli new --extension` adds the surface to
any template; `fli new --template extension-only` is a project whose whole
product is the extension — no `api/`, no `web/`.

**The app owns the install**, not the surface: one `package.json` at the app
root, so `@frontierjs/mesa` lives at `<app>/node_modules` and jetty's compiler
lookup walks up from the surface to find it.

## What's not yet done

- **AST-based audit.** The current audit uses string matching, which has
  known false negatives on framework-internal indirection and minified code.
  A swap to a real JS parser (acorn/swc) would catch both.
- **Junction native package.** jetty ships a default WS adapter as a fallback
  and nothing here talks to a real Junction yet (`FJS-279`). Mesa is no longer
  in this bracket: the compiler is found and used whenever the app that owns the
  surface has it installed, and the fixture's dock is a real Mesa component.

## Architecture references

- Spec: see `frontierjs-jetty-v1-spec.md` (last reviewed/patched during decision phase)
- Mesa vision: see `Mesa Vision & Specification v1.8` (informed Phase 3 integration)
- Sierra v0.1.0: studied to understand resource API. The pure logic is no longer
  duplicated — it is `@frontierjs/toolbelt/{jsonschema,hooks}` (`FJS-059`). The
  `@frontierjs/resources-core` package `docs/future-refactors.md` proposed was
  refused; that document now says why.

## FJS port scheme

Jetty's dev WS uses the FrontierJS port scheme:

```
[ENV] [CATEGORY] [PROJECT] [SERVICE]
  8       4         XX        X
```

- `8` = dev environment
- `4` = browser-extensions category
- `XX` = project slot (00–99, manually assigned per consumer extension)
- `X` = service slot (0 = primary dev WS, 1–9 reserved)

Jetty's own fixture uses `8400`. Consumer extensions assign their own
project slot in `jetty.config.js → dev.port` and jetty validates the range
at build time.
