/**
 * Toolbar shell — pill + expandable panel.
 * Plain DOM, no Mesa, no framework dependency.
 */

import { createRequestsTab   } from './tabs/requests.js'
import { createEventsTab     } from './tabs/events.js'
import { createConnectionsTab} from './tabs/connections.js'
import { createLogsTab       } from './tabs/logs.js'

const CSS = `
#fjs-devtools *{box-sizing:border-box;font-family:system-ui,sans-serif;margin:0;padding:0}
#fjs-devtools{position:fixed;z-index:2147483647;bottom:16px;right:16px;font-size:12px}
.fjs-pill{display:flex;align-items:center;gap:8px;background:#1a1a1a;color:#e0e0e0;padding:6px 12px;border-radius:999px;cursor:pointer;user-select:none;white-space:nowrap}
.fjs-pill-logo{font-weight:600;color:#a78bfa;font-size:13px}
.fjs-pill-stat{color:#888}
.fjs-pill-stat span{color:#e0e0e0;font-weight:500}
.fjs-pill-offline{color:#f87171;font-size:11px}
.fjs-pill-stale{color:#fbbf24;font-size:11px}
.fjs-pill-new{background:#7c3aed;color:#fff;border-radius:999px;padding:0 5px;font-size:10px}
.fjs-panel{position:fixed;bottom:52px;right:16px;width:680px;max-width:calc(100vw - 32px);height:420px;background:#1a1a1a;border:1px solid #333;border-radius:8px;display:flex;flex-direction:column;overflow:hidden}
.fjs-tabs{display:flex;border-bottom:1px solid #333;background:#111;flex-shrink:0}
.fjs-tab{padding:8px 16px;cursor:pointer;color:#888;font-size:12px;border-bottom:2px solid transparent}
.fjs-tab.active{color:#e0e0e0;border-bottom-color:#a78bfa}
.fjs-tab-content{flex:1;overflow-y:auto;padding:8px}
.fjs-panel-controls{display:flex;gap:8px;padding:6px 10px;border-bottom:1px solid #333;flex-shrink:0}
.fjs-btn{background:transparent;border:1px solid #444;color:#aaa;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px}
.fjs-btn:hover{border-color:#777;color:#e0e0e0}
.fjs-filter{background:#111;border:1px solid #333;color:#e0e0e0;border-radius:4px;padding:3px 8px;font-size:11px;width:180px;outline:none}
.fjs-req-table{display:flex;flex-direction:column;gap:2px}
.fjs-req-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;cursor:pointer;color:#ccc}
.fjs-req-row:hover{background:#252525}
.fjs-row-error{color:#f87171}
.fjs-req-time{color:#555;min-width:68px}
.fjs-req-svc{flex:1;font-weight:500;color:#e0e0e0}
.fjs-badge{border-radius:3px;padding:1px 5px;font-size:10px;font-weight:600}
.fjs-badge-ws,.fjs-badge-websocket{background:#312e81;color:#a5b4fc}
.fjs-badge-http{background:#1c3a2a;color:#6ee7b7}
.fjs-badge-internal{background:#292524;color:#a8a29e}
.fjs-req-user{color:#666;min-width:50px}
.fjs-req-dur{display:flex;align-items:center;gap:4px;min-width:80px;color:#888}
.fjs-dur-bar{height:6px;background:#4c1d95;border-radius:2px;display:inline-block}
.fjs-req-status{min-width:16px;text-align:center}
.fjs-req-error-msg{color:#f87171;font-size:11px;padding:2px 6px;width:100%}
.fjs-waterfall{padding:4px 0 4px 16px;border-left:2px solid #333;margin:4px 0 0 8px}
.fjs-wf-row{display:flex;align-items:center;gap:6px;padding:2px 0;color:#888}
.fjs-wf-n1{color:#fbbf24}
.fjs-wf-label{min-width:220px;font-size:11px}
.fjs-wf-bar{width:80px;height:4px;background:#333;border-radius:2px;flex-shrink:0}
.fjs-wf-bar span{display:block;height:100%;background:#7c3aed;border-radius:2px}
.fjs-wf-ms{min-width:50px;text-align:right;font-size:11px;color:#666}
.fjs-wf-detail{font-size:11px;color:#555}
.fjs-feed{display:flex;flex-direction:column;gap:2px}
.fjs-feed-row{display:flex;gap:8px;padding:3px 6px;border-radius:3px;color:#888;font-size:11px}
.fjs-feed-row:hover{background:#252525}
.fjs-feed-name{color:#ccc;flex:1}
.fjs-feed-payload{color:#555;flex:2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fjs-level{border-radius:3px;padding:1px 5px;font-size:10px;font-weight:600;min-width:40px;text-align:center}
.fjs-level-debug{background:#1c2a3a;color:#7dd3fc}
.fjs-level-info{background:#1c3a2a;color:#6ee7b7}
.fjs-level-warn{background:#3a2a1c;color:#fbbf24}
.fjs-level-error{background:#3a1c1c;color:#f87171}
.fjs-tab-toolbar{display:flex;gap:8px;padding:0 0 8px;align-items:center}
`

