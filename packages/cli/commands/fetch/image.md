---
title: fetch:image
description: Fetch an image URL and print the blob info
alias: fimg
examples:
  - fli fimg https://example.com/photo.jpg
  - fli fetch:image https://example.com/photo.png
args:
  -
    name: url
    description: Image URL to fetch
    required: true
---

```js
const url = [':', '/'].includes(arg.url[0])
  ? 'http://localhost' + arg.url
  : arg.url

log.info(`Fetching image: ${url}`)

const res  = await fetch(url, {
  headers: { Accept: 'image/*', 'User-Agent': 'fli' }
})
const blob = await res.blob()
echo(JSON.stringify({ type: blob.type, size: blob.size }, null, 2))
```
