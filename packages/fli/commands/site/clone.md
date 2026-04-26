---
title: site:clone
description: Clone a site repo from github.com/kobamisites into $SITES_DIR
alias: clone
examples:
  - fli clone my-site
  - fli site:clone client-website --dry
args:
  -
    name: name
    description: Site repo name (from kobamisites org)
    required: true
---

<script>
import { existsSync } from 'fs'
import { join } from 'path'
</script>

```js
const sitesDir = context.env.SITES_DIR || '~/projects/sites'
const sitePath = join(sitesDir, arg.name)

if (!existsSync(sitePath)) {
  log.info(`Cloning kobamisites/${arg.name} → ${sitePath}`)
  context.exec({
    command: `git clone git@github.com:kobamisites/${arg.name} ${sitePath}`,
    dry: flag.dry
  })
} else {
  log.info(`${sitePath} already exists — skipping clone`)
}

log.info(`Site path: ${sitePath}`)
echo(sitePath)
```
