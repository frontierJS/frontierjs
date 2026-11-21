# Driving a page

`drive()` is one call that owns a browser run. It starts each server in its own process group, waits for each URL, opens Chrome, runs your steps, and stops everything on a throw, on Ctrl-C and on exit. The file is its steps, and the exit code says whether they held.

```js
import { drive } from '@frontierjs/testing/drive'

const PORT = 49231
const URL = `http://127.0.0.1:${PORT}/`
const html = '<title>Home</title><button onclick="document.title = `Clicked`">Go</button>'

await drive({
  servers: [{
    name: 'app',
    cmd:  ['bun', '-e', `Bun.serve({ port: ${PORT}, fetch: () => new Response(${JSON.stringify(html)}, { headers: { 'content-type': 'text/html' } }) })`],
    url:  URL,
  }],
  open: URL,
}, async (page, check) => {
  check('starts on Home', await page.evaluate('return document.title'), 'Home')
  await page.clickAt('button')
  await page.waitFor(`document.title === 'Clicked'`)
  check('the click ran', await page.evaluate('return document.title'), 'Clicked')
})
```

A server's port is refused if it already answers: a running dev server serves the code it started with, so adopting one would grade another checkout's build or yesterday's. Every server named here is started by the run and killed by it.

## What else it can do

- `servers` is a list of `{ name, cmd, url, cwd?, env?, ms? }`, started together and each waited on until its `url` answers below 500, 30 seconds by default
- A server is killed as a group, because `bun run web` is a launcher whose child holds the port
- A server that never answers fails the run with the last lines it printed
- `open` is navigated to before the steps, and `ready` is an expression the page sets when its own boot has finished
- `check(label, got, want?)` compares deeply, or checks `got` is truthy when `want` is left out
- It prints a `✓` or `✗` line per check and returns `{ passed, failed }`, and sets `process.exitCode` from them
- Any other option is passed to `openChrome`: `profile`, `headed`, `windowSize`, `clock`
- `page.fill(selector, text)`, `page.type(text)`, `page.press(key)`, `page.hoverAt(selector)` and `page.navigate(url, ready?)` cover the rest of what a person does
- Mesa is an optional peer, so an app that only uses `createTestEnv` installs no browser driver
- `drive()` is the server half only; what the page can do belongs to `@frontierjs/mesa/drive`, whose page is the `page` your steps receive

**In depth:** [testing README § Driving the app in a browser](../../../README.md#driving-the-app-in-a-browser--frontierjstestingdrive), [Mesa's drive](../../../../mesa/docs/guide/reference/drive.md)
