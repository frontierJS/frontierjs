# Testing

Mesa gives you two ways to test a component. Render it to a string and assert on
the HTML, which is fast and needs no browser. Or drive it in a real Chrome, which
is the only way to test what a person does: type, click, tab, go offline.

## Render to a string

For what a component prints given some props, render it on the server path. See
[`@frontierjs/mesa/render`](../reference/render.md). It needs `happy-dom` in your
app.

```mesa
<script>
  export let name = 'world'
  export let count = 0
</script>

<h1>Hello {name}</h1>
<p>{count} items</p>
```

```js
import { initRenderer, renderToHTML } from '@frontierjs/mesa/render'

initRenderer()                                       // before the import
const { default: Greeting } = await import('./Greeting.mesa.js')

const html = await renderToHTML(Greeting, { name: 'Ada', count: 3 })
expect(html).toContain('Hello Ada')
```

Order matters. A compiled component builds its templates when its module loads,
so the DOM must exist before the `import()`. You also need your bundler or test
runner to compile `.mesa` files, as the [Vite plugin](vite-hmr-devtools.md) does.

A server render does not run `$.onMount`, and a `$.after` timer arms nothing.
Anything that reacts to input belongs in a drive.

To render straight from source with no bundler, use `renderFile` from
`@frontierjs/mesa/render-component`.

## Browser drive

`@frontierjs/mesa/drive` launches a real Chrome over the DevTools protocol. It has
no dependencies. Chrome is `$FJS_CHROME` when that is set, otherwise the first of
`google-chrome`, `google-chrome-stable`, `chromium` and `chromium-browser` on
`PATH`, then the macOS app bundles.

Start your dev server, then drive it:

```js
import { openChrome } from '@frontierjs/mesa/drive'

const page = await openChrome({ profile: 'test/.profile' })
await page.navigate('http://localhost:8700/', 'window.__ready')
await page.clickAt('button[type=submit]')
await page.type('ada@example.com')
await page.press('Enter')
const title = await page.evaluate(`return document.title`)
if (page.errors.length) throw new Error(page.errors.join('\n'))
await page.close()
```

`navigate(url, ready)` waits until the `ready` expression is truthy. Without it,
you are asserting against a page that may not have rendered.

### Send input the browser trusts

Use `clickAt`, `fill`, `type` and `press`. A `KeyboardEvent` you construct and
dispatch yourself is not trusted: it moves no focus, types no character and
dismisses no popover, so a test built on it passes while the real path is broken.

### Read `errors` after every step

`page.errors` holds what the page threw, its `console.error` calls, and any
console warning that starts with `[Mesa]` (a render the framework survived but
corrupted). A component that throws while rendering still leaves a partial tree,
so an assertion about what is there can pass over the top of the failure.

`page.failed` holds `'<status> <url>'` for each response of 400 and above. It is
separate because a signed-out page asking for its account gets a 401 by design.

### Wait for an expression, not a time

A state change updates the DOM on a microtask, so poll for the result:

```js
await page.clickAt('#add')
await page.waitFor(`document.querySelectorAll('li').length === 3`, { label: 'three rows' })
```

`waitFor` answers the expression's value, and fails with your label after `ms`
(a Vite update takes seconds, so give it a larger `ms`).

### Hold time still

Timers on Mesa's clock (`$.after`, `$.every`, `$.sleep`) can be held:

```js
const page = await openChrome({ clock: true })
await page.navigate('http://localhost:8700/')
await page.fill('#search', 'ada')
await page.clock(300)                 // an `$.after` debounce fires now, not after a real wait
```

A raw `setTimeout` is not on that clock, which is why the compiler warns about one.
See [Timers and measuring](../runtime/timers-and-measuring.md) and
[`drive`](../reference/drive.md#the-page-clock).

### A second page

`newPage(url, ready)` opens another page whose errors land in the same `errors`
array. Use it to test two tabs talking over `BroadcastChannel`, which one tab
posting and listening to itself proves nothing about.

### Keep the profile for offline tests

By default each launch gets a fresh temporary profile. IndexedDB, Cache Storage,
the service worker and OPFS live in the profile, so a test that closes and
reopens an offline app needs `profile: 'some/dir'`. Two browsers cannot hold one
profile at once. `close()` waits for Chrome to exit, so reopening after it is safe.

## Taking the network away

`createNetwork` switches Chrome's offline mode, and adds what the emulation
leaves out: **an open WebSocket keeps carrying frames**, so going offline also
closes the sockets the page opened. A Vite HMR socket is left alone, because
closing it reloads the page onto Chrome's offline screen. Call it before the
first navigation, so the page's sockets are registered.

```js
import { openChrome, createNetwork } from '@frontierjs/mesa/drive'

const page = await openChrome()
const net  = await createNetwork(page)
await page.navigate('http://localhost:8700/')
await net.withOffline(async () => {
  // the network refuses, and the app's socket is closed
})
await net.waitOnline()   // the browser, then the app's socket reconnecting
```

`goOffline()` answers how many sockets it closed, or `null` when the page loaded
before `createNetwork`. `withOffline(fn, { sever: false })` leaves the socket
open, which is how a real outage looks in its first seconds.

The emulation is per page, so a `newPage()` stays online, and a service worker's
own network is not covered.

## Skip when there is no Chrome

```js
import { findChrome } from '@frontierjs/mesa/drive'

if (!findChrome()) {
  console.log('skipped: no Chrome on this machine')
  process.exit(0)
}
```

No Chrome is a fact about the machine, not about your app, so a drive that would
rather skip than fail asks first.

## Check what the page owes

`PAGE_AUDIT` is an expression that returns the page-level accessibility problems:

```js
import { PAGE_AUDIT } from '@frontierjs/mesa/drive'

const problems = await page.evaluate(`return ${PAGE_AUDIT}`)
if (problems.length) throw new Error(problems.join('\n'))
```

## Two traps

- **Run the app you mean to test.** A dev server serves the code it started with.
  Start it yourself, and refuse a port that already answers.
- **Never return a bare `null` from `evaluate`.** The protocol drops it and it
  reads back as `undefined`. Return an object.

---

Reference: [`@frontierjs/mesa/drive`](../reference/drive.md) · [`@frontierjs/mesa/render`](../reference/render.md)
