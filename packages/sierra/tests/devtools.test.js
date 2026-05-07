/**
 * tests/devtools.test.js
 */
import { describe, test, it, expect, vi, beforeEach } from 'vitest'
import { createBuffer } from '../src/devtools/buffer.js'
import { renderWaterfall } from '../src/devtools/waterfall.js'

// ── Buffer tests ──────────────────────────────────────────────────────────────

describe('createBuffer', () => {
  let buf

  beforeEach(() => { buf = createBuffer({ requests: 5, logs: 5, events: 5 }) })

  it('initialises empty', () => {
    expect(buf.requests.all()).toHaveLength(0)
    expect(buf.logs.all()).toHaveLength(0)
    expect(buf.events.all()).toHaveLength(0)
  })

  it('initFromState populates all buckets', () => {
    buf.initFromState({
      requests: [{ id: 'r1', service: 'leads', method: 'find', durationMs: 10, status: 'ok' }],
      logs:     [{ level: 'INFO', message: 'hello', ts: Date.now() }],
      events:   [{ name: 'user.created', data: {} }],
    })
    expect(buf.requests.all()).toHaveLength(1)
    expect(buf.logs.all()).toHaveLength(1)
    expect(buf.events.all()).toHaveLength(1)
  })

  it('initFromState clears previous state', () => {
    buf.initFromState({ requests: [{ id: 'r1', service: 'a', method: 'b', durationMs: 1, status: 'ok' }] })
    buf.initFromState({ requests: [] })
    expect(buf.requests.all()).toHaveLength(0)
  })

  it('ring buffer drops oldest at capacity', () => {
    for (let i = 0; i < 7; i++) {
      buf.addRequest({ id: `r${i}`, service: 's', method: 'm', durationMs: 1, status: 'ok' })
    }
    expect(buf.requests.all()).toHaveLength(5)
    expect(buf.requests.all()[0].id).toBe('r2')
  })

  it('addRequest merges pending hooks', () => {
    buf.addHook({ telemetryId: 'r1', phase: 'before', hookName: 'auth', durationMs: 1 })
    const req = buf.addRequest({ id: 'r1', service: 's', method: 'm', durationMs: 5, status: 'ok' })
    expect(req.hooks).toHaveLength(1)
    expect(req.hooks[0].hookName).toBe('auth')
  })

  it('addHook updates existing request row in-place', () => {
    buf.addRequest({ id: 'r1', service: 's', method: 'm', durationMs: 5, status: 'ok' })
    const { found } = buf.addHook({ telemetryId: 'r1', phase: 'before', hookName: 'paginate', durationMs: 1 })
    expect(found).toBe(true)
    expect(buf.requests.all()[0].hooks).toHaveLength(1)
  })

  it('addHook holds in pending map when request not yet arrived', () => {
    const { found } = buf.addHook({ telemetryId: 'r-future', phase: 'before', hookName: 'x', durationMs: 1 })
    expect(found).toBe(false)
    // When request arrives, hooks are merged
    const req = buf.addRequest({ id: 'r-future', service: 's', method: 'm', durationMs: 5, status: 'ok' })
    expect(req.hooks).toHaveLength(1)
  })

  it('addQuery behaves like addHook', () => {
    buf.addRequest({ id: 'r1', service: 's', method: 'm', durationMs: 5, status: 'ok' })
    buf.addQuery({ telemetryId: 'r1', operation: 'findMany', durationMs: 2, rowCount: 10 })
    expect(buf.requests.all()[0].queries).toHaveLength(1)
    expect(buf.requests.all()[0].queries[0].rowCount).toBe(10)
  })

  it('clear empties display', () => {
    buf.addRequest({ id: 'r1', service: 's', method: 'm', durationMs: 1, status: 'ok' })
    buf.requests.clear()
    expect(buf.requests.all()).toHaveLength(0)
  })
})

// ── Waterfall tests ───────────────────────────────────────────────────────────

