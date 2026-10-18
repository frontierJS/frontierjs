/**
 * mcp/index.js — the runtime inside an MCP App view.
 *
 * A view is one HTML document the agent's host runs in a sandboxed iframe —
 * no network of its own, every call out through the host as `tools/call`
 * (`IDEAS/agent-client-ui.md` § The wire). `build/mcp-build.js` writes a boot
 * and an entry per resource file; both import this module, and nothing else
 * in an app does. The widget runtime (`widget/index.js`) is the same shape one
 * surface over: a page this app does not own, a generated entry, one runtime.
 *
 * What is here: the relay client (`mcpApp()`, the handle `harborApp()`
 * answers for an extension page), the handshake that opens a view
 * (`startView()`), the mount, the pick of a file's Resource, and the host's
 * context applied to the document.
 */

import { mount }                       from '@frontierjs/mesa/runtime'
import { toolName }                    from '@frontierjs/toolbelt/inflect'
import { splitParams, unknownDirectives, invalidDirectives, listedDirectives, TRANSPORT_PARAMS } from '@frontierjs/toolbelt/directives'
import { setScheme }                   from '../theme/index.js'
import { initJunction, getClient }     from '../resource/index.js'
import { defaultRegistry }             from '../resource/schema-registry.js'
import { hostChannel }                 from './host.js'

// ─── the relay ────────────────────────────────────────────────────────────

let _handle  = null
let _channel = null

// The row the host already sent in `ui/notifications/tool-result`, until the
// view's first read of it. That read goes through the Resource's own
// `_call('get')`, the one place a read is recorded — the baseline a patch
// diffs against and the `@version` it carries back — and is answered from
// here rather than asked of the host a second time.
let _sent = null

/**
 * The page's client, relayed through the host — `{ client, registry, user }`,
 * the handle `createResource(name, { app })` takes.
 *
 * Installed as the page's OWN client through `initJunction`, so a resource
 * file naming no `app` — every file a view is built from — reaches it. Each
 * call leaves as a `tools/call` to the host, named by `toolName()`, and the
 * host makes it against the app's `/mcp` under the MCP session's standing
 * (`FJS-D986`): `user` is null, and the server grades every call (Invariant 6).
 *
 * **Who the caller is stays the host's.** The relayed client holds no
 * credential, so the boot restore asks nothing — `me()` is `account.get('me')`
 * and would leave as a tool call the host runs — and `session.ready` resolves
 * at once with no user and `session.level` null. `resource.can()` reads that
 * as unknown and answers yes, except over a SYSTEM or LOCKED gate, which no
 * level clears; the generated form is locked on that answer.
 *
 * **What the view shows is the tool's answer, never a live one.** A host
 * delivers results and no push, so the client opens no socket and nothing
 * reaches `client.receive()`: a tether holds what this view's own calls
 * returned, `resource.stale` stays 0 because nothing arrived to misplace,
 * `status.connected` stays false and `status.stale` is never set. Somebody
 * else's write is learned of at save, and only on a `@version` model, as the
 * 409 `resource.conflict()` reads (`IDEAS/agent-client-ui.md` 3.5).
 *
 * **A write is never held.** The pending queue, the list cache and the local
 * tables are the app's device, and a view's storage is the host's sandbox
 * origin, where nothing would drain them: the drain waits on the socket above.
 * So a `@@sync` model writes live here, as it does through `connectApp()`, and
 * a failed save fails rather than reporting itself held. A `@@sync(field)`
 * save still carries the row it read, as the tool call's `_meta`, and merges
 * per column (`IDEAS/agent-client-ui.md` 3.6).
 *
 * **The record a view mounts is the tool's answer**, as a page mounts the row
 * `<Model record={row} />` was handed. A Resource's `detailQuery` is a page's
 * question and a by-id tool takes an id alone, so a markup half reading a
 * populated relation finds none in a view; a service whose own `get()`
 * composes the shape answers it through the tool unchanged. A LATER read that
 * carries the shape is refused by name (`IDEAS/agent-client-ui.md` 3.7).
 *
 * @param {{ host?: { request(method: string, params?: object): Promise<unknown> } }} [options]
 *   `host` is the channel to the host; absent, `window.parent` over postMessage
 */
