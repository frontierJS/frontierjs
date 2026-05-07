export function createConnectionsTab() {
  const el = document.createElement('div')
  el.className = 'fjs-tab-content'

  const list = document.createElement('div')
  list.className = 'fjs-feed'
  el.appendChild(list)

  let _connections = []

  function setConnections(conns) { _connections = conns; render() }

  function render() {
    list.innerHTML = ''
    for (const c of _connections) {
      const row = document.createElement('div')
      row.className = 'fjs-feed-row'
      const since = c.connectedAt ? new Date(c.connectedAt).toLocaleTimeString() : '—'
      row.innerHTML =
        `<span class="fjs-feed-name">${esc(c.user ?? 'anon')}</span>` +
        `<span class="fjs-feed-payload">${esc(c.ip ?? '')} · since ${since}</span>`
      list.appendChild(row)
    }
  }

  return { el, render, setConnections }
}

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
