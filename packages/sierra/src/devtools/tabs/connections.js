import { html } from '../html.js'

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
      row.innerHTML = String(html`<span class="fjs-feed-name">${c.user ?? 'anon'}</span>` +
        html`<span class="fjs-feed-payload">${c.ip ?? ''} · since ${since}</span>`)
      list.appendChild(row)
    }
  }

  return { el, render, setConnections }
}