export function mcpApp({ host } = {}) {
  if (_handle) return _handle
  const channel = host ?? hostChannel()
  initJunction({ relay: call => relay(channel, call) })
  _handle  = { client: getClient(), registry: defaultRegistry, user: null }
  _channel = channel
  return _handle
}

/** Drop the handle — for a test that boots a second view in one realm. */
export function _resetMcpApp() { _handle = null; _channel = null; _sent = null }

function relay(channel, call) {
  // Answered before the spelling check: this read never leaves, and the row is
  // the agent's call's answer whatever shape the Resource's `detailQuery` asks
  // for. Every later read is spelled, and one the tool cannot spell is refused.
  const sent = _sent
  if (sent && call.method === 'get' && call.service === sent.service && String(call.id) === String(sent.id)) {
    _sent = null
    return Promise.resolve(sent.row)
  }
  return channel.request('tools/call', toolCall(call)).then(toolAnswer)
}

// The plugin's key for the call option `base`, restated: `@frontierjs/mcp`
// is the API realm and cannot be imported here. Renamed on one side alone, a
// view's merge degrades to a 409 and nothing else says so.
const BASE_META = 'frontierjs/base'

/**
 * One relayed call → the `tools/call` params the app's `mcp()` takes.
 *
 * The argument shape per verb is the plugin's `invoke()` read backwards:
 * `find` takes `{ query, directives }`, a by-id verb `{ id }`, a write by id
 * `{ id, data }`, `create` the row itself, and every other method the
 * `call(name, id, data)` pair. What a tool has no spelling for is REFUSED
 * here by name — a directive on a by-id call, a `$` key the table does not
 * know, a call option other than `base` — because the far side would answer
 * without it: a `$populate` dropped answers the bare row.
 *
 * `base`, the row a `@@sync(field)` write was made against (`FJS-D334`), is
 * the one option a tool call carries, as `_meta` beside the arguments. A host
 * that drops `_meta` sends the write without it, and a row that moved since
 * the view read it answers 409 rather than merging; nothing is overwritten.
 *
 * @param {{ service: string, method: string, id: unknown, data: unknown, query: Record<string, unknown>|null, opts?: object }} call
 * @returns {{ name: string, arguments: Record<string, unknown>, _meta?: Record<string, unknown> }}
 */
export function toolCall(call) {
  const { base, ...rest } = call.opts ?? {}
  const request = toolArguments({ ...call, opts: rest })
  return base == null ? request : { ...request, _meta: { [BASE_META]: base } }
}

