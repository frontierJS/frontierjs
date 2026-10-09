# @frontierjs/print-kit

An HTML document to a PDF, an element to a PNG, in one headless Chromium
behind one seam. Built on `@frontierjs/mesa/drive`, so an app that prints
adds no second Chrome driver.

```js
import { createPrinter, printDocument, printerPlugin } from '@frontierjs/print-kit'

const printer = createPrinter()            // opens Chrome on the first job
const html    = printDocument({ title, body, css, margins })
const pdf     = await printer.pdf(html)    // Uint8Array
const png     = await printer.png(html, '#chart')
await printer.close()
```

In a Junction app, `app.use(printerPlugin())` claims it as `app.printer`;
with no Chrome on the machine the app refuses at boot, by name.

**The page runs offline, scripts off.** The document is built from landed
data, which is somebody else's: a URL in it cannot make the server fetch
anything, and markup in a name reaches nothing.

`./print.css` is the stylesheet every printed document carries after the
app's own: page groups, break rules, margin boxes.

## Requirements

- Chrome or Chromium on the machine (`findChrome()` from mesa's drive).
- `pdftotext` (poppler) for the suite's text assertions; tests needing
  it skip by name when absent.

## Where it came from

Incubated in the Transit prototype as `@transit/print-kit` (its `PLAN.md`
Q7) and moved here under `FJS-D811` once a second app imported it.
