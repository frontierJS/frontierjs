# `@frontierjs/mesa/drive`

A real Chrome, driven over the DevTools protocol, for your app's own end-to-end
tests. It has no dependencies: the protocol runs over the global `WebSocket`.
For how to write a drive, see [Testing](../misc/testing.md).

```js
import { findChrome, openChrome, createNetwork, PAGE_AUDIT } from '@frontierjs/mesa/drive'
```

Types ship in the package.

## `findChrome`

```js
findChrome(): string | null
```

The Chrome binary, or `null`. It is `$FJS_CHROME` when that is set (and a
variable that points at nothing finds nothing), otherwise the first of
`google-chrome`, `google-chrome-stable`, `chromium` and `chromium-browser` on
`PATH`, then the macOS app bundles. Ask it first when a drive should skip on a
machine with no Chrome. `openChrome` throws instead.

## `openChrome`

```js
openChrome(options?: ChromeOptions): Promise<Chrome>
```

Launches Chrome, attaches to one page and answers the handle. The caller closes
it. A failed launch throws a sentence that names the fix and never exits your
process.

| Option | Default | Effect |
|---|---|---|
| `profile` | a temporary directory, removed on close | A directory you keep. IndexedDB, Cache Storage, the service worker and OPFS live in it |
| `bootstrap` | none | A script run before anything else in every document |
| `windowSize` | `'1280,900'` | `'width,height'` |
| `args` | `[]` | More Chrome flags. `--remote-debugging-port` and `--user-data-dir` are refused |
| `headed` | `false` | A real window on `$DISPLAY`, for what only a headed browser can do |
| `clock` | off | `true` or `{ at: epochMs }`. The first page holds its time still until the drive moves it |

### The handle

| Member | Does |
|---|---|
| `navigate(url, ready?)` | Loads `url` as a new document. `ready` is an expression polled until it is truthy |
| `evaluate(body)` | Runs the body of an async function in the page. `return` answers it. Never return a bare `null`; wrap it in an object |
| `waitFor(expr, { ms, every, label })` | Polls until `expr` is truthy and answers its value |
| `clickAt(selector)` | A trusted click at the element's center |
| `hoverAt(selector)` | Moves the pointer onto the element |
| `fill(selector, text)` | Replaces a field's text through the keyboard |
| `type(text)` | Types into the focused element |
| `press(key, modifiers?)` | A key press, such as `'Enter'` |
| `key(key, options?)` | A key press with `code`, `keyCode`, `modifiers` and `text` set by hand |
| `shot(path)` | Writes a PNG and answers the path |
| `newPage(url?, ready?)` or `newPage({ url, ready, clock })` | A second page with `evaluate`, `navigate`, `clock` and `close`. Its errors land in the same `errors` array |
| `errors` | A live array of what the page threw, its `console.error` calls and any `[Mesa]` warning |
| `failed` | A live array of `'<status> <url>'` for each response of 400 and above, the favicon aside |
| `downloads` | The directory every downloaded file lands in. Removed on close |
| `clock` | Moves a held page clock. See below |
| `on(method, fn)` | Subscribes to a protocol event. Answers the unsubscribe function |
| `cmd(method, params)` | A protocol call on the page |
| `send(method, params, sessionId?)` | A browser-level protocol call |
| `close()` | Closes Chrome and removes the temporary profile |

`errors` and `failed` are separate because a signed-out page asking for its
account gets a 401 by design. Read `errors` after every step that can fail: a
component that throws mid-render leaves a partial tree, and assertions about what
is there still pass.

Focus is emulated. A headless window would blur about thirty seconds in, and
after that `el.focus()` fires no `focus` event.

### The page clock

A page opened with `openChrome({ clock: true })` or `newPage({ clock: true })`
holds its time still. Everything on Mesa's clock (`$.after`, `$.every`,
`$.sleep`, debounce, transitions) waits until the drive moves it.

```js
await page.clock()                 // now, in epoch ms
await page.clock(500)              // run every timer due in the next 500 ms
await page.clock('settle')         // run one-shot timers until none is armed
await page.clock('real')           // virtual time follows real time again
await page.clock('hold')           // stop it again
```

`'settle'` throws naming what is still armed, since an `$.every` never settles,
unless you pass `{ allowArmed: true }`. A page that holds no clock throws on any
`clock` call.

## `createNetwork`

```js
createNetwork(browser: Chrome): Promise<Network>
```

Takes the network away, as DevTools' offline switch does, and also closes the
sockets the page opened. Call it before the first navigation, so the page's
sockets are registered. A Vite HMR socket is left alone.

| Member | Does |
|---|---|
| `goOffline()` | Goes offline. Answers how many sockets it closed, or `null` when the page loaded before `createNetwork` |
| `goOnline()` | Goes back online |
| `waitOnline({ tries, socket })` | Waits for the browser, then the app's socket reconnecting. Answers whether it did |
| `withOffline(fn, { sever })` | Runs `fn` offline and restores the network even if it throws. `{ sever: false }` leaves sockets open, like a real outage's first seconds |
| `severed` | How many sockets the last `goOffline` closed |

The emulation is per page, so a `newPage()` stays online, and a service worker's
own network is not covered.

## `PAGE_AUDIT`

```js
PAGE_AUDIT: string
```

An expression for `evaluate` that returns an array of the page-level
accessibility facts a machine can settle: `lang` on `<html>`, one `<main>`, one
`.skip-link` that is the first focusable element and points at a focusable
target, a name on each `<nav>` when there are several, one `<h1>`, and no
skipped heading level. An empty array means the page is in order. A page with no
`.skip-link` fails it, so it fits apps that follow that convention, as Sierra's
layout does.

```js
const problems = await page.evaluate(`return ${PAGE_AUDIT}`)
```

---

See [Testing](../misc/testing.md) for a worked drive.
