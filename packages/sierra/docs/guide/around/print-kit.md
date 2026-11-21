# PDFs and images with print-kit

`@frontierjs/print-kit` turns an HTML document into a PDF and an element into a PNG, in one headless Chromium. It needs Chrome or Chromium on the machine, so this page does not run its example.

```ts
import { createPrinter, printDocument } from '@frontierjs/print-kit'

const printer = createPrinter()
const html    = printDocument({ title: 'Invoice 12', body: '<h1>Invoice 12</h1>' })
const pdf     = await printer.pdf(html)
await printer.close()
```

## What else it can do

- `printDocument` also takes `css` sheets, a `lang` and a `page` spec for paper size and margin boxes
- `printer.png(html, '#chart')` captures one element as an image
- `app.use(printer())` in a Junction app claims `app.printer`, so a service or a job can print
- With no Chrome on the machine the app refuses to boot, by name
- The page runs offline with scripts off, so a URL in it cannot make the server fetch anything
- `@frontierjs/print-kit/print.css` is the stylesheet every printed document carries, with page groups and break rules
- The browser is opened on the first job and shared after that

**In depth:** [print-kit README](../../../../print-kit/README.md)
