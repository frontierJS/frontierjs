// ─── server.js ────────────────────────────────────────────────────────────────
// Thin HTTP wrapper around the FLI runtime.
// Same Command() call as the CLI — only the input source and output method differ.
//
// Endpoints:
//   GET  /api/commands        → array of all command metadata (for nav/sidebar)
//   GET  /api/commands/:name  → single command metadata (for form rendering)
//   POST /api/run/:name       → SSE stream, runs command, emits output as events
//
// SSE event shapes sent to client:
//   data: {"type":"output","text":"Hello, World!\n"}
//   data: {"type":"log","level":"success","text":"Done"}
//   data: {"type":"done"}
//   data: {"type":"error","text":"arg [name] is required!"}
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from 'http'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { basename } from 'path'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const __dir = dirname(fileURLToPath(import.meta.url))
import { buildRegistry, uniqueCommands } from './registry.js'
import { Command } from './runtime.js'
import { extractSegments } from './compiler.js'

import { GLOBAL } from './ports.js'
const PORT = parseInt(process.env.FLI_PORT) || GLOBAL.gui

// ─── Router ───────────────────────────────────────────────────────────────────

function route(req, res) {
  const url  = new URL(req.url, `http://localhost`)
  const path = url.pathname

  // CORS — allow the frontend to run on any origin during dev
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // GET / and any non-API path — serve the Web GUI (client handles routing)
  if (req.method === 'GET' && !path.startsWith('/api/')) {
    return handleStatic(res)
  }

  // GET /api/commands
  if (req.method === 'GET' && path === '/api/commands') {
    return handleList(req, res)
  }

  // GET /api/commands/:name
  const commandMatch = path.match(/^\/api\/commands\/(.+)$/)
  if (req.method === 'GET' && commandMatch) {
    return handleMeta(req, res, decodeURIComponent(commandMatch[1]))
  }

  // GET /api/meta — version and build info
  if (req.method === 'GET' && path === '/api/meta') {
    return handleMeta_info(req, res)
  }

  // GET /api/ports — current session status
  if (req.method === 'GET' && path === '/api/ports') {
    return handlePorts(req, res)
  }

  // POST /api/ports/clean — remove a stale session by name
  if (req.method === 'POST' && path === '/api/ports/clean') {
    return handlePortsClean(req, res)
  }

  // GET /api/ports/schema — port formula constants
  if (req.method === 'GET' && path === '/api/ports/schema') {
    return handlePortsSchema(req, res)
  }

  // GET /api/env — serve the global fli env file contents
  if (req.method === 'GET' && path === '/api/env') {
    return handleEnv(req, res)
  }

  // POST /api/env — save the global fli env file
  if (req.method === 'POST' && path === '/api/env') {
    return handleEnvSave(req, res)
  }

  // POST /api/run/:name
  const runMatch = path.match(/^\/api\/run\/(.+)$/)
  if (req.method === 'POST' && runMatch) {
    return handleRun(req, res, decodeURIComponent(runMatch[1]))
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
}

// ─── GET /api/meta ────────────────────────────────────────────────────────────
function handleMeta_info(req, res) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dir, '../package.json'), 'utf8'))
    json(res, 200, {
      version: pkg.version || '0.1.0',
      built:   pkg._built  || null,
      name:    pkg.name    || 'fli',
    })
  } catch {
    json(res, 200, { version: '0.1.0', built: null, name: 'fli' })
  }
}