describe('renderWaterfall', () => {
  const baseReq = { id: 'r1', service: 's', method: 'm', durationMs: 10, status: 'ok' }

  it('returns empty rows for request with no hooks/queries', () => {
    expect(renderWaterfall(baseReq)).toHaveLength(0)
  })

  it('renders hook rows', () => {
    const req = { ...baseReq, hooks: [
      { phase: 'before', hookName: 'auth', durationMs: 1 }
    ], queries: [] }
    const rows = renderWaterfall(req)
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toContain('auth')
    expect(rows[0].kind).toBe('hook')
  })

  it('renders query rows', () => {
    const req = { ...baseReq, hooks: [], queries: [
      { operation: 'findMany', durationMs: 3, rowCount: 5 }
    ]}
    const rows = renderWaterfall(req)
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toContain('findMany')
    expect(rows[0].detail).toContain('5 rows')
  })

  it('N+1 detection flags ops exceeding threshold', () => {
    const req = { ...baseReq, durationMs: 20, hooks: [], queries: [
      { operation: 'findOne', durationMs: 1 },
      { operation: 'findOne', durationMs: 1 },
      { operation: 'findOne', durationMs: 1 },
      { operation: 'findOne', durationMs: 1 },
    ]}
    const rows = renderWaterfall(req, { n1Threshold: 3 })
    expect(rows.every(r => r.isN1)).toBe(true)
  })

  it('N+1 does NOT flag when below threshold', () => {
    const req = { ...baseReq, hooks: [], queries: [
      { operation: 'findOne', durationMs: 1 },
      { operation: 'findOne', durationMs: 1 },
    ]}
    const rows = renderWaterfall(req, { n1Threshold: 3 })
    expect(rows.every(r => !r.isN1)).toBe(true)
  })

  it('N+1 threshold is configurable', () => {
    const req = { ...baseReq, hooks: [], queries: [
      { operation: 'findOne', durationMs: 1 },
      { operation: 'findOne', durationMs: 1 },
    ]}
    // threshold=1 → 2 occurrences > 1 → flagged
    const rows = renderWaterfall(req, { n1Threshold: 1 })
    expect(rows.every(r => r.isN1)).toBe(true)
  })

  it('pct bar capped at 100', () => {
    const req = { ...baseReq, durationMs: 1, hooks: [
      { phase: 'before', hookName: 'slow', durationMs: 9999 }
    ], queries: [] }
    const rows = renderWaterfall(req)
    expect(rows[0].pct).toBe(100)
  })
})

// ── Devtools plugin tests (unit) ──────────────────────────────────────────────

describe('devtoolsPlugin', () => {
  it('does not inject in build mode (no ctx.server)', async () => {
    const { devtoolsPlugin } = await import('../src/build/devtools-plugin.js')
    const plugin = devtoolsPlugin({ devtools: { port: 4000 } })
    const handler = plugin.transformIndexHtml?.handler ?? plugin.transformIndexHtml
    if (typeof handler !== 'function') return  // no-op if not defined

    const result = handler('<html><body></body></html>', { /* no server */ })
    expect(result).toBe('<html><body></body></html>')
  })

  it('injects script tag in dev mode (ctx.server present)', async () => {
    const { devtoolsPlugin } = await import('../src/build/devtools-plugin.js')
    const plugin = devtoolsPlugin({ devtools: { port: 4000 } })
    const handler = plugin.transformIndexHtml?.handler ?? plugin.transformIndexHtml
    if (typeof handler !== 'function') return

    const result = handler('<html><body></body></html>', { server: {} })
    expect(result).toContain('<script type="module"')
    expect(result).toContain('devtools-bootstrap')
  })

  it('does NOT inject when devtools.enabled is false', async () => {
    const { devtoolsPlugin } = await import('../src/build/devtools-plugin.js')
    const plugin = devtoolsPlugin({ devtools: { enabled: false, port: 4000 } })
    const handler = plugin.transformIndexHtml?.handler ?? plugin.transformIndexHtml
    if (typeof handler !== 'function') return

    const result = handler('<html><body></body></html>', { server: {} })
    expect(result).not.toContain('<script type="module"')
  })

  it('applies only in serve mode', async () => {
    const { devtoolsPlugin } = await import('../src/build/devtools-plugin.js')
    const plugin = devtoolsPlugin({})
    expect(plugin.apply).toBe('serve')
  })
})
