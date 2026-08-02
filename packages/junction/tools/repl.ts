// tools/repl.ts
// Junction interactive REPL — talk to any running app over HTTP.
//
// Run:
//   bun run repl                              connects to localhost:3000
//   bun run tools/repl.ts --port 4000
//   bun run tools/repl.ts --host api.myapp.com --https
//
// ─── Commands ─────────────────────────────────────────────────────────────
//
//  HTTP
//   get /path                           GET
//   post /path { "k": "v" }             POST with JSON body
//   patch /path { "k": "v" }            PATCH
//   put /path { "k": "v" }              PUT
//   delete /path                        DELETE
//
//  Shortcuts
//   health                              GET /health
//   metrics                             GET /metrics
//   services                            list registered services (from /metrics)
//
//  Variables  ($ prefix expands anywhere in a command)
//   set <name> <json>                   store a value
//   set <name> = $_.data[0]             store extracted field from last response
//   $name                               expand inline:  post /api/users $payload
//   $_                                  last response body (auto-updated)
//   $_.data[0].id                       dot-path into last response
//   vars                                list all stored variables
//   unset <name>                        delete a variable
//   inspect $name                       pretty-print a variable
//
//  History
//   !N                                  replay history item N
//   history                             show history
//
//  Watch
//   watch /path [interval_ms]           poll every N ms (default 2000)
//                                       press ctrl+c to stop
//  Last
//   last                                reprint the last response
//   last .data[0].id                    extract + print a field from last response
//
//  Session
//   auth <token>                        set bearer token
//   unauth                              clear token
//   header <name> <value>               set persistent header
//   headers                             list headers
//   base <url>                          change base URL
//
//  Misc
//   clear                               clear screen
//   help                                this list
//   exit / quit                         quit

import * as readline from 'node:readline'

// ANSI palette + paint shared with the other CLI tools.
import { c, dim, paint } from './ui.ts'

// ─── CLI args ──────────────────────────────────────────────────────────────

const args   = Bun.argv.slice(2)
const getArg = (flag: string, fallback: string) => {
  const i = args.indexOf(flag)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const useHttps = args.includes('--https')
const host     = getArg('--host', 'localhost')
const port     = parseInt(getArg('--port', '3000'), 10)
let   baseUrl  = `${useHttps ? 'https' : 'http'}://${host}:${port}`

// ─── Session state ─────────────────────────────────────────────────────────

let   authToken: string | null = null
const persistentHeaders: Record<string, string> = {}
const cmdHistory: string[] = []

// ─── Variable store ────────────────────────────────────────────────────────
// $_ is always the last response body.
// Named vars: set foo {"name":"Alice"}  →  post /api/users $foo

const vars: Record<string, unknown> = {}
function setVar(name: string, value: unknown): void { vars[name] = value }

// Dot-path extraction:  getPath(obj, 'data[0].id')
function getPath(obj: unknown, path: string): unknown {
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let cur = obj
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

// Expand $varname and $varname.path.to.field anywhere in a string.
function expandVars(input: string): string {
  return input.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_[\]]+)*)/g, (match, ref) => {
    const dotIdx  = ref.indexOf('.')
    const name    = dotIdx === -1 ? ref : ref.slice(0, dotIdx)
    const subpath = dotIdx === -1 ? null : ref.slice(dotIdx + 1)
    if (!(name in vars)) return match
    const base  = vars[name]
    const value = subpath ? getPath(base, subpath) : base
    if (value === undefined) return match
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  })
}

// ─── Known paths (for tab autocomplete) ───────────────────────────────────

const knownPaths  = new Set<string>(['/health', '/metrics'])

// Standard event names derived from registered services.
// users → users:created, users:patched, users:removed
// Used to autocomplete: webhooks add <url> <event>
const knownEvents = new Set<string>(['*'])

// Fetches /metrics, populates knownPaths + knownEvents.
// Called once at startup and on 'services'/'base'.
async function refreshPaths(): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/metrics`, {
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return
    const data = await res.json() as { services?: { registered?: string[] } }
    const prefix = '/api'
    for (const name of (data.services?.registered ?? [])) {
      knownPaths.add(`${prefix}/${name}`)
      knownPaths.add(`${prefix}/${name}/`)
      // Derive standard event names for webhook autocomplete
      knownEvents.add(`${name}:created`)
      knownEvents.add(`${name}:patched`)
      knownEvents.add(`${name}:removed`)
    }
  } catch { /* app not running yet — silently ignore */ }
}

// Record paths the user has typed so tab can recall them next time.
function learnPath(path: string): void {
  if (path.startsWith('/')) knownPaths.add(path)
}

// ─── Tab autocomplete ──────────────────────────────────────────────────────

const HTTP_CMDS = ['get', 'post', 'patch', 'put', 'delete']
const ALL_CMDS  = [
  ...HTTP_CMDS,
  'health', 'metrics', 'services',
  'auth', 'unauth', 'header', 'headers', 'base',
  'set', 'vars', 'unset', 'inspect', 'last', 'watch',
  'history', 'clear', 'help', 'tutorial', 'webhooks', 'setup', 'litestone', 'exit', 'quit',
]

function completer(line: string): [string[], string] {
  const trimmed = line.trimStart()

  // Completing the command verb (no space yet)
  if (!trimmed.includes(' ')) {
    const hits = ALL_CMDS.filter(cmd => cmd.startsWith(trimmed.toLowerCase()))
    return [hits.length ? hits.map(h => h + ' ') : [], line]
  }

  const [cmd, ...rest] = trimmed.split(/\s+/)
  const lower = cmd.toLowerCase()

  // Completing a path argument (first arg after an HTTP command or watch/last)
  if ([...HTTP_CMDS, 'watch', 'last'].includes(lower) && rest.length <= 1) {
    const partial = rest[0] ?? ''
    if (rest.length > 1) return [[], line]
    const hits = [...knownPaths].filter(p => p.startsWith(partial))
    if (!hits.length) return [[], line]
    return [hits.map(h => `${lower} ${h}`), line]
  }

  // Completing a variable name after set/unset/inspect
  if (['set', 'unset', 'inspect'].includes(lower) && rest.length === 1) {
    const partial  = rest[0].replace(/^\$/, '')
    const varNames = ['_', ...Object.keys(vars).filter(k => k !== '_')]
    const hits     = varNames.filter(v => v.startsWith(partial))
    return [hits.map(h => `${lower} ${h} `), line]
  }

  // webhooks add <url> <event> [event...]
  // After the URL (rest[1]+), tab-complete event names from knownEvents
  if (lower === 'webhooks' && rest[0] === 'add' && rest.length >= 2) {
    // rest[1] = url, rest[2..] = events already typed, last token = partial event
    const partial   = rest[rest.length - 1] ?? ''
    const alreadyIn = new Set(rest.slice(2, -1))  // events already confirmed
    const hits = [...knownEvents]
      .filter(e => e.startsWith(partial) && !alreadyIn.has(e))
    if (!hits.length) return [[], line]
    // Build the full completed line up to this point
    const prefix = [lower, ...rest.slice(0, -1)].join(' ')
    return [hits.map(h => `${prefix} ${h} `), line]
  }

  return [[], line]
}

// ─── Pretty JSON ───────────────────────────────────────────────────────────

function colorizeJson(value: unknown, indent = 0): string {
  const pad   = '  '.repeat(indent)
  const inner = '  '.repeat(indent + 1)

  if (value === null)             return paint(c.byellow, 'null')
  if (value === true)             return paint(c.bgreen,  'true')
  if (value === false)            return paint(c.bred,    'false')
  if (typeof value === 'number')  return paint(c.bcyan,   String(value))
  if (typeof value === 'string') {
    if (value.startsWith('http://') || value.startsWith('https://'))
      return paint(c.bblue, `"${value}"`)
    if (/^\d{4}-\d{2}-\d{2}T/.test(value))
      return paint(c.bmagenta, `"${value}"`)
    return paint(c.bgreen, `"${value}"`)
  }
  if (Array.isArray(value)) {
    if (!value.length) return paint(c.gray, '[]')
    const items = value.map(v => `${inner}${colorizeJson(v, indent + 1)}`).join(',\n')
    return `${paint(c.gray, '[')}
