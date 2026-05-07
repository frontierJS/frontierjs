export function createEventsTab(buffer) {
  const el = document.createElement('div')
  el.className = 'fjs-tab-content'

  const list = document.createElement('div')
  list.className = 'fjs-feed'
  el.appendChild(list)

  function render() {
    list.innerHTML = ''
    const rows = [...buffer.events.all()].reverse()
    for (const ev of rows) {
      const row = document.createElement('div')
      row.className = 'fjs-feed-row'
      const payload = JSON.stringify(ev.data ?? {}).slice(0, 80)
      row.innerHTML =
        `<span class="fjs-feed-name">${esc(ev.name ?? ev.type ?? '')}</span>` +
        `<span class="fjs-feed-payload">${esc(payload)}</span>`
      list.appendChild(row)
    }
  }

  return { el, render }
}

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
