# Layouts

A `_module.mesa` wraps every route beneath it, and layouts nest. A layout draws its page through `<slot />`, and its own frontmatter reaches the page.

```js
import { scan } from '@frontierjs/sierra/scanner'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'sierra-'))
mkdirSync(join(root, 'src/routes/blog'), { recursive: true })
writeFileSync(join(root, 'src/routes/_module.mesa'), '---\nsiteName: My App\n---\n<header>{page.siteName}</header>\n<main><slot /></main>')
writeFileSync(join(root, 'src/routes/blog/_module.mesa'), '<slot />')
writeFileSync(join(root, 'src/routes/blog/index.mesa'), '<h1>Blog</h1>')
writeFileSync(join(root, 'src/routes/login.mesa'), '---\nreset: true\n---\n<h1>Sign in</h1>')

const tree = await scan('src/routes', { cwd: root })
const blog = tree.children.find(node => node.path === '/blog/')
const login = tree.children.find(node => node.path === '/login/')

if (blog.layout !== 'src/routes/blog/_module.mesa') throw new Error(`expected the blog layout, got ${blog.layout}`)
if (blog.meta.siteName !== 'My App') throw new Error('expected the root layout frontmatter on the blog page')
if (login.meta.reset !== true) throw new Error('expected reset on the login page')
```

## What else it can do

- A layout's frontmatter is spread onto `page` for every route beneath it, so `{page.siteName}` works in the layout and the page
- `reset: true` in a route's frontmatter renders it with no layout
- Layouts load lazily, and only the chain a route needs is fetched before the route commits
- `<slot name="sidebar">` in a layout takes content a page [pushes up](named-slots.md)
- A `_module.meta.js` beside a layout contributes `meta` the same way its frontmatter does
- A route that throws while it renders is replaced by the nearest `failed` state, and the layouts above it stay standing

**In depth:** [Sierra README § Layouts](../../../README.md#layouts)