${items}
${pad}${paint(c.gray, ']')}`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.length) return paint(c.gray, '{}')
    const lines = entries.map(([k, v]) =>
      `${inner}${paint(c.cyan, `"${k}"`)}: ${colorizeJson(v, indent + 1)}`
    ).join(',\n')
    return `${paint(c.gray, '{')}
${lines}
${pad}${paint(c.gray, '}')}`
  }
  return String(value)
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

interface ReplResponse {
  status:  number
  ok:      boolean
  headers: Record<string, string>
  body:    unknown
  ms:      number
}

async function doRequest(method: string, path: string, body?: unknown): Promise<ReplResponse> {
  const url = path.startsWith('http') ? path : `${baseUrl}${path}`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'accept':       'application/json',
    ...persistentHeaders,
  }
  if (authToken) headers['authorization'] = `Bearer ${authToken}`

  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = JSON.stringify(body)

  const start = Date.now()
  const res   = await fetch(url, init)
  const ms    = Date.now() - start

  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch {}

  const respHeaders: Record<string, string> = {}
  res.headers.forEach((v, k) => { respHeaders[k] = v })

  return { status: res.status, ok: res.ok, headers: respHeaders, body: parsed, ms }
}

// ─── Printers ──────────────────────────────────────────────────────────────

function statusBadge(s: number) {
  if (s >= 500) return paint(c.bred,    ` ${s} `)
  if (s >= 400) return paint(c.byellow, ` ${s} `)
  if (s >= 300) return paint(c.bcyan,   ` ${s} `)
  return               paint(c.bgreen,  ` ${s} `)
}

function methodBadge(m: string) {
  const col: Record<string, string> = {
    GET: c.bblue, POST: c.bgreen, PATCH: c.byellow, PUT: c.bcyan, DELETE: c.bred,
  }
  return paint(col[m] ?? c.bwhite, m)
}

let lastResponse: ReplResponse | null = null

function printResponse(method: string, path: string, r: ReplResponse, label?: string): void {
  const sep = paint(c.gray, '─'.repeat(60))
  console.log()
  if (label) console.log(`  ${paint(c.gray, label)}`)
  console.log(`  ${methodBadge(method)} ${paint(c.bwhite, path)}  ${statusBadge(r.status)}  ${paint(c.gray, `${r.ms}ms`)}`)
  console.log(sep)
  console.log(colorizeJson(r.body))
  console.log()
}

function printError(msg: string)   { console.log(`\n  ${paint(c.bred, '✗')} ${paint(c.bwhite, msg)}\n`) }
function printInfo(msg: string)    { console.log(`\n  ${paint(c.bblue, '→')} ${paint(c.gray, msg)}\n`) }
function printSuccess(msg: string) { console.log(`\n  ${paint(c.bgreen, '✓')} ${paint(c.gray, msg)}\n`) }

// ─── Help ──────────────────────────────────────────────────────────────────

// ─── Tutorial system ───────────────────────────────────────────────────────
//
// An embedded interactive guide. Each step explains a concept, shows an
// example, waits for the user to actually run it, and validates the outcome.
//
// The tutorial hooks into dispatch() — it doesn't block normal REPL usage.
// Every command the user types is still executed; the tutorial just watches
// what happened and advances (or gives feedback) accordingly.

interface TutorialStep {
  title:    string
  explain:  string[]          // lines of markdown-ish prose, printed before the prompt
  example?: string            // highlighted command to try
  hint?:    string            // shorter nudge shown after a wrong attempt
  // Returns true to advance, a string to show as "try again" feedback,
  // or false to silently wait for another attempt.
  validate: (
    line:     string,
    resp:     ReplResponse | null,
    vars:     Record<string, unknown>
  ) => boolean | string
}

interface TutorialChapter {
  id:    string
  title: string
  intro: string
  steps: TutorialStep[]
}

// ── Chapter definitions ────────────────────────────────────────────────────

const CHAPTERS: TutorialChapter[] = [

  // ── 1. First requests ─────────────────────────────────────────────────
  {
    id:    'basics',
    title: 'Making requests',
    intro: 'Learn the five HTTP verbs and how responses look.',
    steps: [

      {
        title:   'Check the app is alive',
        explain: [
          'Every Junction app exposes a ${cmd}/health${r} endpoint.',
          'It returns a JSON snapshot: status, uptime, and any readiness checks.',
          '',
          'Try it now:',
        ],
        example: 'health',
        hint:    'Type: health',
        validate(line) {
          return line.trim().toLowerCase() === 'health' || line.trim().toLowerCase() === 'get /health'
        },
      },

      {
        title:   'List a service',
        explain: [
          'Services are auto-routed at ${cmd}/api/{service}${r}.',
          'A GET with no ID calls the ${cmd}find${r} method — returns a paginated list.',
          '',
          'Run ${cmd}services${r} to see what\'s registered, then try listing one:',
        ],
        example: 'get /api/users',
        hint:    'Try: get /api/<service-name>',
        validate(line) {
          const m = line.trim().match(/^get\s+(\/[^\s]+)/i)
          if (!m) return 'Use the GET verb:  get /api/something'
          return true
        },
      },

      {
        title:   'Fetch a single record',
        explain: [
          'Append an ID to get one record — routes to the ${cmd}get${r} method.',
          '',
          'The response is a single object, not a list.',
        ],
        example: 'get /api/users/1',
        hint:    'Try: get /api/<service>/<id>',
        validate(line, resp) {
          const m = line.trim().match(/^get\s+\/[^\s]+\/[^\s]+/i)
          if (!m) return 'Include an ID segment:  get /api/users/1'
          if (resp && resp.status === 404) return `Got 404 — try a different ID. Check ${paint(c.bcyan, 'get /api/users')} first to see what IDs exist.`
          return true
        },
      },

      {
        title:   'Create a record',
        explain: [
          'POST to a service collection creates a record — routes to ${cmd}create${r}.',
          'The body is plain JSON on the same line as the command.',
          '',
          '${note}The framework validates and transforms data through your hook pipeline${r}',
          'before it ever reaches the database.',
        ],
        example: 'post /api/users {"name":"Tutorial User","email":"tut@example.com"}',
        hint:    'Try: post /api/<service> { ... }',
        validate(line, resp) {
          if (!line.trim().toLowerCase().startsWith('post')) return 'Use POST to create:  post /api/...'
          if (!resp) return false
          if (resp.status === 400) return `Got 400 — check the required fields for this service. Try ${paint(c.bcyan, 'get /api/<service>')} to see the shape of existing records.`
          if (!resp.ok) return `Got ${resp.status} — adjust the body and try again.`
          return true
        },
      },

      {
        title:   'Update a record',
        explain: [
          'PATCH updates specific fields — only what you send changes.',
          'PUT replaces the whole record.',
          '',
          'Use the ID you got back from the last create.',
        ],
        example: 'patch /api/users/$_.id {"name":"Updated Name"}',
        hint:    'Try: patch /api/<service>/<id> { ... }',
        validate(line, resp) {
          if (!line.trim().match(/^patch|^put/i)) return 'Use PATCH or PUT:  patch /api/...'
          if (resp && resp.status === 404) return `404 — the ID wasn't found. Check ${paint(c.bcyan, 'last .id')} to get the ID from your last response.`
          if (resp && !resp.ok) return `Got ${resp.status} — adjust and try again.`
          return true
        },
      },

      {
        title:   'Delete a record',
        explain: [
          'DELETE removes a record by ID.',
          '',
          'A successful delete returns the deleted record (or null).',
          '${note}Junction requires allowBulk:true to delete without an ID — a safety guard.${r}',
        ],
        example: 'delete /api/users/$_.id',
        hint:    'Try: delete /api/<service>/<id>',
        validate(line, resp) {
          if (!line.trim().toLowerCase().startsWith('delete')) return 'Use DELETE:  delete /api/...'
          if (resp && resp.status === 404) return '404 — try a different ID.'
          if (resp && !resp.ok) return `Got ${resp.status}.`
          return true
        },
      },
    ],
  },

  // ── 2. Auth ────────────────────────────────────────────────────────────
  {
    id:    'auth',
    title: 'Authentication',
    intro: 'Set a bearer token and see how it flows through the app.',
    steps: [

      {
        title:   'Set your token',
        explain: [
          'The REPL attaches a ${cmd}Authorization: Bearer <token>${r} header to every',
          'request once a token is set. The prompt dot turns green (${grn}●${r}) to remind you.',
          '',
          'In the example app, the demo auth accepts an email as a token.',
          'Set one now:',
        ],
        example: 'auth demo@example.com',
        hint:    'Type: auth <your-token>',
        validate(line) {
          return line.trim().toLowerCase().startsWith('auth ') && line.trim().split(/\s+/).length >= 2
        },
      },

      {
        title:   'Make an authenticated request',
        explain: [
          'Now make any request — the token rides along automatically.',
          'The service receives ${cmd}ctx.auth.user${r} populated with your session.',
          '',
          'Routes protected by the ${cmd}authenticate${r} hook will now succeed.',
        ],
        example: 'get /api/users',
        hint:    'Try any GET request',
        validate(line, resp) {
          if (!line.trim().match(/^get|^post|^patch|^put|^delete|^health|^services/i)) return false
          if (resp?.status === 401) return 'Still getting 401 — is the token accepted by your auth provider?'
          return true
        },
      },

      {
        title:   'Inspect the auth headers',
        explain: [
          '${cmd}headers${r} shows every persistent header the REPL is sending,',
          'including your truncated bearer token.',
        ],
        example: 'headers',
        hint:    'Type: headers',
        validate(line) {
          return line.trim().toLowerCase() === 'headers'
        },
      },

      {
        title:   'Clear the token',
        explain: [
          '${cmd}unauth${r} clears the token. The prompt dot goes grey (${gry}○${r}).',
          'Useful when testing public vs protected endpoints side-by-side.',
        ],
        example: 'unauth',
        hint:    'Type: unauth',
        validate(line) {
          return line.trim().toLowerCase() === 'unauth'
        },
      },
    ],
  },

  // ── 3. Variables ───────────────────────────────────────────────────────
  {
    id:    'variables',
    title: 'Variables & $_ ',
    intro: 'Use $_ and named variables to chain requests without copy-pasting.',
    steps: [

      {
        title:   'Meet $_',
        explain: [
          '${cmd}$_${r} is automatically set to the body of every response.',
          'After any request, you can use ${cmd}last${r} to reprint it',
          'or ${cmd}inspect $_${r} to explore it.',
          '',
          'Make any request to seed $_:',
        ],
        example: 'get /health',
        hint:    'Make any request — get, post, health, etc.',
        validate(_line, resp) {
          return resp !== null
        },
      },

      {
        title:   'Extract a field from $_',
        explain: [
          'Dot-path notation drills into the last response without a variable:',
          '',
          '  ${cmd}last .status${r}               a top-level field',
          '  ${cmd}last .data[0].id${r}            nested array access',
          '  ${cmd}last .checks.database.status${r} deep path',
          '',
          'Try extracting a field from the last response:',
        ],
        example: 'last .status',
        hint:    'Try: last .<fieldname>',
        validate(line) {
          return line.trim().toLowerCase().startsWith('last .')
        },
      },

      {
        title:   'Store a value in a variable',
        explain: [
          '${cmd}set${r} stores any JSON value under a name.',
          'You can also capture a field from $_:',
          '',
          '  ${cmd}set payload {"name":"Alice","role":"admin"}${r}',
          '  ${cmd}set id = $_.id${r}',
          '  ${cmd}set first = $_.data[0]${r}',
          '',
          'Try storing something:',
        ],
        example: 'set payload {"name":"Tutorial","email":"t@example.com"}',
        hint:    'Try: set <name> <json>  or  set <name> = $_.field',
        validate(line, _resp, v) {
          if (!line.trim().toLowerCase().startsWith('set ')) return 'Use set to store:  set name <json>'
          const name = line.trim().split(/\s+/)[1]
          return name && name in v ? true : false
        },
      },

      {
        title:   'Use a variable inline',
        explain: [
          'Prefix any variable name with ${cmd}$${r} to expand it in a command.',
          '',
          '  ${cmd}post /api/users $payload${r}         expand as body',
          '  ${cmd}get /api/users/$id${r}               expand in path',
          '  ${cmd}patch /api/users/$id $payload${r}    both at once',
          '',
          'Try using a variable you set:',
        ],
        example: 'post /api/users $payload',
        hint:    'Use $variablename anywhere in a command',
        validate(line) {
          return line.includes('$') && !line.trim().startsWith('set ') && !line.trim().startsWith('inspect')
        },
      },

      {
        title:   'List and inspect variables',
        explain: [
          '${cmd}vars${r} shows all stored variables with a truncated preview.',
          '${cmd}inspect $name${r} pretty-prints the full value.',
          '${cmd}inspect $_.data[0]${r} drills into the last response.',
          '',
          'Try ${cmd}vars${r} then ${cmd}inspect${r} one of them:',
        ],
        example: 'vars',
        hint:    'Type: vars',
        validate(line) {
          return line.trim().toLowerCase() === 'vars' ||
                 line.trim().toLowerCase().startsWith('inspect')
        },
      },
    ],
  },

  // ── 4. Power features ──────────────────────────────────────────────────
  {
    id:    'power',
    title: 'Power features',
    intro: 'Watch, history replay, and the services overview.',
    steps: [

      {
        title:   'Explore your services',
        explain: [
          '${cmd}services${r} hits ${cmd}/metrics${r} and prints a clean table of registered',
          'services and their base paths.',
          '',
          'It also refreshes the tab-autocomplete path list, so after running this,',
          'tab after ${cmd}get${r} will complete all your service paths.',
        ],
        example: 'services',
        hint:    'Type: services',
        validate(line) {
          return line.trim().toLowerCase() === 'services'
        },
      },

      {
        title:   'History replay with !N',
        explain: [
          '${cmd}history${r} prints every command you\'ve run this session, numbered.',
          '${cmd}!N${r} replays entry N exactly — useful for re-running a complex',
          'POST body without retyping it.',
          '',
          'Run history, then replay a command:',
        ],
        example: 'history',
        hint:    'Type: history  then  !<number>',
        validate(line) {
          return line.trim().toLowerCase() === 'history' || /^!\d+$/.test(line.trim())
        },
      },

      {
        title:   'Watch an endpoint',
        explain: [
          '${cmd}watch /path [ms]${r} polls an endpoint on an interval and reprints',
          'the response each time. Useful for watching a job status, queue depth,',
          'or live health check while running load.',
          '',
          '${note}$_ is updated on every poll, so you can set a variable from a watch result.${r}',
          '',
          'Start a watch — press ctrl+c to stop it:',
        ],
        example: 'watch /health 1500',
        hint:    'Type: watch /health 1500',
        validate(line) {
          return line.trim().toLowerCase().startsWith('watch ')
        },
      },

      {
        title:   'The /metrics endpoint',
        explain: [
          '${cmd}/metrics${r} gives a full runtime snapshot — process memory, request',
          'counts by method, response type breakdown, WebSocket connections,',
          'cache hit rate, and the service registry.',
          '',
          'This is everything you need to answer "what is the app actually doing?" in prod.',
        ],
        example: 'metrics',
        hint:    'Type: metrics',
        validate(line) {
          return line.trim().toLowerCase() === 'metrics' || line.trim().toLowerCase() === 'get /metrics'
        },
      },
    ],
  },
]

