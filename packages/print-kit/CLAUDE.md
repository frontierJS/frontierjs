# print-kit — package map

**`@frontierjs/print-kit`** — one headless Chromium render worker behind one
seam: a document to a PDF, an element to a PNG. Sits above mesa exactly as
`email-kit` does; imports nothing from junction at runtime.

`bun run test` — bun's runner over `print-kit.test.js`, which needs nothing,
then `test/run.mjs`, which **needs Chrome and `pdftotext`**: no Chrome skips the
run with a line saying so, no pdftotext skips each row that reads text by name,
so 24 passing with nothing skipped is the only green.

---

## Layout

```
index.js         public API
index.d.ts       the types, by hand — the kit is plain JS
src/printer.js   createPrinter() → { pdf, png, close } · printer() → app.printer
src/document.js  printDocument(), pageRules(), marginContent(), cssString()
src/print.css    the print sheet every document carries after the app's own
test/            print-kit.test.js (no browser) · run.mjs + specs/ (a real Chrome)
```

---

## What bites here

- **One tab serves 25 jobs, then is replaced.** Node ids a tagged table names
  count up across the jobs a tab has run, so a consumer must not keep one.
- **A call that goes unanswered for 30 s discards the browser, and nothing
  more is asked of it** — not to close the tab, and the job does not wait for
  the drive's close. Each of those calls waits out its own 30 s against a
  wedged browser, which held the queue 93 s and failed the two jobs behind it
  (`FJS-2230`). The job queued behind a wedge still waits the 30 s.
- **The print page is offline under `createNetwork`** — a template that
  fetches a font or an image from a URL gets nothing, by design. Inline it.
- **`printer` must not import junction at runtime.** It exports the plugin
  protocol's shape and takes its name with `app.own('printer', …)`, and
  `index.d.ts` types it by augmenting junction's `App` (Invariant 5). Junction
  is an optional peer and a devDependency because a `.d.ts` augmentation
  whose module does not resolve is dropped without an error: delete the
  devDependency and this typecheck still passes, while `app.printer` goes
  untyped in every app.
- **Margin boxes are text the page context draws**, so what `print.css`
  sets on `@page` is the only styling they inherit.

## Which drive proves a change

`bun run test` here. A consumer end to end is the Transit prototype's
`api/test/render.test.ts` and lago's `api/test/pdf.test.ts`
(`fjs-prototypes/`, not in this repo); `example` sends no PDF yet.
