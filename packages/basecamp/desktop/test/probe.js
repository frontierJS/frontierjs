// desktop/test/probe.js — runs INSIDE the desktop shell's webview, before any
// page script, on every load.
//
// The drive cannot reach into this page: WebKitGTK and WKWebView speak no CDP.
// So this does the driving and reports each row through the shell's
// `probe_report` command, which prints it for test/verify.mjs to grade.
// `__API__`, `__EMAIL__` and `__PASSWORD__` are replaced by the drive before the
// file is handed to the shell.
//
// sessionStorage carries the phase across the one full load this makes on
// purpose (to /login/), and counts pagehides: the sidebar click to the local
// repos screen would otherwise look the same whether the router kept the page
// or the shell reloaded it, since both land on the URL the link named.
(() => {
  if (window.top !== window || window.__fjsProbe) return
  window.__fjsProbe = true

  const API      = '__API__'
  const EMAIL    = '__EMAIL__'
  const PASSWORD = '__PASSWORD__'
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
  const say    = (row, value) => invoke('probe_report', { line: JSON.stringify({ row, value }) })
  const done   = (code) => invoke('probe_done', { code })
  const sleep  = (ms) => new Promise(r => setTimeout(r, ms))
  const waitFor = async (fn, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      try { const v = fn(); if (v) return v } catch {}
      await sleep(100)
    }
    return null
  }
  // Mesa listens for `input`; a bare `.value =` changes nothing it reads.
  const fill = (fields) => {
    for (const [id, value] of Object.entries(fields)) {
      const el = document.getElementById(id)
      if (!el) throw new Error(`no field #${id} on ${location.pathname}`)
      el.value = value
      el.dispatchEvent(new Event('input',  { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
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

  const errors = []
  window.addEventListener('error', e => errors.push(String(e.message)))
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason?.message ?? e.reason)))

  async function first() {
    say('page', { origin: location.origin, protocol: location.protocol })
    say('api.health', await fetch(`${API}/health`).then(r => r.status, e => `ERR ${e.message}`))
    sessionStorage.setItem('fjs_probe_phase', 'login')
    location.href = '/login/'
  }

  async function login() {
    const form = await waitFor(() => document.getElementById('email'))
    if (!form) throw new Error(`the sign-in form never rendered at ${location.pathname}`)
    fill({ email: EMAIL, password: PASSWORD })
    document.querySelector('button[type=submit]').click()
    const landed = await waitFor(() => location.pathname === '/')
    say('signIn', { landed: !!landed, path: location.pathname, token: !!localStorage.getItem('basecamp_token') })

    const before = pagehides()
    const link = await waitFor(() => document.querySelector('a[href="/git-activity/local/"]'))
    link?.click()
    const field = await waitFor(() => document.getElementById('root'))
    say('nav', { linkFound: !!link, arrived: !!field, path: location.pathname, reloads: pagehides() - before })

    fill({ root: '~/code' })
    document.querySelector('#local-repos-form button[type=submit]').click()
    const listed = await waitFor(() => /alpha/.test(document.getElementById('local-repos-list')?.textContent ?? ''))
    say('scan', {
      listed: !!listed,
      text:   document.getElementById('local-repos-list')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      totals: document.getElementById('local-repos-totals')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      leaked: document.body.textContent.includes('tok_secret'),
      error:  document.getElementById('screen-error')?.textContent.trim() || null,
    })

    // Awaited: the shell exits on `done`, and a report still in flight is lost.
    await say('errors', errors)
    sessionStorage.clear()
    done(0)
  }

  const run = () => (phase === 'first' ? first() : login())
    .catch(async e => { await say('threw', String(e?.stack ?? e)); done(3) })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run)
  else run()

  setTimeout(async () => { await say('watchdog', { phase, href: location.href, errors }); done(2) }, 60000)
})()