// ── Tutorial state machine ─────────────────────────────────────────────────

interface TutorialState {
  active:       boolean
  chapterIdx:   number
  stepIdx:      number
  attempts:     number
  skippedSteps: number
}

const tut: TutorialState = {
  active:       false,
  chapterIdx:   0,
  stepIdx:      0,
  attempts:     0,
  skippedSteps: 0,
}

function tutChapter(): TutorialChapter { return CHAPTERS[tut.chapterIdx] }
function tutStep():    TutorialStep    { return tutChapter().steps[tut.stepIdx] }

function tutTotalSteps(): number {
  return CHAPTERS.reduce((n, ch) => n + ch.steps.length, 0)
}

function tutCompletedSteps(): number {
  let n = 0
  for (let c = 0; c < tut.chapterIdx; c++) n += CHAPTERS[c].steps.length
  n += tut.stepIdx
  return n
}

// Render inline tokens:  ${cmd}text${r}  ${note}text${r}  ${grn}  ${gry}
function renderTutText(text: string): string {
  return text
    .replace(/\$\{cmd\}(.*?)\$\{r\}/g,  (_, t) => paint(c.bcyan,   t))
    .replace(/\$\{note\}(.*?)\$\{r\}/g, (_, t) => paint(c.gray,    t))
    .replace(/\$\{grn\}(.*?)\$\{r\}/g,  (_, t) => paint(c.bgreen,  t))
    .replace(/\$\{gry\}(.*?)\$\{r\}/g,  (_, t) => paint(c.gray,    t))
    .replace(/\$\{yel\}(.*?)\$\{r\}/g,  (_, t) => paint(c.byellow, t))
}