function toolArguments({ service, method, id, data, query, opts }) {
  const name  = toolName(service, method)
  const where = `${service}.${method}`
  const set   = Object.keys(opts).filter(k => opts[k] !== undefined && opts[k] !== null)
  if (set.length) {
    throw new Error(`[sierra/mcp] ${where}: ${set.join(', ')} cannot be relayed — a tool call carries its arguments and a base, nothing else`)
  }

  if (method === 'find') {
    const bad = [
      ...unknownDirectives(query), ...invalidDirectives(query), ...listedDirectives(query),
      ...TRANSPORT_PARAMS.filter(p => query && p in query),
    ]
    if (bad.length) throw new Error(`[sierra/mcp] ${where}: ${[...new Set(bad)].join(', ')} cannot be relayed — the find tool takes filters and the directive table, nothing else`)
    const split = splitParams(query)
    const args  = {}
    if (Object.keys(split.query).length)      args.query      = split.query
    if (Object.keys(split.directives).length) args.directives = split.directives
    return { name, arguments: args }
  }

  if (query && Object.keys(query).length) {
    throw new Error(`[sierra/mcp] ${where}: ${Object.keys(query).join(', ')} cannot be relayed — the ${name} tool takes no directives`)
  }
  if (method === 'get' || method === 'remove' || method === 'restore') return { name, arguments: { id } }
  if (method === 'create') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`[sierra/mcp] ${where}: the create tool takes one row, and this is ${Array.isArray(data) ? 'a list' : typeof data}`)
    }
    return { name, arguments: data }
  }
  if (method === 'patch' || method === 'update') {
    // The tool lifts `id` out of the update view, so `data.id` is an unknown
    // key there — and a form saving a whole record always carries it.
    const { id: inData, ...rest } = data ?? {}
    if (inData !== undefined && String(inData) !== String(id)) {
      throw new Error(`[sierra/mcp] ${where}: data.id ${JSON.stringify(inData)} is not the row being written (${JSON.stringify(id)}) — a tool cannot change a key`)
    }
    return { name, arguments: { id, data: rest } }
  }
  if (method === 'aggregate' || method === 'upsert') return { name, arguments: data ?? {} }
  return { name, arguments: { ...(id != null ? { id } : {}), ...(data != null ? { data } : {}) } }
}

/**
 * A `CallToolResult` → what `forward()` would have resolved.
 *
 * The plugin hands back the wire shape already unwrapped, as
 * `structuredContent` when it is an object and as the first text block's JSON
 * when it is not.
 *
 * `isError` throws what the HTTP and socket paths throw: the message, `code`
 * the status, and `data` the refusal body the plugin sent as
 * `structuredContent` — so `err.data.data` is a validation failure's field
 * list on every transport, and `toFieldErrors(err)` lands it under its field.
 * A refusal with no body (a host's own, or the SDK refusing the arguments
 * before the app saw them) throws the text alone, with no `code` to misread.
 *
 * @param {{ content?: Array<{ type: string, text?: string }>, structuredContent?: object, isError?: boolean }} result
 */
export function toolAnswer(result) {
  const text = result?.content?.find(c => c?.type === 'text')?.text
  if (result?.isError) {
    const body = result.structuredContent
    if (!body || typeof body !== 'object') throw new Error(text ?? '[sierra/mcp] the tool refused the call and said nothing')
    throw Object.assign(new Error(String(body.message ?? text ?? 'Service error')), { code: body.code, data: body })
  }
  if (result?.structuredContent !== undefined) return result.structuredContent
  if (text === undefined) throw new Error('[sierra/mcp] the tool answered with no content')
  return JSON.parse(text)
}

// ─── the view ─────────────────────────────────────────────────────────────

/**
 * The Resource a resource file exports.
 *
 * A resource file exports it under the SERVICE's name (`export const orders`),
 * which the build does not know and does not scan for: the module is already
 * loaded by the time the generated form runs, so the real object is read
 * rather than its declaration. It is known by the two methods `<Form>` calls
 * on it. One Resource per file is Invariant 19, so two is refused rather than
 * picked between — two NAMES for one object is one Resource, since a file may
 * alias its export — and none is refused by name: a form over nothing would
 * render empty in a sandbox no console shows.
 *
 * @param {Record<string, unknown>} module  `import * as Resource from '<file>'`
 * @param {string} name                      the file's name, for the message
 */
export function resourceIn(module, name) {
  const found = []
  for (const [key, v] of Object.entries(module)) {
    if (!v || typeof v !== 'object' || typeof v.save !== 'function' || typeof v.formFields !== 'function') continue
    const seen = found.find(f => f[1] === v)
    if (seen) seen[0] += `/${key}`
    else found.push([key, v])
  }
  if (found.length === 1) return found[0][1]
  if (found.length === 0) {
    throw new Error(`[sierra/mcp] ${name}.mesa exports no Resource — a view is a form over createResource(), and nothing in the file's <script module> is one.`)
  }
  throw new Error(
    `[sierra/mcp] ${name}.mesa exports ${found.length} Resources (${found.map(([k]) => k).join(', ')}) — ` +
    `one Resource per file (Invariant 19), so the view cannot say which one its form is over.`
  )
}

