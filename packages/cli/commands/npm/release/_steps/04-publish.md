---
title: 04-publish
description: Publish to npm
---

```js
const { root, pkg, tag, otp, newVersion } = $.config
const parts = [`npm publish --prefix ${root}`]
if (tag && tag !== 'latest') parts.push(`--tag ${tag}`)
if (otp) parts.push(`--otp ${otp}`)

log.info(`Publishing ${pkg.name}@${newVersion} → ${tag}`)
$.exec({ command: parts.join(' '), dry: flag.dry })
if (!flag.dry) log.success(`Published to npm`)
```
