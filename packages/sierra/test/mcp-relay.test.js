/**
 * @vitest-environment happy-dom
 *
 * test/mcp-relay.test.js — the view's client: a call leaves as `tools/call`.
 *
 * `mcpApp()` (`src/mcp/index.js`) installs the page's client with a relay,
 * and the relay turns each call into the arguments the app's `mcp()`
 * dispatches through `invoke()`. That table is the one thing restated across
 * the two packages, so it is asserted here verb by verb; the host's half of
 * the wire is `src/mcp/host.js`, asserted against a stand-in parent window,
 * and so is the handshake that opens a view (`startView()`).
 *
 * What only a real host and a real `/mcp` settle — the plugin accepting these
 * arguments, a save landing — is `example`'s `verify:mcp-view`.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

import { mcpApp, _resetMcpApp, toolCall, toolAnswer, startView, submitInPlace } from '../src/mcp/index.js'
import { hostChannel } from '../src/mcp/host.js'
import { getClient, createResource, status } from '../src/resource/index.js'
import { ready, session } from '../src/resource/session.js'
import { toFieldErrors, isStaleWrite, STALE_WRITE_MESSAGE } from '../src/resource/field-rules.js'
import { initTheme, theme } from '../src/theme/index.js'

// ─── the tool table ───────────────────────────────────────────────────────

describe('toolCall — a relayed call as the plugin takes it', () => {
  const call = (method, rest = {}) => toolCall({ service: 'orders', method, id: null, data: null, query: null, ...rest })

  test('find splits filters from directives, and states neither when empty', () => {
    expect(call('find')).toEqual({ name: 'orders_find', arguments: {} })
    expect(call('find', { query: { status: 'open', $limit: 5, $orderBy: '-total' } })).toEqual({
      name: 'orders_find',
      arguments: { query: { status: 'open' }, directives: { limit: 5, orderBy: '-total' } },
    })
  })

  test('find refuses a $ key the tool has no spelling for, by name', () => {
    expect(() => call('find', { query: { $nope: 1 } })).toThrow(/\$nope cannot be relayed/)
    expect(() => call('find', { query: { $limit: 'many' } })).toThrow(/\$limit/)
    expect(() => call('find', { query: { $limit: [5, 6] } })).toThrow(/\$limit/)
    expect(() => call('find', { query: { $first: true } })).toThrow(/\$first/)
  })

  test('a by-id verb takes { id }', () => {
    for (const m of ['get', 'remove', 'restore']) {
      expect(call(m, { id: 7 })).toEqual({ name: `orders_${m}`, arguments: { id: 7 } })
    }
  })

  test('a by-id call with directives is refused rather than answered without them', () => {
    expect(() => call('get', { id: 7, query: { $populate: 'customer' } })).toThrow(/\$populate cannot be relayed/)
    expect(() => call('patch', { id: 7, data: {}, query: { $withTemplates: true } })).toThrow(/\$withTemplates/)
  })

  test('create takes the row, and refuses a list', () => {
    expect(call('create', { data: { total: 5 } })).toEqual({ name: 'orders_create', arguments: { total: 5 } })
    expect(() => call('create', { data: [{ total: 5 }] })).toThrow(/one row, and this is a list/)
  })

  test('a write by id takes { id, data }', () => {
    expect(call('patch', { id: 7, data: { total: 6 } })).toEqual({ name: 'orders_patch', arguments: { id: 7, data: { total: 6 } } })
    expect(call('update', { id: 7, data: { total: 6 } })).toEqual({ name: 'orders_update', arguments: { id: 7, data: { total: 6 } } })
  })

  test('a whole record\'s own id leaves data, and a different one is refused', () => {
    expect(call('patch', { id: 7, data: { id: 7, total: 6 } })).toEqual({ name: 'orders_patch', arguments: { id: 7, data: { total: 6 } } })
    expect(call('patch', { id: '7', data: { id: 7 } }).arguments.data).toEqual({})
    expect(() => call('patch', { id: 7, data: { id: 8 } })).toThrow(/data.id 8 is not the row being written/)
  })

  test('any other method is the call(name, id, data) pair', () => {
    expect(call('void', { id: 7, data: { reason: 'dup' } })).toEqual({ name: 'orders_void', arguments: { id: 7, data: { reason: 'dup' } } })
    expect(call('summary')).toEqual({ name: 'orders_summary', arguments: {} })
  })

  test('a base rides _meta, and every other call option is refused by name', () => {
    // The plugin's key, restated there as `BASE_META` — a rename on one side
    // alone sends a field merge as a plain patch.
    expect(call('patch', { id: 7, data: { total: 6 }, opts: { base: { id: 7, total: 5 } } })).toEqual({
      name: 'orders_patch', arguments: { id: 7, data: { total: 6 } }, _meta: { 'frontierjs/base': { id: 7, total: 5 } },
    })
    expect(() => call('create', { data: {}, opts: { idempotencyKey: 'k' } })).toThrow(/idempotencyKey cannot be relayed/)
    expect(() => call('patch', { id: 7, data: {}, opts: { base: { id: 7 }, callHeaders: { 'x-workspace-id': 'w' } } })).toThrow(/callHeaders cannot be relayed/)
    expect(call('get', { id: 7, opts: { base: undefined } })).toEqual({ name: 'orders_get', arguments: { id: 7 } })
  })

  test('the name is toolName()\'s, so a service with a dot cannot leave one', () => {
    expect(toolCall({ service: 'admin.users', method: 'get', id: 1, data: null, query: null }).name).toBe('admin_users_get')
  })
})

describe('toolAnswer — what forward() would have resolved', () => {
  test('structuredContent when the plugin sent one', () => {
    expect(toolAnswer({ content: [{ type: 'text', text: '{"id":1}' }], structuredContent: { id: 1 } })).toEqual({ id: 1 })
  })
  test('the text block\'s JSON when it did not — a scalar or a list', () => {
    expect(toolAnswer({ content: [{ type: 'text', text: '[1,2]' }] })).toEqual([1, 2])
    expect(toolAnswer({ content: [{ type: 'text', text: 'null' }] })).toBe(null)
  })
})

// What the plugin answers a refusal with: junction's `errorBody()`, the body
// HTTP and the socket send, as `structuredContent`. `test/plugin.test.ts` in
// packages/mcp asserts the two are one body for one call.
describe('toolAnswer — a refusal throws what HTTP and the socket throw', () => {
  const refusal = (body, text = body.message) =>
    ({ content: [{ type: 'text', text }], structuredContent: body, isError: true })
  const thrown = (result) => { try { toolAnswer(result) } catch (e) { return e } }

  test('code is the status and data the whole body, so the field list is two datas deep', () => {
    const body = {
      name: 'BadRequest', message: 'reference: must be at least 3 characters', code: 400,
      data: [{ field: 'reference', message: 'must be at least 3 characters' }],
    }
    const err = thrown(refusal(body))
    expect(err.message).toBe(body.message)
    expect(err.code).toBe(400)
    expect(err.data).toEqual(body)
    expect(toFieldErrors(err)).toEqual({
      fields: { reference: 'must be at least 3 characters' }, message: '', committed: false,
    })
  })

  test('a retryable 409 reads as a stale write, which the status alone cannot say', () => {
    const err = thrown(refusal({
      name: 'Conflict', message: 'Version conflict on Order', code: 409, retryable: true,
      data: { model: 'Order', field: 'version', expected: 3, actual: 4 },
    }))
    expect(isStaleWrite(err)).toBe(true)
    expect(toFieldErrors(err).message).toBe(STALE_WRITE_MESSAGE)
  })

  test('a refusal with no body throws its text and claims no status', () => {
    // The SDK refusing the arguments before the app saw them answers this way.
    const err = thrown({ content: [{ type: 'text', text: 'Input validation error' }], isError: true })
    expect(err.message).toBe('Input validation error')
    expect(err.code).toBeUndefined()
    expect(toFieldErrors(err)).toEqual({ fields: {}, message: 'Input validation error', committed: false })
  })
})

// ─── the wire ─────────────────────────────────────────────────────────────

describe('hostChannel — JSON-RPC over postMessage', () => {
  /** A parent window that answers what it is posted, from itself. */
  function parent(answer) {
    const posted = []
    const host = {
      posted,
      postMessage(msg, origin) {
        posted.push({ msg, origin })
        const reply = answer?.(msg)
        if (reply) queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: reply, source: host })))
      },
    }
    return host
  }

  test('a request is posted with "*" and resolves with the matching answer', async () => {
    const host = parent(msg => ({ jsonrpc: '2.0', id: msg.id, result: { ok: msg.params.n } }))
    const ch = hostChannel({ target: host, win: window })
    await expect(ch.request('tools/call', { n: 3 })).resolves.toEqual({ ok: 3 })
    expect(host.posted[0]).toEqual({ msg: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { n: 3 } }, origin: '*' })
    ch.close()
  })

  test('an answer from any window but the host is not read', async () => {
    const host = parent()
    const ch = hostChannel({ target: host, win: window, timeout: 50 })
    const p = ch.request('tools/call', {})
    window.dispatchEvent(new MessageEvent('message', { data: { jsonrpc: '2.0', id: 1, result: 'forged' }, source: {} }))
    await expect(p).rejects.toThrow(/did not answer tools\/call within 50 ms/)
    ch.close()
  })

  test('a JSON-RPC error rejects with its code', async () => {
    const host = parent(msg => ({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }))
    const ch = hostChannel({ target: host, win: window })
    await expect(ch.request('ui/nope')).rejects.toMatchObject({ code: -32601, message: expect.stringMatching(/refused ui\/nope: Method not found/) })
    ch.close()
  })

  test('close rejects what is still waiting', async () => {
    const ch = hostChannel({ target: parent(), win: window })
    const p = ch.request('tools/call', {})
    ch.close()
    await expect(p).rejects.toThrow(/closed before the host answered tools\/call/)
  })

  test('a request from the host is answered by its handler, and one with none is -32601', async () => {
    const host = parent()
    const ch = hostChannel({ target: host, win: window })
    ch.on('ui/resource-teardown', () => ({ done: true }))
    const ask = (id, method) => window.dispatchEvent(new MessageEvent('message', { data: { jsonrpc: '2.0', id, method, params: {} }, source: host }))
    ask('a', 'ui/resource-teardown')
    ask('b', 'ui/nope')
    await vi.waitFor(() => expect(host.posted).toHaveLength(2))
    // A handler's answer is awaited, so the two may come back in either order.
    expect(host.posted.map(p => p.msg)).toEqual(expect.arrayContaining([
      { jsonrpc: '2.0', id: 'a', result: { done: true } },
      { jsonrpc: '2.0', id: 'b', error: { code: -32601, message: 'Method not found: ui/nope' } },
    ]))
    ch.close()
  })

  test('a notification goes out with no id, and one from a stranger is not read', () => {
    const host = parent()
    const ch = hostChannel({ target: host, win: window })
    const heard = []
    ch.on('ui/notifications/tool-result', p => heard.push(p))
    ch.notify('ui/notifications/initialized')
    expect(host.posted[0].msg).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
    window.dispatchEvent(new MessageEvent('message', { data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: 'forged' }, source: {} }))
    window.dispatchEvent(new MessageEvent('message', { data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: 'real' }, source: host }))
    expect(heard).toEqual(['real'])
    ch.close()
  })

  test('a document in no iframe is refused by name', () => {
    expect(() => hostChannel({ win: window, target: window })).toThrow(/not in one/)
  })
})