export function createToolbarUI(buffer, config, onPause, onResume, onClear) {
  // Inject CSS once
  if (!document.getElementById('fjs-devtools-css')) {
    const style = document.createElement('style')
    style.id = 'fjs-devtools-css'
    style.textContent = CSS
    document.head.appendChild(style)
  }

  const root = document.createElement('div')
  root.id = 'fjs-devtools'

  // ── Pill ──────────────────────────────────────────────────────────────────
  const pill = document.createElement('div')
  pill.className = 'fjs-pill'
  root.appendChild(pill)

  // ── Panel ─────────────────────────────────────────────────────────────────
  const panel = document.createElement('div')
  panel.className = 'fjs-panel'
  panel.style.display = 'none'
  root.appendChild(panel)

  const tabBar = document.createElement('div')
  tabBar.className = 'fjs-tabs'
  panel.appendChild(tabBar)

  const controls = document.createElement('div')
  controls.className = 'fjs-panel-controls'
  controls.innerHTML =
    '<button class="fjs-btn" id="fjs-btn-pause">Pause</button>' +
    '<button class="fjs-btn" id="fjs-btn-clear">Clear</button>'
  panel.appendChild(controls)

  controls.querySelector('#fjs-btn-pause').addEventListener('click', (e) => {
    const paused = e.target.textContent === 'Pause'
    e.target.textContent = paused ? 'Resume' : 'Pause'
    if (paused) onPause(); else onResume()
  })
  controls.querySelector('#fjs-btn-clear').addEventListener('click', () => {
    buffer.requests.clear(); buffer.logs.clear(); buffer.events.clear()
    onClear()
    render()
  })

  const tabContent = document.createElement('div')
  tabContent.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:column'
  panel.appendChild(tabContent)

  // ── Tabs ──────────────────────────────────────────────────────────────────
  const reqTab   = createRequestsTab(buffer, config)
  const evtTab   = createEventsTab(buffer)
  const connTab  = createConnectionsTab()
  const logTab   = createLogsTab(buffer)

  const tabs = [
    { label: 'Requests',    tab: reqTab  },
    { label: 'Events',      tab: evtTab  },
    { label: 'Connections', tab: connTab },
    { label: 'Logs',        tab: logTab  },
  ]

  let activeIdx = 0

  tabs.forEach(({ label }, i) => {
    const btn = document.createElement('div')
    btn.className = 'fjs-tab' + (i === 0 ? ' active' : '')
    btn.textContent = label
    btn.addEventListener('click', () => {
      activeIdx = i
      tabBar.querySelectorAll('.fjs-tab').forEach((t, j) => t.classList.toggle('active', j === i))
      renderActive()
    })
    tabBar.appendChild(btn)
  })

  function renderActive() {
    tabContent.innerHTML = ''
    const { tab } = tabs[activeIdx]
    tabContent.appendChild(tab.el)
    tab.render()
  }

  // ── Toggle panel ──────────────────────────────────────────────────────────
  let panelOpen = false
  pill.addEventListener('click', () => {
    panelOpen = !panelOpen
    panel.style.display = panelOpen ? 'flex' : 'none'
    if (panelOpen) renderActive()
  })

  // ── Public API ────────────────────────────────────────────────────────────
  let _statusText = ''
  let _newCount   = 0

  // Pill structure is built once. It used to be reassigned via innerHTML on
  // every inbound message — including status-only updates — which reparsed the
  // markup and discarded/recreated five elements each time. Now only the text
  // nodes that actually changed are written.
  pill.innerHTML =
    `<span class="fjs-pill-logo">◈ FJS</span>` +
    `<span class="fjs-pill-stat"><span data-n>0</span> req</span>` +
    `<span class="fjs-pill-stat">err <span data-e>0</span></span>` +
    `<span class="fjs-pill-stat">avg <span data-a>0ms</span></span>` +
    `<span class="fjs-pill-new" hidden></span>` +
    `<span class="fjs-pill-offline" hidden></span>`

  const _pn = pill.querySelector('[data-n]')
  const _pe = pill.querySelector('[data-e]')
  const _pa = pill.querySelector('[data-a]')
  const _pnew = pill.querySelector('.fjs-pill-new')
  const _poff = pill.querySelector('.fjs-pill-offline')

  function setText(node, value) {
    const v = String(value)
    if (node.textContent !== v) node.textContent = v
  }

  function updatePill() {
    let errors = 0, total = 0, n = 0
    // Single pass — previously filter() + reduce() each built an intermediate.
    for (const r of buffer.requests.all()) {
      n++
      if (r.status === 'error') errors++
      total += r.durationMs ?? 0
    }
    setText(_pn, n)
    setText(_pe, errors)
    setText(_pa, (n ? Math.round(total / n) : 0) + 'ms')

    if (_newCount > 0) { setText(_pnew, `${_newCount} new`); _pnew.hidden = false }
    else _pnew.hidden = true

    if (_statusText) { setText(_poff, _statusText); _poff.hidden = false }
    else _poff.hidden = true
  }

  // Coalesce onto a frame. render() is called once per inbound WebSocket
  // message, and a burst of 50 messages in one tick previously meant 50 full
  // panel rebuilds — each one clearing tabContent and re-creating every row.
  // Now a burst collapses to a single paint.
  let _frame = 0
  const _schedule = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 16)

  function render() {
    if (_frame) return
    _frame = 1
    _schedule(() => {
      _frame = 0
      updatePill()
      if (panelOpen) renderActive()
    })
  }

  /** Render synchronously — for tests and for the initial paint. */
  function renderNow() {
    _frame = 0
    updatePill()
    if (panelOpen) renderActive()
  }

  function setStatus(text) {
    _statusText = text
    render()
  }

  function addNewCount(n) {
    _newCount += n
    render()
  }

  function clearNewCount() {
    _newCount = 0
    render()
  }

  return {
    root,
    render,
    renderNow,
    setStatus,
    addNewCount,
    clearNewCount,
    setConnections: connTab.setConnections,
  }
}
