# What the page did

A screen can look right and still have thrown. The page handle keeps what the browser saw: `page.errors` is what the page threw, its `console.error` calls and any Mesa warning, and `page.failed` is each response of 400 and above. `check.clean(step)` fails the step if either grew since the last clean, and `page.shot(path)` writes a PNG as evidence.

```js
import { existsSync } from 'node:fs'
import { drive } from '@frontierjs/testing/drive'

const PORT = 49232
const URL = `http://127.0.0.1:${PORT}/`
const html = '<title>Home</title><script>fetch("/account")</script>'
const server = `Bun.serve({ port: ${PORT}, fetch: (req) => new URL(req.url).pathname === '/account'
  ? new Response('no', { status: 401 })
  : new Response(${JSON.stringify(html)}, { headers: { 'content-type': 'text/html' } }) })`

await drive({
  servers: [{ name: 'app', cmd: ['bun', '-e', server], url: URL }],
  open: URL,
}, async (page, check) => {
  check.allow(/401 .*account/)
  check.clean('loading the page')

  await page.shot('./home.png')
  check('the screenshot was written', existsSync('./home.png'))
})
```

`errors` and `failed` are separate on purpose: a signed-out page asks for its account and gets a 401 by design. `check.allow` names that one by pattern, and everything else still fails the step. Read `errors` after every step that can fail, since a component that throws mid-render leaves a partial tree and assertions about what is there still pass.

## What else it can do

- `check.clean` runs by itself after the last step, so a throw in the last step cannot slip out
- `page.evaluate(body)` runs the body of an async function in the page and `return` answers it; never return a bare `null`, wrap it in an object
- `page.newPage(url)` opens a second page whose errors land in the same `errors` array
- `openChrome({ clock: true })` holds the page's time still until `page.clock(500)`, `page.clock('settle')` or `page.clock('real')` moves it
- `createNetwork(page)` from `@frontierjs/mesa/drive` goes offline and back, and closes the page's sockets the way a real outage does
- `PAGE_AUDIT` is an expression that returns the page-level accessibility problems a machine can settle, such as `lang`, one `<main>` and one `<h1>`
- `page.downloads` is the directory every downloaded file lands in
- Focus is emulated, since a headless window would blur about thirty seconds in and `el.focus()` would then fire no `focus` event

**In depth:** [Mesa's drive](../../../../mesa/docs/guide/reference/drive.md), [Mesa's testing](../../../../mesa/docs/guide/misc/testing.md)
