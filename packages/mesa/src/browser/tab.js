/*
 * tab.js — #8, three facts about this tab: `tab.online`, `tab.visible`,
 * `tab.focused`.
 *
 * `online` is `navigator.onLine`, the interface being up — wifi with no
 * upstream reads true. Whether the SERVER answers is the socket's to say, which
 * is why sierra's pending queue and offline warm arm on `connect` instead.
 *
 * ─── An object, read like session ───────────────────────────────────────
 *
 * A `.mesa` file reads an imported object through `watchProxy` and a
 * `$: tab.online` watch, the shape `session` and the router's `page` already
 * have, so a component writes `$: tab.online, () => sheets.load()` and gets
 * the handler on the change. Each fact is a getter with a guarded setter: the
 * listener writes through the proxy, which is what fires the watches, and a
 * caller writing one is refused — the browser says these, not the app.
 *
 * ─── Armed by the first read, held for the tab ──────────────────────────
 *
 * The listeners go on when a fact is first read, not at import, so a page that
 * imports the kit for `persisted()` adds none; once on they stay for the life
 * of the tab, one set shared by every reader — a watch keeps no reader count to
 * stop them by. Every event re-reads all three facts, so a tab restored from
 * the back-forward cache, which fires `visibilitychange`, also re-reads whether
 * it is online.
 *
 * Under a server render each fact is its default — online, visible, focused,
 * the page as the person who asked for it sees it — and nothing is armed. On a
 * terminal or a phone the first read throws by name (`host.js`).
 */
import { watchProxy } from '../runtime.js'
import { live } from './host.js'

const _v = { online: true, visible: true, focused: true }
let _armed = false
let _writing = false

function read() {
  return {
    online:  navigator.onLine,
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
  }
}

function sync() {
  const w = watchProxy(tab)
  const now = read()
  _writing = true
  try {
    for (const k in now) if (_v[k] !== now[k]) w[k] = now[k]
  } finally { _writing = false }
}

function arm() {
  if (_armed || !live('tab')) return
  _armed = true
  // Taken straight, not through the proxy: this runs inside the first read,
  // and nothing has seen a value from this module that it could contradict.
  Object.assign(_v, read())
  for (const ev of ['online', 'offline', 'focus', 'blur']) window.addEventListener(ev, sync)
  document.addEventListener('visibilitychange', sync)
}

function fact(key) {
  return {
    enumerable: true,
    get() { arm(); return _v[key] },
    set(v) {
      if (!_writing) throw new Error(`tab.${key} is the browser's to say — read it; it cannot be written`)
      _v[key] = v
    },
  }
}

/** This tab: `online`, `visible`, `focused`. Watched like `session` —
 *  `$: tab.visible` in a `.mesa` file, `watchPath(tab, 'visible')` in JS. */
export const tab = Object.defineProperties({}, {
  online:  fact('online'),
  visible: fact('visible'),
  focused: fact('focused'),
})
