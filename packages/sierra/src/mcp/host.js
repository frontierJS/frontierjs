/**
 * mcp/host.js — JSON-RPC 2.0 to the host, over `postMessage`.
 *
 * The MCP Apps wire (`io.modelcontextprotocol/ui`): a view is an iframe, the
 * host is `window.parent`, and every message is a JSON-RPC object posted with
 * `'*'` — the spec's own transport does the same, because a sandboxed frame
 * has an opaque origin and cannot name its parent's. What keeps a stranger
 * out is the SOURCE check: only a message whose `event.source` is the host
 * window is read, so a sibling frame cannot answer a call in the host's name.
 *
 * Written here rather than imported from `@modelcontextprotocol/ext-apps`,
 * whose `App` is ~420 kB with its SDK and zod inside every view. Its host half,
 * `AppBridge`, is the oracle this is graded against (plan step 4.3).
 */

/**
 * @param {{ target?: Window, source?: unknown, win?: Window, timeout?: number }} [options]
 *   `target` is where requests are posted, `source` the only window answers
 *   are read from — both `window.parent` in a view. `win` is the window that
 *   receives them.
 * @returns {{
 *   request(method: string, params?: object): Promise<unknown>,
 *   notify(method: string, params?: object): void,
 *   on(method: string, handler: (params: any) => unknown): void,
 *   close(): void,
 * }}
 *   `on` takes what the host sends: a notification's handler is called with its
 *   params, and a request's handler answers it — its return, awaited, is the
 *   result and its throw the error. A request no handler is registered for is
 *   answered `-32601`, since a host awaiting it would otherwise wait forever.
 */
export function hostChannel({ target, source, win, timeout = 30_000 } = {}) {
  win    ??= globalThis.window
  target ??= win?.parent
  source ??= target
  if (!win || !target || target === win) {
    throw new Error(
      '[sierra/mcp] no host to talk to — a view runs inside the host\'s iframe, and this document is not in one.')
  }

  let seq = 0
  /** @type {Map<number, { resolve: Function, reject: Function, timer: any, method: string }>} */
  const pending = new Map()

  /** @type {Map<string, (params: any) => unknown>} */
  const handlers = new Map()

  function answer(id, body) {
    target.postMessage({ jsonrpc: '2.0', id, ...body }, '*')
  }

  async function received(msg) {
    const handler = handlers.get(msg.method)
    if (!('id' in msg)) {
      handler?.(msg.params)
      return
    }
    if (!handler) return answer(msg.id, { error: { code: -32601, message: `Method not found: ${msg.method}` } })
    try {
      answer(msg.id, { result: (await handler(msg.params)) ?? {} })
    } catch (err) {
      answer(msg.id, { error: { code: -32603, message: err?.message ?? String(err) } })
    }
  }

  function onMessage(event) {
    if (event.source !== source) return
    const msg = event.data
    if (!msg || msg.jsonrpc !== '2.0') return
    if (typeof msg.method === 'string') return void received(msg)
    if (!('id' in msg)) return
    const call = pending.get(msg.id)
    if (!call) return
    pending.delete(msg.id)
    clearTimeout(call.timer)
    if (msg.error) {
      call.reject(Object.assign(
        new Error(`[sierra/mcp] the host refused ${call.method}: ${msg.error.message ?? 'no message'}`),
        { code: msg.error.code, data: msg.error.data }))
    } else {
      call.resolve(msg.result)
    }
  }
  win.addEventListener('message', onMessage)

  return {
    request(method, params) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        // A host that does not implement a method may never answer, and a save
        // that hangs in a frame with no console looks like a slow network.
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Object.assign(new Error(`[sierra/mcp] the host did not answer ${method} within ${timeout} ms`), { code: 408 }))
        }, timeout)
        pending.set(id, { resolve, reject, timer, method })
        target.postMessage({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, '*')
      })
    },
    notify(method, params) {
      target.postMessage({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, '*')
    },
    on(method, handler) {
      handlers.set(method, handler)
    },
    close() {
      win.removeEventListener('message', onMessage)
      handlers.clear()
      for (const { reject, timer, method } of pending.values()) {
        clearTimeout(timer)
        reject(new Error(`[sierra/mcp] the view closed before the host answered ${method}`))
      }
      pending.clear()
    },
  }
}
