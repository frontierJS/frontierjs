/*
 * @frontierjs/mesa/browser — the browser APIs every app wraps by hand, wrapped
 * once, each on `subscribe(start)` from the runtime.
 *
 * A wrapper is one of four shapes — signal, object, attachment, action — and
 * answers by the host rule in `host.js`: the live value in a tab, its default
 * under a server render with nothing subscribed, and a throw naming itself on
 * a terminal or a phone (`FJS-D1097` Q6). `dt`, `at` and `ago` touch no browser
 * API and answer on every host. The plan and its order is
 * `IDEAS/browser-kit.md`; `browser.d.ts` beside this file states each
 * wrapper's server answer.
 */
export { persisted } from './persisted.js'
export { now } from './clock.js'
export { media, reducedMotion, colorScheme } from './media.js'
export { setPrefix } from './prefix.js'
export { tab } from './tab.js'
export { hotkey } from './hotkey.js'
export { dt, at, ago } from './datetime.js'