// ─── the page's client ────────────────────────────────────────────────────

describe('mcpApp — the page client, relayed', () => {
  let calls
  const answers = {
    orders_find:  () => ({ total: 1, limit: 10, skip: 0, data: [{ id: 1, total: 5 }] }),
    orders_get:   ({ id }) => ({ id, total: 5 }),
    orders_patch: ({ id, data }) => ({ id, total: 5, ...data }),
  }
  const host = {
    async request(method, params) {
      calls.push({ method, params })
      const answer = answers[params.name]?.(params.arguments)
      return { content: [{ type: 'text', text: JSON.stringify(answer) }], ...(answer && typeof answer === 'object' ? { structuredContent: answer } : {}) }
    },
  }

  beforeEach(() => { calls = []; _resetMcpApp() })
  afterEach(() => vi.restoreAllMocks())

  test('installs the page\'s own client and answers the harborApp() shape', async () => {
    const app = mcpApp({ host })
    expect(app.client).toBe(getClient())
    expect(app.user).toBe(null)
    expect(typeof app.registry.schemaFor).toBe('function')
    expect(mcpApp()).toBe(app)
    // No token and no cookie mode: the boot restore has nothing to ask, so a
    // guard awaiting `ready` is not left waiting (plan step 3.4). `me()` is
    // `account.get('me')`, a tool a host would be asked to run, so asking
    // nothing is what keeps the boot to the one call the view is for.
    await ready
    expect(session.user).toBe(null)
    expect(session.level).toBe(null)
    expect(calls).toEqual([])
  })

  test('a Resource naming no app reads and writes through tools/call', async () => {
    mcpApp({ host })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const orders = createResource('orders', { validate: false })
    await orders.service.find({ status: 'open' }, { limit: 10 })
    await orders.service.get(1)
    await orders.service.patch(1, { total: 6 })
    expect(calls).toEqual([
      { method: 'tools/call', params: { name: 'orders_find',  arguments: { query: { status: 'open' }, directives: { limit: 10 } } } },
      { method: 'tools/call', params: { name: 'orders_get',   arguments: { id: 1 } } },
      { method: 'tools/call', params: { name: 'orders_patch', arguments: { id: 1, data: { total: 6 } } } },
    ])
  })

  test('a form\'s save() over a model with no @@sync leaves as a plain patch', async () => {
    mcpApp({ host })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const orders = createResource('orders', { validate: false })
    await orders.load()
    await orders.save({ id: 1, total: 6 })
    expect(calls.at(-1)).toEqual({ method: 'tools/call', params: { name: 'orders_patch', arguments: { id: 1, data: { total: 6 } } } })
  })

  test('opens no socket: the store is what this view\'s own calls answered', async () => {
    const opened = vi.fn()
    vi.stubGlobal('WebSocket', class { constructor() { opened() } })
    const { client } = mcpApp({ host })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const orders = createResource('orders', { validate: false })
    await orders.load()
    client.connect()
    expect(opened).not.toHaveBeenCalled()
    expect(client.connected).toBe(false)
    expect(status.connected).toBe(false)
    expect(orders.stale.get()).toBe(0)
    vi.unstubAllGlobals()
  })

  test('what only HTTP carries is refused by the client, not sent to the host', async () => {
    const { client } = mcpApp({ host })
    await expect(client.fetch('/health')).rejects.toThrow(/cannot be relayed/)
    await expect(client.service('orders').patch({ status: 'open' }, { total: 0 })).rejects.toThrow(/filtered bulk write/)
    expect(calls).toEqual([])
  })
})

