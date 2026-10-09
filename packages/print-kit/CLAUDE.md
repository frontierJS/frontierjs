# print-kit — package map

**`@frontierjs/print-kit`** — one headless Chromium render worker behind one
seam: a document to a PDF, an element to a PNG. Sits above mesa exactly as
`email-kit` does; imports nothing from junction.

`bun run test` — bun's runner, **needs Chrome and `pdftotext`**; the tests
that need either skip by name when it is missing, so 11 pass with 0 skipped
is the only green.

---

## Layout

```
index.js         public API
index.d.ts       the types, by hand — the kit is plain JS
src/printer.js   createPrinter() → { pdf, png, close } · printerPlugin() → app.printer
src/document.js  printDocument(), pageRules(), marginContent(), cssString()
src/print.css    the print sheet every document carries after the app's own
test/            the suite, against a real Chrome
```

---

## What bites here

- **One tab serves 25 jobs, then is replaced.** Node ids a tagged table names
  count up across the jobs a tab has run, so a consumer must not keep one.
- **A call that goes unanswered for 30 s discards the browser.** Once in six
  runs the two jobs after a wedge wedged the same way, so a failed print is
  not yet proven to stay a single failure (`FJS-2230`).
- **The print page is offline under `createNetwork`** — a template that
  fetches a font or an image from a URL gets nothing, by design. Inline it.
- **`printerPlugin` must not import junction.** It exports the plugin
  protocol's shape and claims with `app.claim('printer', …)` (Invariant 5).
- **Margin boxes are text the page context draws**, so what `print.css`
  sets on `@page` is the only styling they inherit.

## Which drive proves a change

`bun run test` here. A consumer end to end is the Transit prototype's
`api/test/render.test.ts` and lago's `api/test/pdf.test.ts`
(`fjs-prototypes/`, not in this repo); `example` sends no PDF yet.
