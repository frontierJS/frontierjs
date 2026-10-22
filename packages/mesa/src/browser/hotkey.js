/*
 * hotkey.js — #5, one key binding: `hotkey('<Mod-k>', fn, { scope, when })`.
 *
 * Sugar over `keys()` (`FJS-D1388`): every hotkey on one root is a keymap in
 * that root's one `keys()` attachment, so the engine, the 720ms ambiguity and
 * the text-field rule are `@frontierjs/toolbelt/keys`'s, and a sequence (`gd`)
 * works as a chord does.
 *
 * ─── Where it listens ────────────────────────────────────────────────────
 *
 * With `scope`, on the nearest delegation root above it (Invariant 11), so it
 * answers only while focus is inside that mounted tree; without, on
 * `document`. The root is read at the call, so a scoped hotkey is bound from
 * an attachment or `onMount`, once the element is in the tree.
 *
 * ─── Two on one key ──────────────────────────────────────────────────────
 *
 * The newest answers, as an earlier keymap in `keys()`'s `active` does: two
 * open overlays each binding `<Esc>` close the top one first, and disposing it
 * hands the key back. `when` is a getter read at each key; false parks the
 * binding, so the key falls to the one under it or to the page.
 *
 * A chord the spelling refuses throws here, at the call, and so does one a
 * browser or the OS takes before the page (`<Mod-w>`, `<C-Tab>`), on either
 * platform, so a binding that is dead for some users fails on every machine.
 * Under a server render
 * nothing is bound and the dispose is a no-op; on a terminal or a phone the
 * call throws (`host.js`) — a terminal binds through `@frontierjs/mesa/keys`.
 */
import { keymap, browserOwned } from '@frontierjs/toolbelt/keys'
import { delegationRootOf } from '../runtime.js'
import { keys } from '../keys.js'
import { live } from './host.js'

const _roots = new Map()   // root → { bindings: newest first, detach }

/** `hotkey(chord, fn, { scope, when })` → dispose. */
export function hotkey(chord, fn, { scope, when } = {}) {
  if (typeof fn !== 'function') throw new TypeError(`hotkey(${JSON.stringify(chord)}, fn): fn is required`)
  if (when !== undefined && typeof when !== 'function') {
    throw new TypeError(`hotkey(${JSON.stringify(chord)}): when is a getter, read at each key`)
  }
  const map = keymap({ [chord]: (_, e) => fn(e) })
  const [owned] = browserOwned(map)
  if (owned) throw new TypeError(`hotkey(${JSON.stringify(chord)}): ${owned.reason}`)
  if (!live('hotkey()')) return () => {}

  const root = scope ? delegationRootOf(scope) ?? document : document
  let entry = _roots.get(root)
  if (!entry) {
    const bindings = []
    const active = () => bindings.filter((b) => !b.when || b.when()).map((b) => b.map)
    entry = { bindings, detach: keys(() => ({ active: active() }))(root) }
    _roots.set(root, entry)
  }
  const binding = { map, when }
  entry.bindings.unshift(binding)

  return () => {
    const i = entry.bindings.indexOf(binding)
    if (i < 0) return
    entry.bindings.splice(i, 1)
    if (entry.bindings.length) return
    entry.detach()
    _roots.delete(root)
  }
}