// ─── the handshake ────────────────────────────────────────────────────────

describe('startView — initialize, the row, the mount', () => {
  /**
   * A parent window speaking the host's half: answers `ui/initialize` with a
   * dark host, answers `tools/call` from `tools`, and keeps what the view
   * notified and answered.
   */
  function hostWindow(tools = {}) {
    const send = data => window.dispatchEvent(new MessageEvent('message', { data, source: host }))
    const host = {
      requests: [], notes: [], answers: [],
      postMessage(msg) {
        if (!msg.method) return void host.answers.push(msg)
        if (!('id' in msg)) return void host.notes.push(msg)
        host.requests.push(msg)
        let reply
        if (msg.method === 'ui/initialize') {
          reply = { result: { protocolVersion: '2026-01-26', hostInfo: { name: 'fake', version: '1' }, hostCapabilities: {}, hostContext: { theme: 'dark' } } }
        } else if (msg.method === 'tools/call' && tools[msg.params.name]) {
          const a = tools[msg.params.name](msg.params.arguments)
          reply = { result: { content: [{ type: 'text', text: JSON.stringify(a) }], structuredContent: a } }
        } else {
          reply = { error: { code: -32601, message: 'Method not found' } }
        }
        queueMicrotask(() => send({ jsonrpc: '2.0', id: msg.id, ...reply }))
      },
      notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
      ask:    (id, method)     => send({ jsonrpc: '2.0', id, method, params: {} }),
      sent:   method           => host.notes.filter(n => n.method === method),
    }
    return host
  }

  /** A component that shows the record it was handed. */
  const View = (anchor, props) => {
    const p = document.createElement('p')
    p.id = 'view'
    p.textContent = JSON.stringify(props.record)
    anchor.parentNode.insertBefore(p, anchor)
  }

  const row = { id: 7, total: 5, note: 'a' }
  const result = (r = row) => ({ content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r })

  let host, orders
  beforeEach(() => {
    _resetMcpApp()
    document.body.innerHTML = ''
    initTheme({ themes: ['theme-default', 'theme-dark'], default: 'theme-default', persist: false })
    host = hostWindow({ orders_patch: ({ id, data }) => ({ ...row, id, ...data }) })
    mcpApp({ host: hostChannel({ target: host, win: window }) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    orders = createResource('orders', { validate: false })
  })
  afterEach(() => vi.restoreAllMocks())

  async function opened(r = result()) {
    const started = startView(View, { name: 'Order', module: { orders } })
    await vi.waitFor(() => expect(host.sent('ui/notifications/initialized')).toHaveLength(1))
    host.notify('ui/notifications/tool-result', r)
    return started
  }

  test('initialize states the protocol, and its hostContext reaches the theme before the mount', async () => {
    const view = await opened()
    expect(host.requests[0]).toMatchObject({ method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'Order' } } })
    expect(theme.value).toBe('theme-dark')
    expect(view).not.toBe(null)
  })

  test('the tool\'s row is the record, and reading it asks the host nothing more', async () => {
    await opened()
    expect(JSON.parse(document.getElementById('view').textContent)).toEqual(row)
    expect(host.requests.filter(r => r.method === 'tools/call')).toEqual([])
  })

  test('the row counts as READ: a save patches what changed against it', async () => {
    await opened()
    await orders.save({ id: 7, total: 5, note: 'b' })
    expect(host.requests.filter(r => r.method === 'tools/call').map(r => r.params))
      .toEqual([{ name: 'orders_patch', arguments: { id: 7, data: { note: 'b' } } }])
  })

  test('the size is reported once mounted', async () => {
    await opened()
    const [size] = host.sent('ui/notifications/size-changed')
    expect(size.params).toEqual({ width: expect.any(Number), height: expect.any(Number) })
  })

  test('a later host-context-changed is applied, a key absent left alone', async () => {
    await opened()
    host.notify('ui/notifications/host-context-changed', { theme: 'light' })
    expect(theme.value).toBe('theme-default')
    host.notify('ui/notifications/host-context-changed', { displayMode: 'fullscreen' })
    expect(theme.value).toBe('theme-default')
  })

  test('teardown unmounts and answers', async () => {
    await opened()
    host.ask('t1', 'ui/resource-teardown')
    await vi.waitFor(() => expect(host.answers).toEqual([{ jsonrpc: '2.0', id: 't1', result: {} }]))
    expect(document.getElementById('view')).toBe(null)
  })

  test('a refused tool call is said in the page, not mounted as an empty form', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = await opened({
      content: [{ type: 'text', text: 'Order not found' }], isError: true,
      structuredContent: { name: 'NotFound', message: 'Order not found', code: 404 },
    })
    expect(view).toBe(null)
    expect(document.getElementById('view')).toBe(null)
    const alert = document.querySelector('[role="alert"]')
    expect(alert.className).toBe('alert danger')
    expect(alert.textContent).toBe('Order not found')
    expect(err).toHaveBeenCalledWith('[sierra/mcp] Order not found')
    // The host still sizes the frame to the message.
    expect(host.sent('ui/notifications/size-changed')).toHaveLength(1)
  })

  test('a cancelled call is said in the page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const started = startView(View, { name: 'Order', module: { orders } })
    await vi.waitFor(() => expect(host.sent('ui/notifications/initialized')).toHaveLength(1))
    host.notify('ui/notifications/tool-cancelled', { reason: 'user action' })
    expect(await started).toBe(null)
    expect(document.querySelector('[role="alert"]').textContent).toBe('The call was cancelled: user action.')
  })

  test('a detailQuery does not stop the view: the record is the tool\'s answer, and a later read with the shape is refused', async () => {
    const invoices = createResource('orders', { validate: false, detailQuery: { directives: { populate: 'lines' } } })
    const started = startView(View, { name: 'Order', module: { invoices } })
    await vi.waitFor(() => expect(host.sent('ui/notifications/initialized')).toHaveLength(1))
    host.notify('ui/notifications/tool-result', result())
    expect(await started).not.toBe(null)
    expect(JSON.parse(document.getElementById('view').textContent)).toEqual(row)
    expect(document.querySelector('[role="alert"]')).toBe(null)
    await expect(invoices.service.get(7)).rejects.toThrow(/\$populate cannot be relayed/)
    expect(host.requests.filter(r => r.method === 'tools/call')).toEqual([])
  })
})


