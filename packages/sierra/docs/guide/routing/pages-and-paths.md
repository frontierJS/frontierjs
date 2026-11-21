# Pages and paths

The route table is derived from the file tree, and nothing is registered by hand. A lowercase `.mesa` or `.md` file is a page, and its path is its URL.

```js
import { scan } from '@frontierjs/sierra/scanner'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'sierra-'))
mkdirSync(join(root, 'src/routes/blog'), { recursive: true })
mkdirSync(join(root, 'src/routes/(auth)'), { recursive: true })
for (const file of ['index.mesa', 'about.mesa', 'blog/[slug].mesa', '(auth)/login.mesa'])
  writeFileSync(join(root, 'src/routes', file), '<h1>Hello</h1>')

const tree = await scan('src/routes', { cwd: root })

const paths = tree.children.map(node => node.path)
if (tree.path !== '/') throw new Error(`expected the index at /, got ${tree.path}`)
if (paths.join() !== '/about/,/blog/:slug/,/login/') throw new Error(`unexpected paths ${paths}`)
```

## What else it can do

- `index.mesa` is its folder's page and adds no URL segment
- `[leadId].mesa` is `/leads/:leadId/` and reads as `page.params.leadId`
- `[...rest].mesa` is a catch-all, `docs/[...rest].mesa` is a catch-all below a folder, and a static or `[param]` sibling wins first
- `(auth)/` is a group folder and adds nothing to the URL
- `.md` files route exactly like `.mesa` files
- `_module.mesa` is a layout, and a PascalCase or `_`-prefixed file is a component that is never routed
- `about.meta.js` is the companion that holds `meta`, `load` and `getStaticPaths` for `about.mesa`
- `trailingSlash: 'always' | 'never' | 'preserve'` sets the URL form
- `*.mount.js` routes the files of another directory as if they sat beside it

**In depth:** [Sierra README § Routing](../../../README.md#routing), [§ Path syntax](../../../README.md#path-syntax)
