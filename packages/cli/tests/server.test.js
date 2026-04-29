import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
global.fliRoot     = resolve(__dir, '..')
global.projectRoot = resolve(__dir, '..')

// Use a port that won't clash with a running dev server
process.env.FLI_PORT = '13141'
const PORT = 13141
const base = `http://localhost:${PORT}`

const { startServer } = await import('../core/server.js')

let server
beforeAll(async () => {
  server = startServer()
  // Wait for the server to be ready
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
})

afterAll(() => {
  server?.close()
})

// ─── Helper: collect all SSE events from a streaming response ─────────────────
async function collectEvents(res) {
  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  const events  = []
  let buffer    = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { events.push(JSON.parse(line.slice(6))) } catch {}
      }
    }
  }
  return events
}

// ─── GET /api/commands ────────────────────────────────────────────────────────

describe('GET /api/commands', () => {

  test('returns 200 with an array', async () => {
    const res = await fetch(`${base}/api/commands`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  test('each entry has a namespaced title', async () => {
    const cmds = await fetch(`${base}/api/commands`).then(r => r.json())
    for (const cmd of cmds) {
      expect(typeof cmd.title).toBe('string')
      expect(cmd.title).toContain(':')
    }
  })

  test('no alias duplicates in list', async () => {
    const cmds   = await fetch(`${base}/api/commands`).then(r => r.json())
    const titles = cmds.map(c => c.title)
    expect(new Set(titles).size).toBe(titles.length)
  })

  test('known commands are present', async () => {
    const cmds   = await fetch(`${base}/api/commands`).then(r => r.json())
    const titles = cmds.map(c => c.title)
    expect(titles).toContain('hello:greet')
    expect(titles).toContain('hello:exec')
    expect(titles).toContain('make:command')
  })

})

// ─── GET /api/commands/:name ──────────────────────────────────────────────────

describe('GET /api/commands/:name', () => {

  test('returns full metadata for a known command', async () => {
    const res  = await fetch(`${base}/api/commands/hello:greet`)
    expect(res.status).toBe(200)
    const meta = await res.json()
    expect(meta.title).toBe('hello:greet')
    expect(meta.description).toBeTruthy()
    expect(Array.isArray(meta.args)).toBe(true)
    expect(typeof meta.flags).toBe('object')
  })

  test('resolves by alias', async () => {
    const res  = await fetch(`${base}/api/commands/greet`)
    expect(res.status).toBe(200)
    const meta = await res.json()
    expect(meta.title).toBe('hello:greet')
  })

  test('returns 404 for unknown command', async () => {
    const res  = await fetch(`${base}/api/commands/nope:missing`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBeTruthy()
  })

})

// ─── POST /api/run/:name ──────────────────────────────────────────────────────

describe('POST /api/run/:name', () => {

  test('returns 200 with SSE content-type', async () => {
    const res = await fetch(`${base}/api/run/hello:greet`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: ['World'], flags: {} }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
  })

  test('emits output events containing the greeting', async () => {
    const res = await fetch(`${base}/api/run/hello:greet`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: ['World'], flags: { times: 2 } }),
    })
    const events  = await collectEvents(res)
    const outputs = events.filter(e => e.type === 'output')
    expect(outputs.length).toBe(2)
    expect(outputs.every(e => e.text.includes('World'))).toBe(true)
  })

  test('last event is always done', async () => {
    const res = await fetch(`${base}/api/run/hello:greet`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: ['World'], flags: {} }),
    })
    const events = await collectEvents(res)
    expect(events.at(-1)?.type).toBe('done')
  })

  test('--shout flag uppercases output', async () => {
    const res = await fetch(`${base}/api/run/hello:greet`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: ['World'], flags: { shout: true } }),
    })
    const events = await collectEvents(res)
    const text   = events.filter(e => e.type === 'output').map(e => e.text).join('')
    expect(text).toContain('HELLO, WORLD!')
  })

  test('dry run emits a dry log event instead of executing', async () => {
    const res = await fetch(`${base}/api/run/hello:exec`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: ['/tmp'], flags: { dry: true } }),
    })
    const events  = await collectEvents(res)
    const dryLogs = events.filter(e => e.type === 'log' && e.level === 'dry')
    expect(dryLogs.length).toBeGreaterThan(0)
    expect(dryLogs[0].text.length).toBeGreaterThan(0)
  })

  test('returns 404 for unknown command', async () => {
    const res = await fetch(`${base}/api/run/nope:missing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  test('emits error event when a flag has the wrong type', async () => {
    // 'times' is type:number — passing a string triggers a type error in getConfig
    // which throws before any prompts run, so the SSE stream gets an error event
    const res = await fetch(`${base}/api/run/hello:greet`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: ['World'], flags: { times: 'not-a-number' } }),
    })
    const events = await collectEvents(res)
    const errors = events.filter(e => e.type === 'error')
    expect(errors.length).toBeGreaterThan(0)
  })

})

// ─── GET / ────────────────────────────────────────────────────────────────────

describe('GET /', () => {

  test('serves the Web GUI HTML', async () => {
    const res  = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('<title>FLI</title>')
    expect(html).toContain('id="app"')
  })

})

// ─── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {

  test('OPTIONS preflight returns 204 with CORS headers', async () => {
    const res = await fetch(`${base}/api/commands`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  test('all API responses include CORS allow-origin header', async () => {
    const res = await fetch(`${base}/api/commands`)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

})

describe('GET /api/commands/:name — _source blocks', () => {

  test('response includes _source object', async () => {
    const res  = await fetch(`${base}/api/commands/hello:greet`)
    const meta = await res.json()
    expect(meta._source).toBeDefined()
    expect(typeof meta._source).toBe('object')
  })

  test('_source.segments is an array of typed segments', async () => {
    const res  = await fetch(`${base}/api/commands/hello:exec`)
    const meta = await res.json()
    expect(Array.isArray(meta._source.segments)).toBe(true)
    // hello:exec has at least one js code block
    const codeSegments = meta._source.segments.filter(s => s.type === 'code')
    expect(codeSegments.length).toBeGreaterThan(0)
    expect(codeSegments[0].lang).toBe('js')
    expect(typeof codeSegments[0].content).toBe('string')
  })

  test('_source.script contains the script block when present', async () => {
    const res  = await fetch(`${base}/api/commands/hello:exec`)
    const meta = await res.json()
    // hello:exec has a <script> block with buildCommand
    expect(meta._source.script).toBeTruthy()
    expect(typeof meta._source.script).toBe('string')
    expect(meta._source.script).toContain('buildCommand')
  })

  test('_source.script is null when no <script> block', async () => {
    // utils:killnode has no <script> block
    const res  = await fetch(`${base}/api/commands/utils:killnode`)
    const meta = await res.json()
    expect(meta._source.script).toBeNull()
  })

  test('_source.segments contains no prose entries when command has no prose', async () => {
    // utils:killnode is just a single js block, no prose
    const res  = await fetch(`${base}/api/commands/utils:killnode`)
    const meta = await res.json()
    const proseSegments = meta._source.segments.filter(s => s.type === 'prose')
    expect(proseSegments).toHaveLength(0)
  })

})

describe('GET /api/commands — _source field', () => {

  test('every command in the list has a _source field', async () => {
    const res  = await fetch(`${base}/api/commands`)
    const cmds = await res.json()
    for (const cmd of cmds) {
      expect(['core', 'project']).toContain(cmd._source)
    }
  })

  test('core commands are labelled correctly', async () => {
    const res  = await fetch(`${base}/api/commands`)
    const cmds = await res.json()
    const makeCmd = cmds.find(c => c.title === 'make:command')
    expect(makeCmd).toBeDefined()
    expect(makeCmd._source).toBe('core')
  })

  test('project commands are labelled correctly', async () => {
    const res  = await fetch(`${base}/api/commands`)
    const cmds = await res.json()
    const greet = cmds.find(c => c.title === 'hello:greet')
    expect(greet).toBeDefined()
    expect(greet._source).toBe('project')
  })

})
