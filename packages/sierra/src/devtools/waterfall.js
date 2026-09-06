/**
 * Waterfall renderer — builds timing bar markup for a request's hooks+queries.
 * Plain DOM helpers, no framework.
 */

import { html, num } from './html.js'

export function renderWaterfall(request, { n1Threshold = 3 } = {}) {
  const rows = []

  // Combine hooks and queries, sort by start time
  const all = [
    ...(request.hooks   ?? []).map(h => ({ ...h, _kind: 'hook'  })),
    ...(request.queries ?? []).map(q => ({ ...q, _kind: 'query' })),
  ].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))

  const totalMs = request.durationMs || 1

  // N+1 detection: count same service+method combos
  const opCounts = {}
  for (const row of all) {
    const key = `${row.service ?? ''}:${row.method ?? row.operation ?? ''}`
    opCounts[key] = (opCounts[key] ?? 0) + 1
  }

  for (const row of all) {
    const ms      = num(row.durationMs ?? row.duration)
    const pct     = Math.min(100, Math.round((ms / totalMs) * 100))
    const key     = `${row.service ?? ''}:${row.method ?? row.operation ?? ''}`
    const isN1    = opCounts[key] > n1Threshold
    const label   = row._kind === 'hook'
      ? `${row.phase ?? ''} / ${row.hookName ?? row.name ?? ''}`
      : `litestone / ${row.operation ?? row.method ?? 'query'}`
    const detail  = row._kind === 'query'
      ? (row.rowCount != null ? `${row.rowCount} rows` : '')
      : (row.status === 'error' ? row.errorMsg ?? '✗' : '✓')

    rows.push({ label, ms, pct, isN1, detail, kind: row._kind })
  }

  return rows
}

export function buildWaterfallEl(request, opts) {
  const rows = renderWaterfall(request, opts)
  const frag = document.createDocumentFragment()

  for (const row of rows) {
    const el = document.createElement('div')
    el.className = 'fjs-wf-row' + (row.isN1 ? ' fjs-wf-n1' : '')
    el.innerHTML = String(html`<span class="fjs-wf-label">${row.label}</span>` +
      html`<span class="fjs-wf-bar"><span style="width:${num(row.pct)}%"></span></span>` +
      html`<span class="fjs-wf-ms">${row.ms.toFixed(1)}ms</span>` +
      html`<span class="fjs-wf-detail">${row.detail}</span>`)
    frag.appendChild(el)
  }

  return frag
}
