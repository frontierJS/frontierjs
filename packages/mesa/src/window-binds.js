/*
 * window-binds.js — what `<mesa:window bind:prop>` binds, and the event that
 * moves each. Pure data, read by the compiler and by the runtime.
 *
 * The compiler refuses a prop not named here: bindWindow reads any other
 * once and listens for nothing, so `bind:screenX` would show the first value
 * forever and say nothing. Whether the network is up is `tab.online` in
 * `@frontierjs/mesa/browser`, the one spelling of it.
 */
export const WINDOW_BINDS = {
  innerWidth:       'resize',
  innerHeight:      'resize',
  outerWidth:       'resize',
  outerHeight:      'resize',
  devicePixelRatio: 'resize',
  scrollX:          'scroll',
  scrollY:          'scroll',
}