/**
 * Apply what the host says about its environment.
 *
 * `ctx` is the spec's `McpUiHostContext` — the whole of it on
 * `ui/initialize`'s answer, and on `ui/notifications/host-context-changed`
 * ONLY the fields that changed, so a key that is absent is a key that is as
 * it was, and nothing is reset for it. What is read today is `theme`, the
 * host's `'light' | 'dark'`, handed to Sierra's switch as the scheme: the
 * switch owns the class on `<html>` (Bridge index) and maps the word onto the
 * pair the app declared, which the boot initialized it with. The host's style
 * variables are later work (plan § Phase 5).
 *
 * @param {{ theme?: 'light'|'dark' } & Record<string, unknown>} ctx
 */
export function applyHostContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return
  if ('theme' in ctx) setScheme(ctx.theme)
}

/**
 * Mount a view into the document.
 *
 * The anchor is a comment appended to `<body>`, which is what the document
 * the build wrote has an empty one of. `startView()` is what calls it in a
 * built view; the mount itself is Mesa's.
 *
 * @param {Function} View            the resource file's compiled default export
 * @param {{ name?: string, props?: object }} [options]
 * @returns {{ $dom: Node, find: (sel: string) => Element|null, destroy: () => void }}
 */
export function mountView(View, { name = 'view', props = {} } = {}) {
  const label = document.createComment(`view:${name}`)
  document.body.appendChild(label)
  return mount(label, View, { props })
}

// ─── the handshake ────────────────────────────────────────────────────────

const PROTOCOL_VERSION = '2026-01-26'

/**
 * Open a view: the handshake, then the row, then the mount.
 *
 * `ui/initialize` → its `hostContext` applied → `ui/notifications/initialized`
 * → the first `ui/notifications/tool-result`, the answer to the agent's call
 * this view belongs to → that row read through the file's Resource → the view
 * mounted with it as `record`, the prop a page's `<Model record={row} />`
 * hands the same file → `ui/notifications/size-changed`, and again whenever
 * the document's size moves. `host-context-changed` is applied as it comes and
 * `ui/resource-teardown` unmounts.
 *
 * What stops the view is said IN THE PAGE as well as on the console, since a
 * host's sandbox shows the person no console: a refused tool call, a cancelled
 * one, a read the relay cannot spell, a file with no Resource.
 *
 * A form's submit is dispatched by the view itself (`submitInPlace`), since a
 * host may withhold `allow-forms`.
 *
 * @param {Function} View  the component the build mounts
 * @param {{ name?: string, module: Record<string, unknown> }} options
 *   `module` is the resource file's exports, which the row is read through
 * @returns {Promise<ReturnType<typeof mountView>|null>} the mounted view, or
 *   null where the page says why there is none
 */
export function startView(View, { name = 'view', module } = {}) {
  mcpApp()
  const channel = _channel
  let view = null
  let stopSize = null
  let closed = false
  const stopSubmit = submitInPlace()

  const first = new Promise(resolve => {
    channel.on('ui/notifications/tool-result',    result => resolve({ result }))
    channel.on('ui/notifications/tool-cancelled', params => resolve({ cancelled: params?.reason ?? null }))
  })
  channel.on('ui/notifications/host-context-changed', applyHostContext)
  channel.on('ui/resource-teardown', () => {
    closed = true
    view?.destroy()
    view = null
    stopSize?.()
    stopSubmit()
    return {}
  })

  return (async () => {
    try {
      const init = await channel.request('ui/initialize', {
        protocolVersion: PROTOCOL_VERSION,
        // The spec requires a version, and a view has none of its own.
        appInfo:         { name, version: '0.0.0' },
        appCapabilities: {},
      })
      applyHostContext(init?.hostContext)
      channel.notify('ui/notifications/initialized')

      const got = await first
      if (closed) return null
      if ('cancelled' in got) {
        stopSize = sayInPage(channel, `The call was cancelled${got.cancelled ? `: ${got.cancelled}` : ''}.`, 'warning')
        return null
      }
      const record = await readSent(resourceIn(module, name), toolAnswer(got.result))
      if (closed) return null
      view = mountView(View, { name, props: { record } })
      stopSize = reportSize(channel)
      return view
    } catch (err) {
      if (!closed) stopSize = sayInPage(channel, err?.message ?? String(err), 'danger')
      return null
    }
  })()
}

