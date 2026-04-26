---
title: utils:qrcode
description: Generate a QR code image from a URL
alias: qrcode
examples:
  - fli qrcode https://example.com
  - fli qrcode https://frontierjs.com --dry
args:
  -
    name: url
    description: URL to encode as a QR code
    required: true
---

<script>
// NOTE: requires `qrcode` package — run `bun add qrcode` in your project
// or `bun add -g qrcode` to install globally.
// TODO: add qrcode to fli's own dependencies once confirmed in use.

const slugify = (url) => url
  .toLowerCase().trim()
  .replace(/\s+/g, '-')
  .replace(/[^\w-]+/g, '')
  .replace(/--+/g, '-')
  .replace(/^-+|-+$/g, '')
</script>

```js
let QRCode
try {
  QRCode = (await import('qrcode')).default
} catch {
  log.error('qrcode package not found — run: bun add qrcode')
  return
}

const filename = slugify(arg.url.replace(/https?:\/\//, '')) + '.png'

if (flag.dry) {
  log.dry(`Would generate QR code → ${filename}`)
  return
}

await new Promise((resolve, reject) => {
  QRCode.toFile(filename, arg.url, { scale: 24 }, (err) => {
    if (err) reject(err)
    else resolve()
  })
})

log.success(`QR code saved: ${filename}`)
echo(filename)
```
