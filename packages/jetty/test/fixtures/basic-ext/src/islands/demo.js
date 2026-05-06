// Fixture island — Phase 4 smoke.
//
// Mounts a small floating banner at the top-right of pages matching the
// configured pattern. Demonstrates:
//   - app function rendering inside a shadow root
//   - host port connection to harbor
//   - main() lifecycle running before app
//   - position: fixed-top-right
//
// Add a host pattern like 'http://localhost:*' or '*://example.com/*' to
// jetty.config.js → islands.demo.matches to make this load on real pages.

import { defineIsland } from '../../../../../src/index.js'

export default defineIsland({
  app(root, props) {
    // root is the shadow root.
    const wrap = document.createElement('div')
    wrap.style.cssText = `
      background: #1a1a2e;
      color: #fff;
      padding: 8px 14px;
      font: 13px/1.4 system-ui, -apple-system, sans-serif;
      border-radius: 0 0 0 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      max-width: 280px;
    `

    const title = document.createElement('div')
    title.textContent = 'Jetty Island'
    title.style.cssText = 'font-weight: 600; margin-bottom: 4px;'

    const status = document.createElement('div')
    status.textContent = 'Connecting…'
    status.style.cssText = 'font-size: 12px; color: #c4c4d0;'

    const counter = document.createElement('div')
    counter.style.cssText = 'font-size: 11px; color: #9090a0; margin-top: 4px;'

    wrap.appendChild(title)
    wrap.appendChild(status)
    wrap.appendChild(counter)
    root.appendChild(wrap)

    // Wire to harbor port (passed in by runIsland)
    if (props.harbor) {
      status.textContent = 'Connected'

      props.harbor.on('session', (payload) => {
        status.textContent = payload?.authenticated
          ? `Authed: ${payload.user?.name ?? payload.user?.email ?? '?'}`
          : 'Anonymous'
      })

      // Subscribe to harbor's tick channel — same one the dock uses.
      let n = 0
      props.harbor.subscribe('tick', () => {
        n++
        counter.textContent = `Ticks observed: ${n}`
      })

      props.harbor.onDisconnect(() => { status.textContent = 'Disconnected' })
      props.harbor.onReconnect(() => { status.textContent = 'Reconnected' })
    } else {
      status.textContent = 'No harbor (test env?)'
    }
  },

  async main(ctx) {
    // Code-side phase. Runs before app — useful for prefetching data.
    console.log(`[island:${ctx.id}] main() running on`, location.href)
  },

  position: 'fixed-top-right',
})