// The half a real sandbox decides — that the browser drops the submit without
// `allow-forms` — is `example`'s `verify:mcp-view`; happy-dom has no sandbox.
describe('submitInPlace — a submit the view dispatches itself', () => {
  // A document of its own: every startView above left its listener on the
  // shared one, and each would dispatch a submit of its own.
  let doc, stop
  beforeEach(() => { doc = document.implementation.createHTMLDocument('') })
  afterEach(() => stop?.())

  const form = (inner) => {
    doc.body.innerHTML = `<form novalidate><input name="a">${inner}</form>`
    const el = doc.querySelector('form')
    const heard = []
    el.addEventListener('submit', e => { e.preventDefault(); heard.push(e.submitter?.id ?? null) })
    return heard
  }

  test('a submit button\'s click becomes ONE submit, naming its submitter, with the activation cancelled', () => {
    const heard = form('<button id="save">Save</button>')
    stop = submitInPlace(doc)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    doc.getElementById('save').dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(heard).toEqual(['save'])
  })

  test('a plain button is left alone', () => {
    const heard = form('<button type="button" id="other">Other</button>')
    stop = submitInPlace(doc)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    doc.getElementById('other').dispatchEvent(click)
    expect([click.defaultPrevented, heard]).toEqual([false, []])
  })

  test('a form that asks for native validation is not submitted while invalid', () => {
    doc.body.innerHTML = '<form><input name="a" required><button id="save">Save</button></form>'
    const heard = []
    doc.querySelector('form').addEventListener('submit', e => { e.preventDefault(); heard.push(1) })
    stop = submitInPlace(doc)
    doc.getElementById('save').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(heard).toEqual([])
  })

  test('removed, it hears nothing', () => {
    form('<button id="save">Save</button>')
    submitInPlace(doc)()
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    doc.getElementById('save').dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
  })
})
