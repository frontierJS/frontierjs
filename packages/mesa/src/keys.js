/*
 * keys.js — @frontierjs/mesa/keys: the active keymaps on an element, as an
 * attachment a browser tab and a terminal both run (`IDEAS/keys.md` Phase 2,
 * `FJS-D1388`).
 *
 *   <main {@attach keys(() => ({
 *     active: [sceneMap, shellMap],
 *     on: (action, arg, e) => run(action, arg),
 *   }))}>
 *
 * The engine is toolbelt's `/keys`; this file is the host half of it. A key is
 * read by `chordOf`, as `e.key` and the modifier flags. The argument is a getter,
 * as `rowlist`'s is, read at each key: the keymaps active NOW answer, so a
 * scene swapping its table needs no new attachment.
 *
 * A key a binding took, or one that leaves a sequence pending, is
 * `preventDefault`ed, so a field never types it and a listener after this one
 * sees it was somebody's. A key already prevented clears what was pending and
 * is not read, since an inner keymap answered it first. A key typed into a
 * text control stays the control's unless it carries Ctrl, Alt or Cmd
 * (`FJS-D1386`); the attachment's own element is exempt, because a keymap on
 * an editable is that editable's own. A press inside an IME composition is
 * the composition's.
 *
 * A key after a pending sequence is the sequence's: one that continues
 * nothing is prevented and fires nothing, as vim's `d` swallows a key that is
 * no motion and khat's engine answers Unhandled, so no keymap or listener
 * after this one reads it alone.
 *
 * An action named by a string goes to `on(action, arg, e)`; a function in
 * the table is called as `fn(arg, e)`. `e` is absent when the ambiguity
 * timeout fires it.
 *
 * On a terminal the runtime steps the attachment before it makes the
 * keydown (`stepKeys` in `runtime-terminal.js`), innermost first and ahead of
 * the shell's keys, so a page's sequence is read before the shell renames
 * h j k l, and a key it took is never made a keydown: no listener hears it,
 * where a browser's later listener reads it prevented. There `e.typing` is
 * false in the shell's NORMAL, where no field is a text context.
 *
 * In a browser a keymap binding a chord the browser or the OS takes first
 * (`<Mod-w>`, `<C-Tab>`, toolbelt's `browserOwned`) throws: at the attach for
 * the keymaps active then, and at the first key for one that arrives later.
 * A terminal delivers those chords, so it reads none of them.
 */
import { step, flush, browserOwned, chordOf } from '@frontierjs/toolbelt/keys'
import { isBrowserClient } from './runtime.js'

/** `keys(() => ({ active, on }))` — an attachment. */
export function keys(options) {
  if (typeof options !== 'function') {
    throw new TypeError('keys(() => ({ active, on })): the argument is a getter, read at each key')
  }
  return (el) => {
    const browser = isBrowserClient()
    if (browser) refuseOwned(options().active)
    const mac = isMac()
    let state = null
    let timer = null
    let text = false

    const contextOf = (o) => ({ active: o.active, mac, text })

    function settle(next, now) {
      state = next
      clearTimeout(timer)
      timer = state?.due === undefined ? null : setTimeout(due, Math.max(0, state.due - now))
    }

    function due() {
      timer = null
      const o = options()
      const now = Date.now()
      const { state: next, outcome } = flush(state, contextOf(o), now)
      settle(next, now)
      if (outcome?.action !== undefined) fire(o, outcome)
    }

    function keydown(e) {
      if (e.isComposing || e.keyCode === 229) return
      if (e.defaultPrevented) { settle(null, 0); return }
      const target = e.composedPath?.()[0] ?? e.target
      text = e.typing !== false && target !== el && editable(target)
      const o = options()
      if (browser) refuseOwned(o.active)
      const now = Date.now()
      const was = state
      const { state: next, outcome } = step(state, chordOf(e), contextOf(o), now)
      settle(next, now)
      if (!outcome && was && !next) { e.preventDefault(); return }
      if (!outcome || outcome.typed !== undefined) return
      e.preventDefault()
      if (outcome.action !== undefined) fire(o, outcome, e)
    }

    const off = typeof el.__hostKeys === 'function'
      ? el.__hostKeys({ keydown, active: () => options().active })
      : (el.addEventListener('keydown', keydown), () => el.removeEventListener('keydown', keydown))
    return () => {
      off()
      clearTimeout(timer)
    }
  }
}

// Each keymap is read once; one that is not a keymap is left to step's refusal.
const _checked = new WeakSet()

function refuseOwned(active) {
  if (!Array.isArray(active)) return
  for (const km of active) {
    if (_checked.has(km) || !km?.mac?.exact) continue
    const [owned] = browserOwned(km)
    if (owned) throw new TypeError(`keys(): ${owned.reason}`)
    _checked.add(km)
  }
}

function fire(o, { action, arg }, e) {
  if (typeof action === 'function') return action(arg, e)
  if (typeof o.on !== 'function') {
    throw new TypeError(`keys(): '${action}' fired and the getter gave no on(action, arg, e) to run it`)
  }
  o.on(action, arg, e)
}

// The input types a letter cannot type into.
const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden'])

// Read off `tagName` and `type`, which a terminal node carries as a DOM
// element does, so one rule answers on both targets.
function editable(n) {
  if (!n || typeof n.tagName !== 'string') return false
  if (n.isContentEditable) return true
  if (n.tagName === 'TEXTAREA' || n.tagName === 'SELECT') return true
  return n.tagName === 'INPUT' && !NOT_TEXT.has(n.type)
}

// A terminal emulator keeps Cmd for its own menu and never sends it, so
// `<Mod-…>` is Ctrl there whatever the OS.
function isMac() {
  if (!isBrowserClient()) return false
  const nav = globalThis.navigator
  return /Mac|iPhone|iPad|iPod/.test(nav?.userAgentData?.platform ?? nav?.platform ?? '')
}
