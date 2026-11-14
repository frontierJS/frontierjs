# Timers and measuring

Timers are declared, not armed by hand. Mesa starts and cancels them with the
component, and a test can hold its clock still.

```mesa
<script>
  let query = ''
  let results = []
  let visible = true

  async function search(q) {
    results = q ? [q] : []
  }
  async function load() {
    results = []
  }

  $.after(300, () => search(query), { key: query })   // a debounce
  $.every(5000, load, { when: visible })              // a poll, paused while hidden
</script>

<input bind:value={query}>
<mesa:document onvisibilitychange={() => visible = !document.hidden} />
<p>{results.length} results</p>
```

## `$.after` and `$.every`

`$.after(ms, fn, opts?)` runs `fn` once, `ms` after the timer arms.
`$.every(ms, fn, opts?)` runs it every `ms`. Neither fires on arming; a poll that
should load at once calls `load()` beside it.

- `key`: when it changes, the timer is cancelled and armed fresh. That is a
  debounce.
- `when`: the timer is armed while it is true. Turning it false cancels it, and
  turning it true arms from scratch.

Both are cancelled when the component is destroyed. They must be top-level
statements of `<script>`; inside a function or a template they are a compile
error. A raw `setTimeout` or `setInterval` is a compile warning, because it is
off Mesa's clock and nothing cancels it.

## `$.sleep`

`await $.sleep(ms)` is the imperative form, for a handler or async function:

```js
async function save() {
  saving = true
  await $.sleep(600)
  saving = false
}
```

It never resolves once the component is destroyed, so code after it does not run
against a torn-down component.

## Measuring and focus

Each of these returns a Promise, so the same code runs in a browser, on a phone
and in a terminal:

- `await $.measure(el)` gives `{ left, top, right, bottom, width, height }`, or
  `null` if there is no node.
- `await $.viewport()` gives `{ width, height }`, the area a fixed box is placed
  against.
- `await $.focus(el)` resolves once focus has moved to `el`.

```js
const box = await $.measure(panel)
```

---

Spec: [VISION.md § 17](../../VISION.md#after-and-every--declared-timers) · RULE 65 · RULE 66
