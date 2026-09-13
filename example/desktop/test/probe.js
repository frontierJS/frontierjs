// desktop/test/probe.js — runs INSIDE the desktop shell's webview, before any
// page script, on every load.
//
// The drive cannot reach into this page: WebKitGTK and WKWebView speak no CDP.
// So this does the driving and reports each row through the shell's
// `probe_report` command, which prints it for test/verify.mjs to grade.
// `__API__` is replaced by the drive before the file is handed to the shell.
//
// sessionStorage carries the phase across the one full reload this makes on
// purpose, and it counts pagehides: a link click that became a page load
// would otherwise look exactly like a working navigation, since both land on
// the URL the link named.
(() => {
  if (window.top !== window || window.__fjsProbe) return
  window.__fjsProbe = true

  const API    = '__API__'
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
  const say    = (row, value) => invoke('probe_report', { line: JSON.stringify({ row, value }) })
  const done   = (code) => invoke('probe_done', { code })
  const sleep  = (ms) => new Promise(r => setTimeout(r, ms))
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find(e => e.textContent.includes(text))
  const waitFor = async (fn, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      try { const v = fn(); if (v) return v } catch {}
      await sleep(100)
    }
    return null
  }

  // A first load starts signed out whatever an earlier run left in storage.
  let phase = sessionStorage.getItem('fjs_probe_phase')
  if (!phase) {
    localStorage.clear()
    phase = 'first'
    sessionStorage.setItem('fjs_probe_phase', phase)
    sessionStorage.setItem('fjs_probe_pagehides', '0')
  }
  const pagehides = () => Number(sessionStorage.getItem('fjs_probe_pagehides'))
  window.addEventListener('pagehide', () => sessionStorage.setItem('fjs_probe_pagehides', String(pagehides() + 1)))

  // Every socket the app opens, recorded before the app can open one.
  const sockets = []
  const NativeSocket = window.WebSocket
  window.WebSocket = function (url, protocols) {
    const socket = new NativeSocket(url, protocols)
    const row = { url: String(url), state: 'connecting' }
    sockets.push(row)
    socket.addEventListener('open',  () => { row.state = 'open' })
    socket.addEventListener('close', () => { row.state = 'closed' })
    return socket
  }
  window.WebSocket.prototype = NativeSocket.prototype
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })

  const errors = []
  window.addEventListener('error', e => errors.push(String(e.message)))
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason?.message ?? e.reason)))

  const openSockets = () => sockets.filter(s => s.state === 'open').map(s => s.url.split('?')[0])

  async function first() {
    say('page', { origin: location.origin, protocol: location.protocol })
    say('api.health', await fetch(`${API}/api/health`).then(r => r.status, e => `ERR ${e.message}`))

    const signIn = await waitFor(() => byText('header button', 'Sign in (admin)'))
    signIn?.click()
    const badge = await waitFor(() => byText('header .badge', 'level') || document.querySelector('.alert.danger'))
    say('signIn', badge?.textContent.trim() ?? null)

    const link = document.querySelector('a.navlink[href="/orders/"]')
    let prevented = null
    window.addEventListener('click', e => setTimeout(() => { prevented = e.defaultPrevented }, 0))
    link?.click()
    const arrived = await waitFor(() => location.pathname === '/orders/' && document.title === 'Orders', 5000)
    await sleep(1000)
    say('click', {
      linkFound:        !!link,
      defaultPrevented: prevented,
      arrived:          !!arrived,
      rows:             document.querySelectorAll('table tbody tr').length,
      pagehides:        pagehides(),
    })

    await sleep(1500)
    say('sockets', openSockets())
    say('errors.first', errors)

    sessionStorage.setItem('fjs_probe_phase', 'reloaded')
    location.href = '/orders/'
  }

  async function reloaded() {
    const rows = await waitFor(() => document.querySelectorAll('table tbody tr').length || null)
    say('deepLink', {
      path:      location.pathname,
      rows:      rows ?? 0,
      signedIn:  byText('header .badge', 'level')?.textContent.trim() ?? null,
      pagehides: pagehides(),
    })
    await sleep(1500)
    // Awaited: the shell exits on `done`, and a report still in flight is lost.
    await say('errors.reloaded', errors)
    sessionStorage.clear()
    done(0)
  }

  const run = () => (phase === 'first' ? first() : reloaded())
    .catch(async e => { await say('threw', String(e?.stack ?? e)); done(3) })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run)
  else run()

  setTimeout(async () => { await say('watchdog', { phase, href: location.href, errors }); done(2) }, 45000)
})()
