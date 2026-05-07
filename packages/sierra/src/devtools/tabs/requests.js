import { buildWaterfallEl } from '../waterfall.js'

export function createRequestsTab(buffer, config) {
  const el = document.createElement('div')
  el.className = 'fjs-tab-content'

  const toolbar = document.createElement('div')
  toolbar.className = 'fjs-tab-toolbar'
  toolbar.innerHTML =
    '<input class="fjs-filter" placeholder="filter service or status…" />'
  el.appendChild(toolbar)

  const table = document.createElement('div')
  table.className = 'fjs-req-table'
  el.appendChild(table)

  let _filter = ''
  toolbar.querySelector('.fjs-filter').addEventListener('input', e => {
    _filter = e.target.value.toLowerCase()
    render()
  })

  function _row(req) {
    const tr = document.createElement('div')
    tr.className = 'fjs-req-row' + (req.status === 'error' ? ' fjs-row-error' : '')
    tr.dataset.id = req.id

    const ts      = new Date(req.ts).toLocaleTimeString()
    const durBar  = Math.min(100, Math.round((req.durationMs / 500) * 100))
    const badge   = `<span class="fjs-badge fjs-badge-${(req.transport||'http').toLowerCase()}">${req.transport||'HTTP'}</span>`
    const status  = req.status === 'error' ? '✗' : '✓'

    tr.innerHTML =
      `<span class="fjs-req-time">${ts}</span>` +
      `<span class="fjs-req-svc">${esc(req.service)}.${esc(req.method)}</span>` +
      `${badge}` +
      `<span class="fjs-req-user">${esc(req.user ?? '—')}</span>` +
      `<span class="fjs-req-dur"><span class="fjs-dur-bar" style="width:${durBar}%"></span>${req.durationMs}ms</span>` +
      `<span class="fjs-req-status">${status}</span>`

    if (req.errorMsg) {
      const err = document.createElement('div')
      err.className = 'fjs-req-error-msg'
      err.textContent = req.errorMsg
      tr.appendChild(err)
    }

    // Expand/collapse waterfall on click
    let expanded = false
    let wfEl = null
    tr.addEventListener('click', () => {
      if (!expanded) {
        wfEl = document.createElement('div')
        wfEl.className = 'fjs-waterfall'
        wfEl.appendChild(buildWaterfallEl(req, { n1Threshold: config.n1Threshold ?? 3 }))
        tr.appendChild(wfEl)
        expanded = true
      } else {
        wfEl?.remove()
        expanded = false
      }
    })

    return tr
  }

  function render() {
    table.innerHTML = ''
    const rows = [...buffer.requests.all()].reverse()
    for (const req of rows) {
      if (_filter && !`${req.service} ${req.method} ${req.status}`.toLowerCase().includes(_filter)) continue
      table.appendChild(_row(req))
    }
  }

  return { el, render }
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}
