---
title: fetch:json
description: Fetch a URL and print the JSON response
alias: fget
examples:
  - fli fget https://api.example.com/users
  - fli fetch:json :3000/api/health
  - fli fetch:json https://api.example.com --method POST
args:
  -
    name: url
    description: URL to fetch (prefix with : or / for localhost)
    required: true
flags:
  method:
    char: m
    type: string
    description: HTTP method
    defaultValue: GET
---

```js
// Allow :3000/path shorthand for localhost
const url = [':', '/'].includes(arg.url[0])
  ? 'http://localhost' + arg.url
  : arg.url

log.info(`${flag.method} ${url}`)

const res  = await fetch(url, { method: flag.method })
const data = await res.json()
echo(JSON.stringify(data, null, 2))
```