function printTutProgress(): void {
  const done  = tutCompletedSteps()
  const total = tutTotalSteps()
  const pct   = Math.round((done / total) * 100)
  const bar   = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5))
  const ch    = tutChapter()
  const step  = tutStep()

  console.log()
  console.log(
    `  ${paint(c.gray, `Chapter ${tut.chapterIdx + 1}/${CHAPTERS.length}`)}  ` +
    `${paint(c.bwhite, ch.title)}`
  )
  console.log(
    `  ${paint(c.gray, `Step ${tut.stepIdx + 1}/${ch.steps.length}`)}       ` +
    `${paint(c.bwhite, step.title)}`
  )
  console.log(
    `  ${paint(c.bcyan, bar)}  ${paint(c.gray, `${pct}%`)}`
  )
}

function printTutStep(): void {
  const step = tutStep()
  const sep  = paint(c.gray, '─'.repeat(58))

  printTutProgress()
  console.log(`  ${sep}`)
  console.log()

  for (const line of step.explain) {
    console.log(`  ${renderTutText(line)}`)
  }

  if (step.example) {
    console.log()
    console.log(`  ${paint(c.gray, 'example →')}  ${paint(c.bcyan, step.example)}`)
  }

  console.log()
  console.log(
    `  ${paint(c.gray, 'type the command above, or')} ` +
    `${paint(c.byellow, 'skip')} ${paint(c.gray, 'to move on, or')} ` +
    `${paint(c.byellow, 'quit tutorial')} ${paint(c.gray, 'to exit')}`
  )
  console.log()
}

function printTutPass(feedback?: string): void {
  const msgs = [
    'Nice work.',
    'Exactly right.',
    'Perfect.',
    'That\'s it.',
    'Correct.',
    'Well done.',
  ]
  const msg = msgs[Math.floor(Math.random() * msgs.length)]
  console.log()
  console.log(`  ${paint(c.bgreen, '✓')} ${paint(c.bwhite, msg)}${feedback ? '  ' + paint(c.gray, feedback) : ''}`)
  console.log()
}

