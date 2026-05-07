const LEVEL_CLASS = { DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' }

export function createLogsTab(buffer) {
  const el = document.createElement('div')
  el.className = 'fjs-tab-content'

  const list = document.createElement('div')
  list.className = 'fjs-feed'
  el.appendChild(list)

  function render() {
    list.innerHTML = ''
    const rows = [...buffer.logs.all()].reverse()
    for (const log of rows) {
      const row = document.createElement('div')
      row.className = 'fjs-feed-row'
      const lvl = (log.level ?? 'INFO').toUpperCase()
      row.innerHTML =
        `<span class="fjs-level fjs-level-${LEVEL_CLASS[lvl] ?? 'info'}">${lvl}</span>` +
        `<span class="fjs-feed-name">${esc(log.message ?? '')}</span>` +
        `<span class="fjs-feed-payload">${new Date(log.ts ?? Date.now()).toLocaleTimeString()}</span>`
      list.appendChild(row)
    }
  }

  return { el, render }
}

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