/**
 * A form's submit, dispatched by the view rather than by the browser.
 *
 * A host may run the frame without `allow-forms` — the sandbox the spec names
 * is `allow-scripts allow-same-origin` — and there the browser drops a submit
 * BEFORE the `submit` event fires: the kit's `<Form>` never hears its own
 * button, the save does nothing, and only the browser's log says why. A view
 * has no submit but a script's, since a form that navigated would leave the
 * frame for nothing, so the button's activation is cancelled and the event
 * dispatched here whether or not the host granted the flag. Enter in a field
 * arrives as the same click on the form's default button.
 *
 * @returns {() => void} removes the listener
 */
export function submitInPlace(doc = globalThis.document) {
  const onClick = (e) => {
    const submitter = e.target?.closest?.('button, input')
    const form = submitter?.form
    if (!form || (submitter.type !== 'submit' && submitter.type !== 'image')) return
    e.preventDefault()
    if (!form.noValidate && !submitter.formNoValidate && !form.reportValidity()) return
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }))
  }
  doc.addEventListener('click', onClick, true)
  return () => doc.removeEventListener('click', onClick, true)
}

/**
 * The row the tool answered, read through the Resource as any read is.
 *
 * A row with no key — a model whose rows have no identity — has nothing to
 * read back by, and is mounted as sent.
 */
async function readSent(resource, row) {
  const { service, idField } = resource.context
  const id = idField && row && typeof row === 'object' ? row[idField] : null
  if (id == null) return row
  _sent = { service, id, row }
  try {
    return await resource.service.get(id)
  } finally {
    _sent = null
  }
}

/**
 * Tell the host how big the document is, now and whenever that changes.
 *
 * Measured at `height: max-content`: the root element of a frame is at least
 * the frame's own height, so measured as it stands a view could grow its
 * frame and never shrink it again.
 *
 * @returns {() => void} stops the reports
 */
function reportSize(channel, win = globalThis.window) {
  const root = win.document.documentElement
  let width = 0
  let height = 0
  let queued = false
  const measure = () => {
    queued = false
    const was = root.style.height
    root.style.height = 'max-content'
    const h = Math.ceil(root.getBoundingClientRect().height)
    root.style.height = was
    const w = Math.ceil(win.innerWidth)
    if (w === width && h === height) return
    width = w
    height = h
    channel.notify('ui/notifications/size-changed', { width, height })
  }
  measure()
  if (typeof win.ResizeObserver !== 'function') return () => {}
  const observer = new win.ResizeObserver(() => {
    if (queued) return
    queued = true
    win.requestAnimationFrame(measure)
  })
  observer.observe(root)
  observer.observe(win.document.body)
  return () => observer.disconnect()
}

/** Why there is no view, in the page and on the console. */
function sayInPage(channel, message, tone) {
  console.error(`[sierra/mcp] ${message}`)
  const box  = document.createElement('div')
  const text = document.createElement('div')
  box.setAttribute('role', 'alert')
  box.className  = `alert ${tone}`
  text.className = 'alert-content'
  text.textContent = message
  box.append(text)
  document.body.append(box)
  return reportSize(channel)
}
