# jetty — package map

**A browser-extension app container.** Mesa UI in the extension surfaces, a
service worker relaying to Junction. `bun run test` runs **plain node** over ten
phase files in order — not bun, not vitest.

Its vocabulary is its own: **Harbor** (service worker), **Dock** (popup),
**Island** (content script), **Pier** (unlisted page), Options.
**jetty's "islands" are not Sierra's islands** — same word, different mechanism.

---

## Layout

```
src/
  define/        the five entrypoints — harbor · dock · island · pier · options
  build/         index.js (discovery → auto-gen → manifest → Vite) ·
                 discover · auto-gen · manifest · vite-config · config-loader ·
                 mesa-plugin · uno-plugin
  dev/           orchestrator · server (dev WS) · dev-client · dev-plugin ·
                 browser-launcher (web-ext) · classifier · fjs-ports.js
  island/        runtime · registration · page-script (MAIN world) · unocss-mirror
  junction/      adapter contract · default-adapter (PLACEHOLDER) · auth ·
                 schema-cache
  browser/       cross-browser API shim · permissions · idb
  audit/         permission audit — scan source for chrome.* / browser.* use
  resources/     jetty's own copy of Sierra's resources layer
bin/             build-ext.js · dev-ext.js
test/            phase0 … phase8
```

**`src/dev/fjs-ports.js` documents the whole-repo port scheme** —
`[env][category][project][service]`, extensions at 8400–8499 dev / 7400–7499 test.
It is the only place that scheme is written down.

---

## What bites here

- **One known failure**: the built `islands/demo.js` contains `import.meta`, and
  an MV3 content script is a *classic* script. Not a flake — a real packaging gap.
- **`default-adapter.js` is a placeholder**, and says so. Do not build on it as
  though it were the contract; `adapter.js` is.
- **`uno-plugin.js` and `unocss-mirror.js` predate Invariant 13** (no UnoCSS
  anywhere). Removing them is in scope; adding to them is not.
- **`resources/` is a copy of Sierra's**, and the HMR algorithm is copied here
  too — both are on the duplication list in the root `CLAUDE.md`. A fix in one
  is a fix owed in the other until they are merged.
- **The Junction event names here are hardcoded Feathers-style** and do not match
  what `callService` announces today.

## Proving a change

`bun run test` (all ten phases), plus `bun run build:fixture` and loading the
result — the failure above is exactly the kind a build that "succeeds" hides.
