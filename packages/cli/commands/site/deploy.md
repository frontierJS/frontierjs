---
title: site:deploy
description: Ship the built site to the Cloudflare Worker named for its siteUrl
alias: site-deploy
examples:
  - fli site:deploy
  - fli site:deploy --preview
  - fli site:deploy --preview round-2
flags:
  preview:
    type: string
    description: Upload a review build as a version of the Worker, aliased by the git branch or this name
  wrangler-dry:
    type: boolean
    description: wrangler's --dry-run — bundle the Worker and upload nothing
    defaultValue: false
---

What ships is the `dist/` the last `fli site:build` wrote, never a rebuild, so
a deploy after a drive ships the build the drive passed. Sierra's Cloudflare
adapter writes the wrangler config from `config/sierra.config.js`: the Worker
is `siteUrl`'s host with dots as dashes, served at that host as a custom domain
(`FJS-D1213`). The site states nothing else, and keeps no `wrangler.jsonc`.

**A production deploy claims `siteUrl`'s host.** Where that zone is on the
signed-in Cloudflare account, the deploy takes the domain from whatever
answers it now, so before a cutover ship previews only. A preview
is a version of the same Worker, uploaded and never deployed, at
`<alias>-<name>.<account>.workers.dev` (`FJS-D1221`, `FJS-D1222`). It needs a
review build, and a production deploy refuses one: the build stamps source
paths a public page must not carry.

Wrangler is the app's own, and signs in as whoever runs this.

```js
const preview = flag.preview !== undefined
// A bare --preview reaches a string flag as 'true', and means the git branch.
const alias = preview && flag.preview !== 'true' ? ` ${flag.preview}` : ''

$.exec({
  command: `${$.bin('sierra', $.paths.site)} site --deploy` +
    (preview ? ` --preview${alias}` : '') +
    (flag['wrangler-dry'] ? ' --dry' : ''),
  cwd: $.paths.site,
  dry: flag.dry,
})
```
