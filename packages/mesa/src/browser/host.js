/*
 * host.js — the host rule, in one place (`IDEAS/browser-kit.md` § The host rule).
 *
 * A browser tab answers live. A server render answers the wrapper's default and
 * subscribes nothing, so the page prerenders what it hydrates to. A terminal or
 * a phone runs a reactive graph with no browser under it, and a default there
 * is a preference that never saves and a hotkey that never fires with nothing
 * said — so it throws, naming the wrapper (`FJS-D1097` Q6).
 *
 * The terminal engine plants a `window` holding only `requestAnimationFrame`,
 * so a `typeof window` test passes there; the runtime's flags are the answer.
 */
import { isBrowserClient, isClient } from '../runtime.js'

/** True in a tab, false under a server render; throws on a terminal or a
 *  phone. `name` is how a caller spells the wrapper — `persisted()`, `tab`. */
export function live(name) {
  if (isBrowserClient()) return true
  if (isClient()) throw new Error(`${name} has no terminal or native host — it is a browser wrapper (@frontierjs/mesa/browser)`)
  return false
}
