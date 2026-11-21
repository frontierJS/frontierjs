# Other surfaces

A surface is one thing the app ships, in a directory of its own beside `db/`, with its own config, tests and release. The app is not only a web page: the same schema can feed an extension or a widget on someone else's site.

```bash
fli make:extension      # extension/ with config/, src/harbor, src/dock, test/, deploy/
fli dev:extension       # watch and reload over the dev port
fli make:widget Counter # widgets/ with one .mesa per embeddable script
```

```html
<!-- a page you do not own: no bundler, no init call -->
<mt-counter data-start="5"></mt-counter>
<script defer src="https://cdn.example.com/embeds/Counter.js"></script>
```

## What else it can do

- Each surface takes its own directory: `api/`, `web/`, `site/`, `widgets/`, `extension/`, `desktop/`, `mobile/` and `cli/`
- `site/` is a prerendered site, `widgets/` is embeddable scripts and `desktop/` wraps the web surface in a Tauri shell
- `extension/` is a browser extension built by Jetty, MV3-first and built for Chrome and Firefox from one source
- `jetty build`, `jetty dev`, `jetty audit` and `jetty manifest` are the bin, and `fli extension:build` and `fli extension:audit` wrap it
- Harbor is the extension's service worker, and it holds the one connection to the API
- A page in an extension uses the same `createResource`, handed `harborApp()` as its app
- A widget mounts in a shadow root, so the host page's CSS cannot reach it
- The `example/` app has every surface wired to one schema

**In depth:** [jetty README § Using it in an app](../../../../jetty/README.md#using-it-in-an-app), [Sierra README § Build targets](../../../README.md#build-targets), [example README § Layout](../../../../../example/README.md#layout)