function advanceTutorial(): void {
  const ch = tutChapter()

  tut.stepIdx++
  tut.attempts = 0

  if (tut.stepIdx >= ch.steps.length) {
    // Chapter complete
    tut.stepIdx = 0
    tut.chapterIdx++

    if (tut.chapterIdx >= CHAPTERS.length) {
      // All done
      tut.active = false
      const skipped = tut.skippedSteps
      console.log()
      console.log(`  ${paint(c.bgreen, '★')} ${paint(c.bold + c.bwhite, 'Tutorial complete!')}`)
      console.log()
      console.log(`  You covered all ${tutTotalSteps()} steps across ${CHAPTERS.length} chapters.`)
      if (skipped > 0) console.log(`  ${paint(c.gray, `(${skipped} step${skipped > 1 ? 's' : ''} skipped — come back any time with`)} ${paint(c.bcyan, 'tutorial')}${paint(c.gray, ')')}`)
      console.log()
      console.log(`  ${paint(c.gray, 'What to explore next:')}`)
      console.log(`  ${paint(c.bcyan, 'watch /api/users 2000')}   ${paint(c.gray, '— live polling')}`)
      console.log(`  ${paint(c.bcyan, 'inspect $_')}              ${paint(c.gray, '— dig into any response')}`)
      console.log(`  ${paint(c.bcyan, 'help')}                    ${paint(c.gray, '— full command reference')}`)
      console.log()
      return
    }

    // Print next chapter intro
    const next = tutChapter()
    console.log()
    console.log(`  ${paint(c.bblue, '→')} ${paint(c.bold + c.bwhite, `Chapter ${tut.chapterIdx + 1}: ${next.title}`)}`)
    console.log(`  ${paint(c.gray, next.intro)}`)
  }

  printTutStep()
}

// Called from dispatch() after every command while tut.active is true.
// Returns true if the tutorial consumed the event (step passed or feedback given).
function tutEval(line: string, resp: ReplResponse | null): boolean {
  if (!tut.active) return false

  const lower = line.trim().toLowerCase()

  // Tutorial meta-commands
  if (lower === 'quit tutorial' || lower === 'exit tutorial') {
    tut.active = false
    console.log()
    console.log(`  ${paint(c.gray, 'Tutorial paused. Resume any time with')} ${paint(c.bcyan, 'tutorial')}`)
    console.log()
    return true
  }

  if (lower === 'skip') {
    tut.skippedSteps++
    console.log(`  ${paint(c.gray, '→ skipped')}`)
    advanceTutorial()
    return true
  }

  if (lower === 'help tutorial' || lower === 'tutorial help') {
    console.log()
    console.log(`  ${paint(c.gray, 'While in the tutorial:')}`)
    console.log(`  ${paint(c.bcyan, 'skip')}          ${paint(c.gray, 'skip this step')}`)
    console.log(`  ${paint(c.bcyan, 'quit tutorial')}  ${paint(c.gray, 'exit the tutorial (progress saved)')}`)
    console.log(`  ${paint(c.bcyan, 'tutorial')}       ${paint(c.gray, 'restart or pick a chapter')}`)
    console.log()
    return true
  }

  // Don't validate on pure navigation commands
  if (['clear', 'history', 'vars', 'headers'].includes(lower)) return false

  // Run the step's validator
  const step   = tutStep()
  const result = step.validate(line, resp, vars)
  tut.attempts++

  if (result === true) {
    printTutPass()
    advanceTutorial()
    return true
  }

  // Feedback after 2+ failed attempts, or if validator returned a string
  if (typeof result === 'string') {
    console.log(`  ${paint(c.byellow, '→')} ${paint(c.gray, result)}`)
    console.log()
  } else if (tut.attempts >= 2 && step.hint) {
    console.log(`  ${paint(c.byellow, '→')} ${paint(c.gray, step.hint)}`)
    console.log()
  }

  return false
}

// ── Tutorial entry-point command ───────────────────────────────────────────

function startTutorial(chapterId?: string): void {

  // Find chapter if specified
  if (chapterId) {
    const idx = CHAPTERS.findIndex(ch => ch.id === chapterId || ch.title.toLowerCase().includes(chapterId.toLowerCase()))
    if (idx === -1) {
      printError(`Unknown chapter: ${chapterId}`)
      console.log(`  ${paint(c.gray, 'Available chapters:')}`)
      CHAPTERS.forEach((ch, i) => {
        console.log(`  ${paint(c.bcyan, ch.id.padEnd(14))} ${paint(c.gray, `(${i + 1})`)} ${ch.title}  — ${ch.intro}`)
      })
      console.log()
      return
    }
    tut.chapterIdx = idx
    tut.stepIdx    = 0
    tut.attempts   = 0
  } else if (!tut.active) {
    // Fresh start or resume
    if (tut.chapterIdx > 0 || tut.stepIdx > 0) {
      // Already started — ask to resume or restart
      const done = tutCompletedSteps()
      console.log()
      console.log(`  ${paint(c.bblue, '→')} ${paint(c.gray, `You're at step ${done + 1}/${tutTotalSteps()}.`)}`)
      console.log()
      console.log(`  ${paint(c.bcyan, 'tutorial resume')}       continue from here`)
      console.log(`  ${paint(c.bcyan, 'tutorial restart')}      start over`)
      CHAPTERS.forEach(ch => {
        console.log(`  ${paint(c.bcyan, `tutorial ${ch.id}`)}  ${paint(c.gray, ch.title)}`)
      })
      console.log()
      return
    }
  }

  tut.active = true

  const ch = tutChapter()
  const sep = paint(c.gray, '═'.repeat(58))

  console.log()
  console.log(`  ${sep}`)
  console.log(`  ${paint(c.bold + c.bwhite, 'Junction REPL Tutorial')}`)
  console.log(`  ${sep}`)
  console.log()
  console.log(`  ${paint(c.gray, `${CHAPTERS.length} chapters · ${tutTotalSteps()} steps · type`)} ${paint(c.byellow, 'skip')} ${paint(c.gray, 'to skip a step')}`)
  console.log(`  ${paint(c.gray, 'The REPL still works normally — just run commands to advance.')}`)
  console.log()

  if (chapterId || (tut.chapterIdx === 0 && tut.stepIdx === 0)) {
    console.log(`  ${paint(c.bblue, '→')} ${paint(c.bold + c.bwhite, `Chapter ${tut.chapterIdx + 1}: ${ch.title}`)}`)
    console.log(`  ${paint(c.gray, ch.intro)}`)
    console.log()
  }

  printTutStep()
}

function handleTutorialCommand(rest: string[]): void {
  const sub = rest.join(' ').toLowerCase().trim()

  if (!sub || sub === 'start') { startTutorial(); return }

  if (sub === 'resume') {
    tut.active = true
    printTutStep()
    return
  }

  if (sub === 'restart') {
    tut.chapterIdx = 0
    tut.stepIdx    = 0
    tut.attempts   = 0
    tut.skippedSteps = 0
    startTutorial()
    return
  }

  if (sub === 'list' || sub === 'chapters') {
    console.log()
    console.log(`  ${paint(c.bold + c.bwhite, 'Tutorial chapters')}`)
    console.log()
    CHAPTERS.forEach((ch, i) => {
      const current = i === tut.chapterIdx && tut.active ? paint(c.bgreen, ' ◀ current') : ''
      console.log(`  ${paint(c.bcyan, ch.id.padEnd(14))} ${paint(c.gray, ch.title)}${current}`)
      console.log(`  ${' '.repeat(14)} ${paint(c.gray, ch.intro)}`)
      console.log()
    })
    return
  }

  // Otherwise treat as a chapter id
  startTutorial(sub)
}

function printHelp(): void {
  const cmd  = (s: string) => paint(c.bcyan,   s)
  const arg  = (s: string) => paint(c.byellow, s)
  const note = (s: string) => paint(c.gray,    s)

  console.log(`
  ${paint(c.bold + c.bwhite, 'HTTP')}
    ${cmd('get')} ${arg('/path')}                             GET
    ${cmd('post')} ${arg('/path')} ${arg('{ "k":"v" }')}           POST with JSON body
    ${cmd('patch')} ${arg('/path')} ${arg('{ "k":"v" }')}          PATCH
    ${cmd('put')} ${arg('/path')} ${arg('{ "k":"v" }')}            PUT
    ${cmd('delete')} ${arg('/path')}                          DELETE

  ${paint(c.bold + c.bwhite, 'Shortcuts')}
    ${cmd('health')}                                   GET /health
    ${cmd('metrics')}                                  GET /metrics
    ${cmd('services')}                                 list registered services

  ${paint(c.bold + c.bwhite, 'Variables')}  ${note('($ prefix expands anywhere in a command)')}
    ${cmd('set')} ${arg('name')} ${arg('<json>')}                 store a value
    ${cmd('set')} ${arg('name')} ${arg('= $_.data[0]')}           store extracted field
    ${arg('$name')}                                expand inline in any command
    ${arg('$_')}                                   last response body (auto)
    ${arg('$_.data[0].id')}                         dot-path into last response
    ${cmd('vars')}                                     list all variables
    ${cmd('unset')} ${arg('name')}                      delete a variable
    ${cmd('inspect')} ${arg('$name')}                   pretty-print a variable

  ${paint(c.bold + c.bwhite, 'History')}
    ${cmd('!')}${arg('N')}                                    replay history item N
    ${cmd('history')}                                  show history list

  ${paint(c.bold + c.bwhite, 'Watch')}
    ${cmd('watch')} ${arg('/path')} ${arg('[ms]')}                 poll every N ms (default 2000)
    ${note('ctrl+c stops the watch')}

  ${paint(c.bold + c.bwhite, 'Last response')}
    ${cmd('last')}                                     reprint last response
    ${cmd('last')} ${arg('.data[0].id')}                   extract a nested field
    ${cmd('inspect')} ${arg('$_')}                          pretty-print last response

  ${paint(c.bold + c.bwhite, 'Session')}
    ${cmd('auth')} ${arg('<token>')}                       set bearer token
    ${cmd('unauth')}                                clear token
    ${cmd('header')} ${arg('<name>')} ${arg('<value>')}          set persistent header
    ${cmd('headers')}                               list active headers
    ${cmd('base')} ${arg('<url>')}                         change base URL

  ${paint(c.bold + c.bwhite, 'Webhooks')}
    ${cmd('webhooks')}                                list registered webhooks
    ${cmd('webhooks add')} ${arg('<url>')} ${arg('<event> [...]')}    register (events: orders:created * etc.)
    ${cmd('webhooks remove')} ${arg('<id>')}              unregister
    ${cmd('webhooks deliveries')} ${arg('[id]')}          delivery history (all or per-webhook)
    ${cmd('webhooks delivery')} ${arg('<id>')}            inspect one delivery
    ${cmd('webhooks retry')} ${arg('<delivery-id>')}      manually retry a dead delivery
    ${cmd('webhooks test')} ${arg('<webhook-id>')}        fire a test ping

  ${paint(c.bold + c.bwhite, 'Litestone ORM')}
    ${cmd('litestone')}                                run setup audit
    ${cmd('litestone audit')}                          same as above
    ${note('Full wizard:')} ${arg('bun run litestone')} ${note('(run outside REPL)')}

  ${paint(c.bold + c.bwhite, 'Project setup')}
    ${cmd('setup')}                                    audit project configuration
    ${note('Full wizard:')} ${arg('bun run setup')} ${note('(run outside REPL — new or existing projects)')}

  ${paint(c.bold + c.bwhite, 'Tutorial')}
    ${cmd('tutorial')}                                 start the interactive guide
    ${cmd('tutorial')} ${arg('basics|auth|variables|power')}  jump to a chapter
    ${cmd('tutorial list')}                            show all chapters
    ${note('While in the tutorial, type')} ${arg('skip')} ${note('to skip a step.')}

  ${note('Tab completes commands, live API paths, and $variable names.')}
  ${note('Paths are fetched from /metrics on connect and refreshed on services/base.')}
  ${note(`Base: ${baseUrl}`)}
`)
}

// ─── Watch ─────────────────────────────────────────────────────────────────

let watchTimer: ReturnType<typeof setInterval> | null = null
let watchCount = 0

function stopWatch(): void {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; watchCount = 0 }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────

async function dispatch(rawLine: string): Promise<void> {
  const trimmed = rawLine.trim()
  if (!trimmed) return

  // Record in history (skip consecutive duplicates)
  if (cmdHistory[cmdHistory.length - 1] !== trimmed) cmdHistory.push(trimmed)

  // ── !N — replay history item ────────────────────────────────────
  if (/^!\d+$/.test(trimmed)) {
    const n = parseInt(trimmed.slice(1), 10)
    if (n < 1 || n > cmdHistory.length - 1) { printError(`No history entry ${n}`); return }
    const replayed = cmdHistory[n - 1]
    console.log(`  ${paint(c.gray, '↺')} ${replayed}`)
    await dispatch(replayed)
    return
  }

  // ── Variable expansion ──────────────────────────────────────────
  const line  = expandVars(trimmed)
  const parts = line.split(/\s+/)
  const cmd   = parts[0]
  const rest  = parts.slice(1)
  const lower = cmd.toLowerCase()

  // ── HTTP ────────────────────────────────────────────────────────
  if (HTTP_CMDS.includes(lower)) {
    const path = rest[0]
    if (!path) { printError(`Usage: ${lower} /path [{ ...body }]`); return }
    learnPath(path)

    let body: unknown = undefined
    if (rest.length > 1) {
      const raw = rest.slice(1).join(' ')
      try { body = JSON.parse(raw) }
      catch { printError(`Invalid JSON body: ${raw}`); return }
    }

    try {
      const r = await doRequest(lower.toUpperCase(), path, body)
      lastResponse = r
      setVar('_', r.body)
      printResponse(lower.toUpperCase(), path, r)
      tutEval(trimmed, r)
    } catch (err) { printError(`Request failed: ${(err as Error).message}`) }
    return
  }

  // ── health / metrics ────────────────────────────────────────────
  if (lower === 'health' || lower === 'metrics') {
    const path = `/${lower}`
    try {
      const r = await doRequest('GET', path)
      lastResponse = r
      setVar('_', r.body)
      printResponse('GET', path, r)
      if (lower === 'metrics') await refreshPaths()
      tutEval(trimmed, r)
    } catch (err) { printError(`Request failed: ${(err as Error).message}`) }
    return
  }

  // ── services ────────────────────────────────────────────────────
  if (lower === 'services') {
    try {
      const r    = await doRequest('GET', '/metrics')
      const body = r.body as {
        services?: {
          registered?: string[]
          details?: Record<string, { actions?: string[]; allowBulk?: boolean }>
        }
      }
      const names   = body?.services?.registered ?? []
      const details = body?.services?.details    ?? {}

      if (!names.length) { printInfo('No services registered — is the app running?'); return }

      const prefix = '/api'
      console.log()
      console.log(`  ${paint(c.bold + c.bwhite, 'Registered services')}  ${paint(c.gray, `(${names.length})`)}`)
      console.log()

      for (const name of names) {
        const svcDetails = details[name] ?? {}
        const actions    = svcDetails.actions ?? []
        const allowBulk  = svcDetails.allowBulk ?? false
        const base       = `${prefix}/${name}`

        // Collection routes
        console.log(
          `  ${paint(c.bcyan, name)}`
        )
        console.log(
          `  ${paint(c.gray, '  GET   ')} ${paint(c.bwhite, base)}` +
          `  ${paint(c.gray, 'find — paginated list')}`
        )
        console.log(
          `  ${paint(c.gray, '  POST  ')} ${paint(c.bwhite, base)}` +
          `  ${paint(c.gray, 'create')}`
        )
        if (allowBulk) {
          console.log(
            `  ${paint(c.gray, '  PATCH ')} ${paint(c.bwhite, base)}` +
            `  ${paint(c.gray, 'bulk patch (allowBulk)')}`
          )
          console.log(
            `  ${paint(c.gray, '  DELETE')} ${paint(c.bwhite, base)}` +
            `  ${paint(c.gray, 'bulk delete (allowBulk)')}`
          )
        }

        // Record routes
        console.log(
          `  ${paint(c.gray, '  GET   ')} ${paint(c.bwhite, `${base}/{id}`)}` +
          `  ${paint(c.gray, 'get by id')}`
        )
        console.log(
          `  ${paint(c.gray, '  PATCH ')} ${paint(c.bwhite, `${base}/{id}`)}` +
          `  ${paint(c.gray, 'patch')}`
        )
        console.log(
          `  ${paint(c.gray, '  DELETE')} ${paint(c.bwhite, `${base}/{id}`)}` +
          `  ${paint(c.gray, 'remove')}`
        )

        // Custom actions
        if (actions.length) {
          for (const action of actions) {
            console.log(
              `  ${paint(c.gray, '  POST  ')} ${paint(c.bwhite, `${base}/{id}/${action}`)}` +
              `  ${paint(c.byellow, `action: ${action}`)}`
            )
          }
        }

        console.log()
      }

      await refreshPaths()
      tutEval(trimmed, null)
    } catch (err) { printError(`Request failed: ${(err as Error).message}`) }
    return
  }

  // ── webhooks ─────────────────────────────────────────────────────
  // All webhook management goes through the /api/webhooks service routes
  // (registered by the webhooks() plugin) and the /api/webhook-deliveries
  // route for delivery history.
  //
  //  webhooks                        list registered webhooks
  //  webhooks add <url> <events>     register a new webhook
  //  webhooks remove <id>            unregister a webhook
  //  webhooks deliveries [id]        show delivery history (all or per-webhook)
  //  webhooks delivery <id>          inspect one delivery record
  //  webhooks retry <delivery-id>    manually retry a dead/failed delivery
  //  webhooks test <id>              fire a test ping to a registered webhook

  if (lower === 'webhooks') {
    const sub = rest[0]?.toLowerCase()

    // ── list ──────────────────────────────────────────────────────
    if (!sub || sub === 'list') {
      try {
        const r    = await doRequest('GET', '/api/webhooks')
        lastResponse = r; setVar('_', r.body)
        if (r.status === 404) {
          printError('webhooks plugin not configured — add app.configure(webhooks({...})) to your app')
          return
        }
        const hooks = (r.body as { data?: unknown[] })?.data ?? (r.body as unknown[]) ?? []
        if (!Array.isArray(hooks) || !hooks.length) { printInfo('No webhooks registered'); return }
        console.log()
        console.log(`  ${paint(c.bold + c.bwhite, 'Registered webhooks')}  ${paint(c.gray, `(${hooks.length})`)}`)
        console.log()
        for (const h of hooks as Record<string, unknown>[]) {
          const events = Array.isArray(h.events) ? (h.events as string[]).join(', ') : String(h.events)
          const active = h.active ? paint(c.bgreen, '● active') : paint(c.gray, '○ inactive')
          console.log(`  ${paint(c.bcyan, String(h.id).slice(0, 8))}  ${active}  ${paint(c.bwhite, String(h.url))}`)
          console.log(`  ${' '.repeat(10)}${paint(c.gray, events)}`)
          console.log()
        }
      } catch (err) { printError(`Request failed: ${(err as Error).message}`) }
      return
    }

    // ── add <url> <events...> ─────────────────────────────────────
    if (sub === 'add') {
      const url    = rest[1]
      const events = rest.slice(2)
      if (!url)          { printError('Usage: webhooks add <url> <event> [event...]'); return }
      if (!events.length){ printError('Usage: webhooks add <url> <event> [event...]  — e.g. webhooks add https://x.com/hook orders:created *'); return }
      try {
        const r = await doRequest('POST', '/api/webhooks', { url, events })
        lastResponse = r; setVar('_', r.body)
        if (!r.ok) { printError(`Failed (${r.status}): ${JSON.stringify(r.body)}`); return }
        const hook = r.body as Record<string, unknown>
        console.log()
        console.log(`  ${paint(c.bgreen, '✓')} ${paint(c.bwhite, 'Webhook registered')}`)
        console.log()
        console.log(`  ${paint(c.gray, 'id')}      ${paint(c.bcyan, String(hook.id))}`)
        console.log(`  ${paint(c.gray, 'url')}     ${paint(c.bwhite, String(hook.url))}`)
        console.log(`  ${paint(c.gray, 'events')}  ${paint(c.bwhite, (hook.events as string[]).join(', '))}`)
        console.log()
        console.log(`  ${paint(c.byellow, '⚠')}  ${paint(c.bwhite, 'Save this secret — it will not be shown again:')}`)
        console.log(`  ${paint(c.bgreen, String(hook.secret))}`)
        console.log()
      } catch (err) { printError(`Request failed: ${(err as Error).message}`) }
      return
    }

    // ── remove <id> ───────────────────────────────────────────────
    if (sub === 'remove') {
      const id = rest[1]
      if (!id) { printError('Usage: webhooks remove <id>'); return }
      try {
        const r = await doRequest('DELETE', `/api/webhooks/${id}`)
        lastResponse = r; setVar('_', r.body)
        if (r.status === 404) { printError(`Webhook ${id} not found`); return }
        printSuccess(`Webhook ${id} removed`)
      } catch (err) { printError(`Request failed: ${(err as Error).message}`) }
      return
    }

    // ── deliveries [webhook-id] ───────────────────────────────────
    if (sub === 'deliveries') {
      const id  = rest[1]
      const url = id ? `/api/webhook-deliveries?webhookId=${id}` : '/api/webhook-deliveries'
      try {
        const r = await doRequest('GET', url)
        lastResponse = r; setVar('_', r.body)
        const rows = (r.body as { data?: unknown[] })?.data ?? (r.body as unknown[]) ?? []
        if (!Array.isArray(rows) || !rows.length) { printInfo('No deliveries found'); return }

        const statusColor = (s: string) => {
          if (s === 'delivered') return paint(c.bgreen,  s.padEnd(9))
          if (s === 'dead')      return paint(c.bred,    s.padEnd(9))
          if (s === 'failed')    return paint(c.byellow, s.padEnd(9))
          return paint(c.gray, s.padEnd(9))
        }

        console.log()
        console.log(`  ${paint(c.bold + c.bwhite, 'Webhook deliveries')}  ${paint(c.gray, `(${rows.length})`)}`)
        console.log()

        for (const d of rows as Record<string, unknown>[]) {
          const fullId  = String(d.id)
          const shortId = fullId.slice(0, 8)
          const ts = d.createdAt
            ? new Date(Number(d.createdAt)).toISOString().replace('T', ' ').slice(0, 19)
            : ''

          console.log(
            `  ${paint(c.bcyan, shortId)}  ` +
            `${statusColor(String(d.status))}  ` +
            `${paint(c.bwhite, String(d.event).padEnd(30))}  ` +
            `${paint(c.gray, `×${d.attempts}  ${ts}`)}`
          )
          if (d.lastError) {
            console.log(`  ${' '.repeat(10)}${paint(c.bred, String(d.lastError).slice(0, 80))}`)
          }
          // Full ID on its own line — copyable, with inline retry hint
          console.log(
            `  ${' '.repeat(10)}` +
            `${paint(c.gray, fullId)}  ` +
            `${paint(c.dim + c.gray, '← webhooks retry ' + shortId + '...')}`
          )
          console.log()
        }

        // Store the last row's full ID for quick retry
        const lastRow = rows[rows.length - 1] as Record<string, unknown>
        if (lastRow?.id) {
          setVar('lastDeliveryId', String(lastRow.id))
          console.log(dim(`  $lastDeliveryId → use: webhooks retry $lastDeliveryId`))
          console.log()
        }

      } catch (err) { printError(`Request failed: ${(err as Error).message}`) }
      return
    }

    // ── delivery <id> — inspect one ──────────────────────────────
    if (sub === 'delivery') {
      const id = rest[1]
      if (!id) { printError('Usage: webhooks delivery <delivery-id>'); return }
      try {
        const r = await doRequest('GET', `/api/webhook-deliveries/${id}`)
        lastResponse = r; setVar('_', r.body)
        if (r.status === 404) { printError(`Delivery ${id} not found`); return }
        console.log()
        console.log(colorizeJson(r.body))
        console.log()
      } catch (err) { printError(`Request failed: ${(err as Error).message}`) }
      return
    }

    // ── retry <delivery-id> ───────────────────────────────────────
    if (sub === 'retry') {
      const id = rest[1]
      if (!id) { printError('Usage: webhooks retry <delivery-id>'); return }
      try {
        const r = await doRequest('POST', `/api/webhook-deliveries/${id}/retry`)
        lastResponse = r; setVar('_', r.body)
        if (r.status === 404) { printError(`Delivery ${id} not found`); return }
        const result = r.body as Record<string, unknown>
        if (result.ok) {
          printSuccess(`Delivered  (${result.statusCode}, ${result.ms}ms)`)
        } else {
          printError(`Delivery failed  (${result.statusCode ?? 'no response'})  ${result.error ?? ''}`)
        }
      } catch (err) { printError(`Request failed: ${(err as Error).message}`) }
      return
    }

    // ── test <webhook-id> — fire a synthetic ping ─────────────────
    if (sub === 'test') {
      const id = rest[1]
      if (!id) { printError('Usage: webhooks test <webhook-id>'); return }
      try {
        const r = await doRequest('POST', `/api/webhooks/${id}/test`)
        lastResponse = r; setVar('_', r.body)
        if (r.status === 404) { printError(`Webhook ${id} not found`); return }
        const result = r.body as Record<string, unknown>
        if (result.ok) {
          printSuccess(`Test ping delivered  (${result.statusCode}, ${result.ms}ms)`)
        } else {
          printError(`Test ping failed  (${result.statusCode ?? 'no response'})  ${result.error ?? ''}`)
        }
      } catch (err) { printError(`Request failed: ${(err as Error).message}`) }
      return
    }

    // Unknown sub-command
    printError(`Unknown: webhooks ${sub}`)
    console.log(`  ${paint(c.gray, 'Sub-commands:')} list · add · remove · deliveries · delivery · retry · test`)
    console.log()
    return
  }
  if (lower === 'set') {
    if (!rest.length) { printError('Usage: set <name> <json>   or   set <name> = $_.path'); return }
    const name = rest[0]
    // Allow optional '=' sugar: set name = <value>
    const valTokens = rest[1] === '=' ? rest.slice(2) : rest.slice(1)
    if (!valTokens.length) { printError('Usage: set <name> <json>'); return }
    const raw = expandVars(valTokens.join(' '))
    let value: unknown
    try { value = JSON.parse(raw) } catch { value = raw }
    setVar(name, value)
    const preview = JSON.stringify(value)
    printSuccess(`$${name} = ${paint(c.gray, preview.length > 70 ? preview.slice(0, 70) + '…' : preview)}`)
    tutEval(trimmed, null)
    return
  }

  if (lower === 'vars') {
    const entries = Object.entries(vars)
    if (!entries.length) { printInfo('No variables set'); return }
    console.log()
    for (const [k, v] of entries) {
      const p = JSON.stringify(v)
      console.log(`  ${paint(c.bcyan, ('$' + k).padEnd(20))}  ${paint(c.gray, p.length > 65 ? p.slice(0, 65) + '…' : p)}`)
    }
    console.log()
    tutEval(trimmed, null)
    return
  }

  if (lower === 'unset') {
    const name = rest[0]
    if (!name) { printError('Usage: unset <name>'); return }
    if (!(name in vars)) { printError(`Variable $${name} is not set`); return }
    delete vars[name]
    printSuccess(`$${name} cleared`)
    return
  }

  if (lower === 'inspect') {
    const rawArg = rest[0] ?? ''
    // Accept 'inspect $name' or 'inspect name' or 'inspect $_.path'
    const ref     = rawArg.startsWith('$') ? rawArg.slice(1) : rawArg
    const dotIdx  = ref.indexOf('.')
    const varName = dotIdx === -1 ? ref : ref.slice(0, dotIdx)
    const subpath = dotIdx === -1 ? null : ref.slice(dotIdx + 1)
    if (!(varName in vars)) { printError(`Variable $${varName} is not set`); return }
    const value = subpath ? getPath(vars[varName], subpath) : vars[varName]
    console.log()
    console.log(colorizeJson(value))
    console.log()
    return
  }

  // ── last ────────────────────────────────────────────────────────
  if (lower === 'last') {
    if (!lastResponse) { printInfo('No requests made yet'); return }
    if (rest.length > 0) {
      // 'last .data[0].id' — dot-path extraction
      const pathExpr = rest[0].replace(/^\./, '')
      const value    = getPath(lastResponse.body, pathExpr)
      if (value === undefined) { printError(`Path .${pathExpr} not found in last response`); return }
      console.log()
      console.log(colorizeJson(value))
      console.log()
      return
    }
    printResponse('←', paint(c.gray, '(last response)'), lastResponse)
    tutEval(trimmed, null)
    return
  }

  // ── watch ────────────────────────────────────────────────────────
  if (lower === 'watch') {
    const path     = rest[0]
    const interval = parseInt(rest[1] ?? '2000', 10)
    if (!path) { printError('Usage: watch /path [interval_ms]'); return }
    learnPath(path)

    if (watchTimer) { stopWatch(); printInfo('Stopped previous watch') }

    console.log(`\n  ${paint(c.bblue, '◉')} ${paint(c.gray, `Watching ${path} every ${interval}ms — ctrl+c to stop`)}\n`)

    watchCount = 0
    watchTimer = setInterval(async () => {
      watchCount++
      try {
        const r = await doRequest('GET', path)
        lastResponse = r
        setVar('_', r.body)
        process.stdout.write('\x1b[2K\r')
        printResponse('GET', path, r, `watch #${watchCount}`)
      } catch (err) {
        printError(`Watch failed: ${(err as Error).message}`)
        stopWatch()
      }
    }, interval)

    // While watching, ctrl+c stops the watch instead of exiting
    const prevHandlers = process.listeners('SIGINT').slice()
    process.removeAllListeners('SIGINT')
    process.once('SIGINT', () => {
      stopWatch()
      console.log(paint(c.gray, '\n  watch stopped\n'))
      for (const fn of prevHandlers) process.on('SIGINT', fn as () => void)
      rl.setPrompt(buildPrompt())
      rl.prompt()
    })
    return
  }

  // ── Session ──────────────────────────────────────────────────────
  if (lower === 'auth') {
    const token = rest.join(' ')
    if (!token) { printError('Usage: auth <token>'); return }
    authToken = token
    printSuccess(`Auth token set  ${paint(c.gray, `(${token.slice(0, 16)}${token.length > 16 ? '…' : ''})`)}`)
    tutEval(trimmed, null)
    return
  }

  if (lower === 'unauth') { authToken = null; printSuccess('Auth token cleared'); tutEval(trimmed, null); return }

  if (lower === 'header') {
    const [name, ...vals] = rest
    if (!name || !vals.length) { printError('Usage: header <name> <value>'); return }
    persistentHeaders[name.toLowerCase()] = vals.join(' ')
    printSuccess(`${name}: ${vals.join(' ')}`)
    return
  }

  if (lower === 'headers') {
    const all = { ...persistentHeaders }
    if (authToken) all['authorization'] = `Bearer ${authToken.slice(0, 16)}…`
    if (!Object.keys(all).length) { printInfo('No persistent headers set'); return }
    console.log()
    for (const [k, v] of Object.entries(all))
      console.log(`  ${paint(c.cyan, k.padEnd(28))} ${paint(c.bwhite, v)}`)
    console.log()
    tutEval(trimmed, null)
    return
  }

  if (lower === 'base') {
    const url = rest[0]
    if (!url) { printError('Usage: base <url>'); return }
    baseUrl = url.replace(/\/$/, '')
    await refreshPaths()
    printSuccess(`Base → ${baseUrl}`)
    return
  }

  // ── setup audit ──────────────────────────────────────────────────
  // Runs the Junction project audit inline.
  // Full interactive wizard: bun run setup (or bun run tools/setup.ts)

  if (lower === 'setup') {
    const sub = rest[0]?.toLowerCase()

    if (!sub || sub === 'audit') {
      console.log()
      console.log(`  ${paint(c.bold + c.bwhite, 'Junction project audit')}`)
      console.log()
      try {
        const { execSync } = await import('node:child_process')
        const out = execSync('bun run tools/setup.ts audit', {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 30_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        process.stdout.write(out)
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string }
        if (e.stdout) process.stdout.write(e.stdout)
        else printError(`Audit failed: ${e.message ?? 'unknown error'}`)
      }
      console.log(`  ${paint(c.gray, 'Full interactive wizard:')} ${paint(c.bcyan, 'bun run setup')}`)
      console.log()
      return
    }

    printError(`Unknown: setup ${sub}`)
    console.log(`  ${paint(c.gray, 'Try:')} ${paint(c.bcyan, 'setup')}  or  ${paint(c.gray, 'bun run setup')} ${paint(c.gray, '(wizard)')}`)
    console.log()
    return
  }

  // ── litestone audit ──────────────────────────────────────────────
  // Runs all Litestone setup checks inline and reports status.
  // Full interactive wizard: bun run litestone (or bun run tools/litestone.ts)

  if (lower === 'litestone') {
    const sub = rest[0]?.toLowerCase()

    if (!sub || sub === 'audit') {
      console.log()
      console.log(`  ${paint(c.bold + c.bwhite, 'Litestone audit')}`)
      console.log()

      // Dynamically import and run audit checks from the litestone tool
      try {
        const { execSync } = await import('node:child_process')
        const result = execSync('bun run tools/litestone.ts audit', {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 30_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        process.stdout.write(result)
      } catch (err: unknown) {
        // execSync throws on non-zero exit — the audit output is in stdout
        const e = err as { stdout?: string; stderr?: string; message?: string }
        if (e.stdout) process.stdout.write(e.stdout)
        else printError(`Audit failed: ${e.message ?? 'unknown error'}`)
      }
      console.log()
      console.log(`  ${paint(c.gray, 'Full interactive wizard:')} ${paint(c.bcyan, 'bun run litestone')}`)
      console.log()
      return
    }

    if (sub === 'help') {
      console.log(`
  ${paint(c.bold + c.bwhite, 'Litestone commands')}

  ${paint(c.bcyan, 'litestone')}              run setup audit inline
  ${paint(c.bcyan, 'litestone audit')}        same as above
  ${paint(c.gray, 'bun run litestone')}       interactive setup wizard (run outside REPL)
  ${paint(c.gray, 'bun run litestone:audit')} audit only, exits 1 on failure (CI-friendly)
  ${paint(c.gray, 'bun run litestone:audit --json')} machine-readable output

  ${paint(c.gray, 'Checks:')} dependencies · schema.lite · generated files
          · DATABASE_URL · app wiring · migrations
`)
      return
    }

    printError(`Unknown: litestone ${sub}`)
    console.log(`  ${paint(c.gray, 'Try:')} ${paint(c.bcyan, 'litestone')}  or  ${paint(c.bcyan, 'litestone help')}`)
    console.log()
    return
  }

  // ── Misc ─────────────────────────────────────────────────────────
  if (lower === 'history') {
    if (!cmdHistory.length) { printInfo('No history yet'); return }
    console.log()
    cmdHistory.forEach((h, i) =>
      console.log(`  ${paint(c.gray, String(i + 1).padStart(3))}  ${h}`)
    )
    console.log()
    tutEval(trimmed, null)
    return
  }

  if (lower === 'clear')    { console.clear(); return }
  if (lower === 'help')     { printHelp(); return }
  if (lower === 'tutorial') { handleTutorialCommand(rest); return }
  if (lower === 'exit' || lower === 'quit') {
    stopWatch()
    console.log(paint(c.gray, '\n  bye\n'))
    process.exit(0)
  }

  printError(`Unknown command: ${cmd}  — type ${paint(c.bcyan, 'help')} for a list`)
}

// ─── Prompt ────────────────────────────────────────────────────────────────

function buildPrompt(): string {
  const dot = authToken ? paint(c.bgreen, '●') : paint(c.gray, '○')
  return `${dot} ${paint(c.bcyan, '›')} `
}

// ─── Banner ────────────────────────────────────────────────────────────────

function printBanner(): void {
  const line = paint(c.gray, '─'.repeat(52))
  console.log(`
${line}
  ${paint(c.bold + c.bwhite, 'Junction REPL')}  ${paint(c.gray, `→ ${baseUrl}`)}
${line}
  ${paint(c.gray, 'tab')} ${paint(c.gray, 'completes commands, paths & $vars')}
  ${paint(c.gray, 'type')} ${paint(c.bcyan, 'help')} ${paint(c.gray, 'for all commands  ·  ctrl+c to exit')}
`)
}

// ─── Main ──────────────────────────────────────────────────────────────────

printBanner()

// Seed known paths from the live app before the first prompt
await refreshPaths()

const rl = readline.createInterface({
  input:       process.stdin,
  output:      process.stdout,
  prompt:      buildPrompt(),
  completer,
  historySize: 500,
  terminal:    true,
})

rl.prompt()

rl.on('line', async (line) => {
  // While a watch is running, ignore typed input — ctrl+c stops it
  if (watchTimer) return

  rl.pause()
  await dispatch(line)
  rl.setPrompt(buildPrompt())
  rl.prompt()
  rl.resume()
})

rl.on('close', () => {
  stopWatch()
  console.log(paint(c.gray, '\n  bye\n'))
  process.exit(0)
})

process.on('SIGINT', () => {
  stopWatch()
  console.log(paint(c.gray, '\n  bye\n'))
  process.exit(0)
})
