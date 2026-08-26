# Testing Shop Desk

An extension is proved in a browser profile, not against a dev server — there is
no URL to point a drive at, and the permissions being tested live in a manifest
the build emits.

```sh
bun run build:site         # the island runs on the PRERENDERED storefront
bun run verify:extension   # 13 assertions, in a throwaway Chrome profile
```

The drive starts the API and the storefront origin itself and builds the
extension on the way in — a stale `dist/chrome` is a run that passes against the
previous edit.

## Two things about the mechanism

**`--load-extension` loads nothing while a debugging port is open.** The page it
names answers `ERR_BLOCKED_BY_CLIENT`, which reads as a broken extension rather
than as a flag Chrome stopped honouring. The way in is CDP's
`Extensions.loadUnpacked`, behind `--enable-unsafe-extension-debugging` — and it
is also the only thing that answers the extension's **id**, which is a hash of
the directory's absolute path and therefore different on every machine.

**A popup page is not web-accessible**, so it cannot be reached by navigating a
tab. `Target.createTarget` at the extension URL is browser-initiated, which is
what a person opening the popup does.

## By hand

```sh
bun run build:extension    # → extension/dist/chrome/
bun run dev:extension      # watch + reload over the dev port (8410)
bun run audit:extension    # permissions declared vs. chrome.* actually called
```

Then **chrome://extensions → Developer mode → Load unpacked →
`extension/dist/chrome/`**; for Firefox, **about:debugging → This Firefox → Load
Temporary Add-on →** `extension/dist/firefox/manifest.json`.

What the drive cannot check:

- the service worker surviving being stopped (`chrome://serviceworker-internals`)
  — state kept in a module-level variable does not
- what the two web stores make of the manifest
