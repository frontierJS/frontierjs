// A minimal LSP client over stdio — enough to drive the Litestone language
// server the way VS Code does.
//
// Why this exists: `npm run build` succeeding only proves the server compiles.
// Every defect found in this package so far (a null schema crashing completion,
// block detection going negative, attribute detection ignoring the caret) was
// invisible to the compiler and visible here in one request.
//
// No sleeps: requests are correlated by id, and openDoc() resolves on the
// diagnostics notification the server publishes for that document.

const { spawn } = require('child_process')

class LspClient {
  constructor(serverPath) {
    this.serverPath   = serverPath
    this.nextId       = 1
    this.pending      = new Map()   // id -> {resolve, reject}
    this.diagWaiters  = new Map()   // uri -> resolve
    this.diagnostics  = new Map()   // uri -> latest diagnostics array
    this.buf          = Buffer.alloc(0)
    this.proc         = null
    this.stderr       = ''
  }

  async start() {
    this.proc = spawn('node', [this.serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', d => this._onData(d))
    this.proc.stderr.on('data', d => { this.stderr += d })
    this.proc.on('exit', code => {
      this.exitCode = code
      for (const { reject } of this.pending.values()) {
        reject(new Error(`server exited (code ${code})\n${this.stderr}`))
      }
      this.pending.clear()
    })

    const caps = await this.request('initialize', {
      processId: process.pid, rootUri: null, capabilities: {},
    })
    this.notify('initialized', {})
    return caps
  }

  get alive() { return this.proc && this.exitCode === undefined }

  // ─── Framing ────────────────────────────────────────────────────────────────

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n')
      if (sep === -1) return
      const header = this.buf.subarray(0, sep).toString('ascii')
      const match  = /Content-Length: (\d+)/i.exec(header)
      if (!match) { this.buf = this.buf.subarray(sep + 4); continue }
      const len  = Number(match[1])
      const start = sep + 4
      if (this.buf.length < start + len) return          // wait for the rest
      const body = this.buf.subarray(start, start + len).toString('utf8')
      this.buf   = this.buf.subarray(start + len)
      let msg
      try { msg = JSON.parse(body) } catch { continue }
      this._dispatch(msg)
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      return
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = msg.params
      this.diagnostics.set(uri, diagnostics)
      const waiter = this.diagWaiters.get(uri)
      if (waiter) { this.diagWaiters.delete(uri); waiter(diagnostics) }
    }
  }

  _write(msg) {
    const s = JSON.stringify(msg)
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`)
  }

  // ─── Protocol ───────────────────────────────────────────────────────────────

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this._write({ jsonrpc: '2.0', id, method, params })
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`${method} timed out after 5s${this.stderr ? `\n${this.stderr}` : ''}`))
        }
      }, 5000).unref?.()
    })
  }

  notify(method, params) { this._write({ jsonrpc: '2.0', method, params }) }

  /** didOpen, resolving once the server has published diagnostics for it. */
  openDoc(uri, text) {
    return new Promise((resolve, reject) => {
      this.diagWaiters.set(uri, resolve)
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'litestone', version: 1, text },
      })
      setTimeout(() => {
        if (this.diagWaiters.delete(uri)) reject(new Error(`no diagnostics for ${uri} after 5s`))
      }, 5000).unref?.()
    })
  }

  completion(uri, line, character) {
    return this.request('textDocument/completion', {
      textDocument: { uri }, position: { line, character },
    })
  }

  hover(uri, line, character) {
    return this.request('textDocument/hover', {
      textDocument: { uri }, position: { line, character },
    })
  }

  formatting(uri) {
    return this.request('textDocument/formatting', {
      textDocument: { uri }, options: { tabSize: 2, insertSpaces: true },
    })
  }

  stop() { if (this.proc) this.proc.kill() }
}

/** Completion labels, or [] — the server returns a bare array. */
function labels(result) {
  return (Array.isArray(result) ? result : result?.items ?? []).map(i => i.label)
}

/** Hover text, flattened across the shapes MarkupContent can take. */
function hoverText(result) {
  const c = result?.contents
  if (!c) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : x.value)).join('\n')
  return c.value ?? ''
}

module.exports = { LspClient, labels, hoverText }
