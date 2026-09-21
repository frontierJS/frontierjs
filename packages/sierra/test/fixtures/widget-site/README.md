# widget-site — a `widgets/` surface, driven on a page nobody here owns

What `target: 'widget'` produces, proved the only way it can be: build the
scripts, serve them from their own origin, load them into a plain HTML page with
a `<script src>`, and drive it in a real browser.

**This fixture is laid out as a real widget surface**, not as a test directory
that happens to hold `.mesa` files — same six folders as `web/`, same
`config/vite.config.js` + `config/sierra.config.js` pair, same place the built
output lands. A fixture in a shape no app has is a fixture that stops matching.

```
config/
  sierra.config.js        target: 'widget', prefix, outDir
  vite.config.js          the Vite root is the SURFACE root, one level up
src/
  Embeds/
    Counter.mesa          one file        → dist/embeds/Counter.js
    LeadForm/
      index.mesa          a directory     → dist/embeds/LeadForm.js
      Field.mesa          …its own part, and NOT a second widget
  styles/global.css       imported by LeadForm — folded into its script
test/
  host.html               the host page: no bundler, no framework, hostile CSS
  verify.mjs              the drive
dist/embeds/              the built scripts
```

`host.html` is written to be unhelpful on purpose — `button { background: red
!important }`, `label { display: none !important }`, `* { box-sizing:
content-box }` — because that is what a real page is, and a widget that is not
isolated only looks broken on somebody else's site.

**The widgets are served on a different origin from the host page.** The drive
starts `@frontierjs/sierra/widget/serve` — the module `sierra widgets --serve`
and the generated `widgets/deploy/` container both run — and fills the host
page's `{{EMBEDS}}` in with its URL. Same-origin is the one arrangement no
customer of a widget has, and it hides every CORS and cache answer the
deployment turns on.

Three things a host page can do, all covered: the element form
(`<mt-counter data-start="5">`), the selector form (`<div class="mt-counter">`,
for pages that predate the element and cannot be edited), and an element that
arrives after the script has already run (a tag manager, a CMS). `Counter.js` is
included twice, because a snippet pasted in two places must not produce two
widgets in one box.

```sh
bun run test:widgets        # from the sierra package root — builds, then drives
```

Needs Chrome on PATH, or `$FJS_CHROME`.