// ─── GET /api/ports ───────────────────────────────────────────────────────────
async function handlePorts(req, res) {
  try {
    const { getSessionStatus, GLOBAL } = await import('./ports.js')
    const sessions = getSessionStatus()
    json(res, 200, { sessions, global: GLOBAL })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── POST /api/ports/clean ───────────────────────────────────────────────────
async function handlePortsClean(req, res) {
  try {
    const body = await new Promise((resolve, reject) => {
      let d = ''; req.on('data', c => d += c)
      req.on('end', () => { try { resolve(JSON.parse(d)) } catch { reject(new Error('Invalid JSON')) } })
    })
    const { releaseSession } = await import('./ports.js')
    releaseSession(body.name)
    json(res, 200, { ok: true })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET /api/ports/schema ────────────────────────────────────────────────────
async function handlePortsSchema(req, res) {
  try {
    const { ENV, CAT, GLOBAL } = await import('./ports.js')
    json(res, 200, { ENV, CAT, GLOBAL })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET /api/env ─────────────────────────────────────────────────────────────
function handleEnv(req, res) {
  const envPath = resolve(homedir(), '.config', 'fli', '.env')
  let content = ''
  try { content = readFileSync(envPath, 'utf8') }
  catch { content = '# FLI global environment\n# Add env vars here that apply across all projects\n' }
  json(res, 200, { path: envPath, content })
}

// ─── POST /api/env ────────────────────────────────────────────────────────────
async function handleEnvSave(req, res) {
  try {
    const body = await new Promise((resolve, reject) => {
      let data = ''
      req.on('data', chunk => data += chunk)
      req.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON')) } })
    })
    const { content } = body
    const envPath = resolve(homedir(), '.config', 'fli', '.env')
    const { mkdirSync } = await import('fs')
    mkdirSync(resolve(homedir(), '.config', 'fli'), { recursive: true })
    writeFileSync(envPath, content, 'utf8')
    json(res, 200, { ok: true, path: envPath })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET / ───────────────────────────────────────────────────────────────────

function handleStatic(res) {
  try {
    const html = readFileSync(resolve(__dir, '../web/index.html'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  } catch {
    res.writeHead(404)
    res.end('Web GUI not found — make sure web/index.html exists')
  }
}

// ─── GET /api/commands ────────────────────────────────────────────────────────

function handleList(req, res) {
  try {
    const registry = buildRegistry()
    const commands = uniqueCommands(registry)
    json(res, 200, commands)
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── GET /api/commands/:name ──────────────────────────────────────────────────

async function handleMeta(req, res, name) {
  try {
    const registry = buildRegistry()
    const entry = registry.get(name)
    if (!entry) {
      return json(res, 404, { error: `Command "${name}" not found` })
    }

    // Decompose the .md file into ordered prose+code segments for the GUI.
    // The runtime ignores this — segments are purely for presentation.
    const raw = readFileSync(entry.filePath, 'utf8')
    const { script, segments } = extractSegments(raw)

    const { getModule: getModuleForNs } = await import('./registry.js')
    const cmdNs  = entry.meta.title?.split(':')?.[0]
    const mod    = cmdNs ? getModuleForNs(cmdNs) : null

    // ── Discover _steps* folders alongside the command file ──────────────────────
    const cmdDir  = dirname(entry.filePath)
    const allDirs = existsSync(cmdDir) ? readdirSync(cmdDir, { withFileTypes: true }) : []
    const stepFolders = allDirs
      .filter(d => d.isDirectory() && /^_steps/.test(d.name))
      .map(d => {
        const folderPath = resolve(cmdDir, d.name)
        const steps = existsSync(folderPath)
          ? readdirSync(folderPath)
              .filter(f => f.endsWith('.md') && /^\d/.test(f))
              .sort()
              .map(f => {
                const stepRaw  = readFileSync(resolve(folderPath, f), 'utf8')
                const stepBody = stepRaw.replace(/^---[\s\S]*?---\s*/, '')
                const skipMatch = stepRaw.match(/^skip:\s*(.+)$/m)
                const optMatch  = stepRaw.match(/^optional:\s*(true|false)/m)
                const descMatch = stepRaw.match(/^description:\s*(.+)$/m)
                return {
                  file:        f,
                  name:        basename(f, '.md'),
                  description: descMatch ? descMatch[1].trim() : null,
                  skip:        skipMatch ? skipMatch[1].trim() : null,
                  optional:    optMatch  ? optMatch[1] === 'true' : false,
                }
              })
          : []
        return { folder: d.name, steps, isDefault: d.name === '_steps' }
      })

    // Does ANY js segment set context.config.stepsDir dynamically?
    const dynamicSteps = segments
      .filter(s => s.type === 'code' && s.lang === 'js')
      .some(s => s.content.includes('context.config.stepsDir')
              || s.content.includes('config.stepsDir'))

    // Module's own segments (for namespace docs in the GUI)
    const moduleSource = mod
      ? extractSegments(readFileSync(mod.filePath, 'utf8'))
      : null

    json(res, 200, {
      ...entry.meta,
      _source: {
        script,
        segments,
      },
      _module: mod ? {
        description: mod.meta?.description || null,
        requires:    mod.meta?.requires    || [],
        script:      moduleSource?.script   || null,
        segments:    moduleSource?.segments || [],
      } : null,
      _steps: stepFolders.length ? {
        folders:      stepFolders,
        dynamic:      dynamicSteps,
        folderCount:  stepFolders.length,
        totalSteps:   stepFolders.reduce((n, f) => n + f.steps.length, 0),
      } : null,
    })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

// ─── POST /api/run/:name ──────────────────────────────────────────────────────
// Body: { args: [...], flags: {...} }
// Response: SSE stream

async function handleRun(req, res, name) {
  // Parse request body
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { error: 'Invalid JSON body' })
  }

  const { args = [], flags = {} } = body

  // Look up command
  const registry = buildRegistry()
  const entry = registry.get(name)
  if (!entry) {
    return json(res, 404, { error: `Command "${name}" not found` })
  }

  // Start SSE stream
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  })

  // emit() sends one SSE event to the client
  const emit = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  try {
    const command = await Command({ file: entry.filePath, arg: args, flag: flags, emit })
    await command()
    emit({ type: 'done' })
  } catch (err) {
    emit({ type: 'error', text: err.message })
  } finally {
    res.end()
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body, null, 2))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

// ─── Start ────────────────────────────────────────────────────────────────────

export function startServer() {
  const server = createServer(route)
  server.listen(PORT, () => {
    console.log(`FLI server running on http://localhost:${PORT}`)
    console.log(`  GET  http://localhost:${PORT}/api/commands`)
    console.log(`  POST http://localhost:${PORT}/api/run/:name`)
  })
  return server
}
