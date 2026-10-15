// agents/agents.js — Ace and Charles, two members who live in Haven's square
// (`IDEAS/haven.md` 14.9), run from the owner's machine by `bun run agents`.
//
// Each is an ordinary member: its own Ed25519 key (`FJS-D981`) under
// `~/.fli/haven/agents/<nick>/`, apart from the owner's `~/.fli/haven/key.json`
// so the owner never walks in as one of them, signed in through the same
// `POST /haven/login` a terminal uses, standing in the square on a socket of
// its own and stepping about near its spot so it is seen to be there.
//
// It answers a line only from a mod (`FJS-D1017`), so the bill is the owner's
// and a stranger has no prompt to inject. A client cannot read a speaker's
// standing — `Member.role` is `@guarded`, so a scoped read drops the key — so
// the runner reads `HAVEN_MODS` (or `--mods`) itself: the list the server is
// started with, and the owner holds both. Earshot is the server's: a line the
// socket was handed is a line the agent heard (`hearing.ts`).
//
// The model is `claude -p` under the owner's own Claude login: the soul as the
// system prompt, the lines heard as the prompt, no tools, no hooks, no MCP, no
// session kept, run in the agent's own directory so no repo CLAUDE.md is read
// into a character. `HAVEN_AGENTS_CLAUDE` names another binary, which is how a
// test answers without spending anything.
//
// Two agents in earshot of each other would talk forever on the owner's bill,
// so a line said by either is never answered, whatever list names them; and an
// agent answers at most once per `REPLY_MS`, a line arriving meanwhile dropped.

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { machineKeys, signIn } from '../web/src/sign-in.js'
import { facingOf } from '../api/src/facing.ts'
import { FIRST_ROOM } from '../api/src/rooms.ts'
import { walkable, worldFor } from '../api/src/world.ts'

// ─── who they are ─────────────────────────────────────────────────────────────

/** The two of them: a nick each (the schema's lowercase), a soul and a spot near the square's spawn. */
export const AGENTS = [
  { name: 'Ace',     nick: 'ace',     soul: 'ace.md',     home: { x: 26, y: 21 } },
  { name: 'Charles', nick: 'charles', soul: 'charles.md', home: { x: 36, y: 21 } },
]

export const SOULS_DIR = join(import.meta.dir, 'souls')
export const KEYS_DIR  = join(homedir(), '.fli', 'haven', 'agents')
export const CLAUDE_ENV = 'HAVEN_AGENTS_CLAUDE'

/** A Message body's own limit (`db/schema.lite`). */
export const MAX_LINE = 280
/** The lines heard that go into a prompt. */
export const CONTEXT_LINES = 12

export const TIMING = {
  /** The least time between one agent's replies. */
  replyMs:  8_000,
  /** How often an agent takes a step, give or take a third. */
  wanderMs: 25_000,
  /** A line reaches both sockets a moment apart; who answers is decided once both had it. */
  gatherMs: 250,
  /** A model call that has not answered by now is abandoned. */
  modelMs:  60_000,
  /** The first wait before a dropped socket is signed in again; it doubles to a minute. */
  retryMs:  3_000,
}

/** How far from its spot an agent strays, in cells. */
export const WANDER = 2

/** Dollars one reply may spend, `--max-budget-usd`. */
export const REPLY_BUDGET_USD = 0.25

// ─── who answers ──────────────────────────────────────────────────────────────

/** `HAVEN_MODS`' shape: comma-separated nicks, read the way the login reads them. */
export const parseMods = (list = '') =>
  new Set(String(list).split(',').map(n => n.trim().toLowerCase()).filter(Boolean))

/** Does a line name this nick as a word — `ace,`, `@ace`, `hi Ace` — and not inside another word. */
export function names (body, nick) {
  const n = nick.replace(/[^a-z0-9_-]/gi, '')
  return new RegExp(`(^|[^a-z0-9_-])@?${n}([^a-z0-9_-]|$)`, 'i').test(String(body))
}

const nearness = (a, b) => (a && b ? Math.hypot(a.x - b.x, (a.y - b.y) * 2) : Infinity)

/**
 * Which of the agents that heard a line answer it. A whisper is answered by
 * the one it was whispered to. Otherwise each agent the line names; and a line
 * naming none, by the nearest that heard it, so a mod who walks up and says
 * hello gets one answer and never two.
 *
 * @param {{ body: string, toId?: number | null }} line
 * @param {{ id: number, nick: string, at?: { x: number, y: number } | null }[]} hearers
 * @param {{ x: number, y: number } | null | undefined} speakerAt
 */
export function responders (line, hearers, speakerAt) {
  if (line.toId != null) return hearers.filter(a => a.id === line.toId)
  const asked = hearers.filter(a => names(line.body, a.nick))
  if (asked.length || hearers.length < 2) return asked.length ? asked : hearers
  return [hearers.reduce((best, a) => (nearness(a.at, speakerAt) < nearness(best.at, speakerAt) ? a : best))]
}

/** A reply as one line a Message may hold, or null when nothing is left. */
export function oneLine (text, name) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim()
  s = s.replace(new RegExp(`^\\**${name}\\**\\s*:\\s*`, 'i'), '')
  s = s.replace(/^"(.*)"$/, '$1').trim()
  // A line opening with `!` is a shout the whole room hears (`hearing.ts`),
  // which no reply has a reason to be.
  s = s.replace(/^!+\s*/, '')
  if (s.length > MAX_LINE) s = s.slice(0, MAX_LINE - 1).trimEnd() + '…'
  return s || null
}

/**
 * The prompt for one reply: the lines this agent heard, oldest first, then the
 * line it is answering and how to answer it. The soul is the system prompt.
 *
 * @param {{ name: string, room: string, heard: { nick: string, body: string, whisper?: boolean }[], speaker: string, line: { body: string, toId?: number | null } }} p
 */
export function promptFor ({ name, room, heard, speaker, line }) {
  const said = (h) => `${h.nick}${h.whisper ? ' (whispered)' : ''}: ${h.body}`
  return [
    `You are standing in Haven, in ${room === FIRST_ROOM ? 'the square' : `the ${room}`}. Lines you have heard lately, oldest first:`,
    heard.length ? heard.map(said).join('\n') : '(nothing yet)',
    '',
    `${speaker}${line.toId != null ? ' just whispered to you' : ' just said'}: ${line.body}`,
    '',
    `Answer ${speaker} as ${name}, in one line of at most ${MAX_LINE} characters: plain words, no markdown, ` +
    `no quotation marks, no name in front. Say only the line.`,
  ].join('\n')
}

// ─── the model ────────────────────────────────────────────────────────────────

/**
 * `claude -p` for one reply. No tools and no MCP, because the reply is a line
 * of talk; hooks off, because this repo's Stop hook would keep a print session
 * chasing the tree's close-out; no session kept, because a reply resumes nothing.
 */
export function claudeArgv ({ soul, model = null, effort = 'low' }) {
  const argv = [
    '-p',
    '--output-format',          'text',
    '--system-prompt',          soul,
    '--tools',                  '',
    '--strict-mcp-config',
    '--settings',               JSON.stringify({ disableAllHooks: true }),
    '--setting-sources',        '',
    '--no-session-persistence',
    '--max-budget-usd',         String(REPLY_BUDGET_USD),
  ]
  if (effort) argv.push('--effort', effort)
  if (model)  argv.push('--model', model)
  return argv
}

/**
 * One reply from the model, the prompt on stdin, or null on any failure — said
 * through `log`, since a missing login reads exactly like an agent with
 * nothing to say.
 */
export function askSoul ({ bin, soul, prompt, model, cwd, timeoutMs = TIMING.modelMs, log = () => {}, children }) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(bin, claudeArgv({ soul, model }), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) { log(`${bin}: ${e.message}`); return resolve(null) }
    children?.add(child)
    let out = '', err = ''
    child.stdout.setEncoding('utf8').on('data', c => { out += c })
    child.stderr.setEncoding('utf8').on('data', c => { err += c })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
    const timer = setTimeout(() => { log(`${bin} gave no answer in ${timeoutMs / 1000}s`); child.kill('SIGTERM') }, timeoutMs)
    child.on('error', e => {
      clearTimeout(timer); children?.delete(child)
      log(e.code === 'ENOENT' ? `${bin} is not installed or not on PATH (${CLAUDE_ENV} names another)` : e.message)
      resolve(null)
    })
    child.on('close', code => {
      clearTimeout(timer); children?.delete(child)
      if (code !== 0) { log(`${bin} exited ${code}${err.trim() ? `: ${err.trim().split('\n').slice(-3).join(' / ')}` : ''}`); return resolve(null) }
      resolve(out)
    })
  })
}

// ─── the runner ───────────────────────────────────────────────────────────────

const wsUrl = (api, room) => {
  const url = new URL('/ws', api)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('room', room)
  return url
}

/** The walkable cell nearest a spot, or the spot when the room has no scene. */
function standOn (world, at) {
  if (!world || walkable(world, at.x, at.y)) return { ...at }
  for (let r = 1; r < 8; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (walkable(world, at.x + dx, at.y + dy)) return { x: at.x + dx, y: at.y + dy }
  return { ...world.spawn }
}

/**
 * Sign the agents in, walk them into `room` and keep them there until `stop()`.
 * Resolves once every agent stands in the room.
 *
 * @param {{
 *   api: string, room?: string, agents?: typeof AGENTS, mods?: Set<string> | string,
 *   bin?: string, model?: string | null, keysDir?: string, soulsDir?: string,
 *   timing?: Partial<typeof TIMING>, wander?: boolean, log?: (line: string) => void,
 * }} opts
 */
export async function startAgents (opts) {
  const api      = String(opts.api).replace(/\/+$/, '')
  const room     = opts.room ?? FIRST_ROOM
  const mods     = typeof opts.mods === 'string' || opts.mods == null ? parseMods(opts.mods ?? '') : opts.mods
  const bin      = opts.bin ?? process.env[CLAUDE_ENV] ?? 'claude'
  const keysDir  = opts.keysDir ?? KEYS_DIR
  const soulsDir = opts.soulsDir ?? SOULS_DIR
  const timing   = { ...TIMING, ...opts.timing }
  const log      = opts.log ?? (line => console.log(line))
  const world    = worldFor(room)
  const children = new Set()
  const nicks    = new Map()
  const pending  = new Map()
  let stopped    = false

  const agents = (opts.agents ?? AGENTS).map(spec => ({
    ...spec,
    soulText: readFileSync(join(soulsDir, spec.soul), 'utf8'),
    dir:      join(keysDir, spec.nick),
    id:       null, token: null, ws: null, roomId: null,
    at:       null, home: standOn(world, spec.home),
    calls:    new Map(), callId: 0, roster: new Map(), heard: [],
    lastReply: 0, busy: false, timers: new Set(), retry: timing.retryMs,
  }))
  const isAgent = (memberId) => agents.some(a => a.id != null && String(a.id) === String(memberId))

  const later = (agent, ms, fn) => {
    const t = setTimeout(() => { agent.timers.delete(t); fn() }, ms)
    agent.timers.add(t)
  }

  function call (agent, service, method, frame = {}) {
    const id = String(++agent.callId)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { agent.calls.delete(id); reject(new Error(`${service}.${method} had no answer`)) }, 10_000)
      agent.calls.set(id, (answer) => { clearTimeout(t); resolve(answer) })
      agent.ws.send(JSON.stringify({ type: 'service_call', id, service, method, ...frame }))
    })
  }

  function move (agent, to, extra = {}) {
    if (!agent.ws || agent.ws.readyState !== 1 || agent.roomId == null) return
    const facing = agent.at ? facingOf(agent.at, to) : null
    agent.at = { ...to }
    if (facing) agent.facing = facing
    agent.ws.send(JSON.stringify({
      type: 'subscribe', channel: `room:${agent.roomId}`,
      meta: { x: to.x, y: to.y, ...(agent.facing && { facing: agent.facing }), ...extra },
    }))
  }

  /** One step to a floor cell beside it within `WANDER` of its spot, or a turn on the spot. */
  function wander (agent) {
    if (stopped || opts.wander === false) return
    const jitter = timing.wanderMs / 3
    later(agent, timing.wanderMs - jitter + Math.random() * 2 * jitter, () => {
      if (!agent.busy && agent.at) {
        const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .map(([dx, dy]) => ({ x: agent.at.x + dx, y: agent.at.y + dy }))
          .filter(c => Math.abs(c.x - agent.home.x) <= WANDER && Math.abs(c.y - agent.home.y) <= WANDER)
          .filter(c => !world || walkable(world, c.x, c.y))
        if (steps.length) move(agent, steps[Math.floor(Math.random() * steps.length)])
      }
      wander(agent)
    })
  }

  async function nickOf (agent, memberId) {
    const key = String(memberId)
    if (nicks.has(key)) return nicks.get(key)
    const answer = await call(agent, 'members', 'get', { meta: { id: memberId } }).catch(() => null)
    const nick = answer?.type === 'service_result' ? answer.result?.nick ?? null : null
    if (nick) nicks.set(key, nick)
    return nick
  }

  async function reply (agent, line, speaker) {
    const now = Date.now()
    if (agent.busy || now - agent.lastReply < timing.replyMs) {
      log(`${agent.name}: not answering ${speaker} yet — ${agent.busy ? 'still on the last one' : 'too soon after the last'}`)
      return
    }
    agent.busy = true
    agent.lastReply = now
    move(agent, agent.at, { typing: true })
    try {
      const heard = []
      for (const h of agent.heard.filter(h => h.id !== line.id).slice(-CONTEXT_LINES))
        heard.push({ nick: await nickOf(agent, h.memberId) ?? '?', body: h.body, whisper: h.toId != null })
      const prompt = promptFor({ name: agent.name, room, heard, speaker, line })
      const text   = oneLine(await askSoul({ bin, soul: agent.soulText, prompt, model: opts.model, cwd: agent.dir, timeoutMs: timing.modelMs, children, log: m => log(`${agent.name}: ${m}`) }), agent.name)
      if (!text || stopped) return
      const answer = await call(agent, 'messages', 'create', {
        data: { roomId: agent.roomId, body: text, ...(line.toId != null && { toId: line.memberId }) },
      })
      if (answer.type === 'service_error') log(`${agent.name}: the line was refused — ${answer.error?.message ?? 'no reason'}`)
      else log(`${agent.name} → ${speaker}: ${text}`)
    } catch (e) {
      log(`${agent.name}: ${e.message}`)
    } finally {
      agent.busy = false
      move(agent, agent.at)
    }
  }

  async function decide (key) {
    const { line, hearers } = pending.get(key)
    pending.delete(key)
    const first   = [...hearers][0]
    const speaker = await nickOf(first, line.memberId)
    if (!speaker || !mods.has(speaker)) { log(`${speaker ?? `member ${line.memberId}`} is not a mod — no answer`); return }
    const cell = (a) => [...a.roster.values()].find(m => String(m.userId) === String(line.memberId))?.meta ?? null
    const speakerAt = [...hearers].map(cell).find(Boolean) ?? null
    const chosen = responders(line, [...hearers], speakerAt)
    for (const agent of chosen) void reply(agent, line, speaker)
  }

  function heardLine (agent, line) {
    if (String(line.roomId) !== String(agent.roomId)) return
    agent.heard.push(line)
    if (agent.heard.length > CONTEXT_LINES * 2) agent.heard.splice(0, agent.heard.length - CONTEXT_LINES * 2)
    if (isAgent(line.memberId)) return
    const key = String(line.id)
    let p = pending.get(key)
    if (!p) {
      p = { line, hearers: new Set() }
      pending.set(key, p)
      later(agent, timing.gatherMs, () => { void decide(key) })
    }
    p.hearers.add(agent)
  }

  function onFrame (agent, frame) {
    if (frame.type === 'ping') { agent.ws.send(JSON.stringify({ type: 'pong' })); return }
    if ((frame.type === 'service_result' || frame.type === 'service_error') && agent.calls.has(frame.id)) {
      const done = agent.calls.get(frame.id)
      agent.calls.delete(frame.id)
      done(frame)
      return
    }
    if (frame.type !== 'event') return
    const d = frame.data ?? {}
    if (frame.event === 'messages created') heardLine(agent, d)
    else if (frame.event === 'presence:sync') {
      agent.roster = new Map((d.members ?? []).map(m => [m.connectionId, m]))
    } else if (frame.event === 'presence:update') {
      const m = agent.roster.get(d.connectionId)
      if (m) m.meta = d.meta
    } else if (frame.event === 'presence:diff' || frame.event === 'presence:join' || frame.event === 'presence:leave') {
      for (const m of d.joined ?? (frame.event === 'presence:join' ? [d.member] : [])) agent.roster.set(m.connectionId, m)
      for (const m of d.left ?? (frame.event === 'presence:leave' ? [d.member] : [])) agent.roster.delete(m.connectionId)
    }
  }

  function reenter (agent) {
    later(agent, agent.retry, () => {
      enter(agent).catch(err => { log(`${agent.name}: ${err.message}`); if (!stopped) reenter(agent) })
    })
    agent.retry = Math.min(agent.retry * 2, 60_000)
  }

  /** Sign in, open the socket, find the room, stand on the spot. Signs in again after any drop: a session expires (4001), the key does not. */
  async function enter (agent) {
    mkdirSync(agent.dir, { recursive: true, mode: 0o700 })
    const { keys, made } = await machineKeys(join(agent.dir, 'key.json'))
    const { token, member } = await signIn(api, { keys, nick: agent.nick })
    if (made) log(`${agent.name}: a new key at ${join(agent.dir, 'key.json')}`)
    if (member.nick !== agent.nick) log(`${agent.name}: this key walks in as '${member.nick}'`)
    agent.id = member.id
    agent.token = token
    nicks.set(String(member.id), member.nick)

    const ws = new WebSocket(wsUrl(api, room), ['fjs', `fjs.bearer.${token}`])
    agent.ws = ws
    await new Promise((resolve, reject) => {
      ws.onmessage = (e) => {
        let frame
        try { frame = JSON.parse(String(e.data)) } catch { return }
        if (frame.type === 'connection') resolve(undefined)
        onFrame(agent, frame)
      }
      ws.onerror = () => reject(new Error(`no socket at ${api}`))
      ws.onclose = (e) => {
        reject(new Error(`the socket closed (${e.code})`))
        if (agent.ws !== ws || stopped) return
        for (const t of agent.timers) clearTimeout(t)
        agent.timers.clear()
        log(`${agent.name}: the socket closed (${e.code}); walking back in`)
        reenter(agent)
      }
    })

    const found = await call(agent, 'rooms', 'find', { meta: { query: { slug: room } } })
    const row = (found.result?.data ?? []).find(r => r.slug === room)
    if (!row) throw new Error(`${api} has no room '${room}'`)
    agent.roomId = row.id
    agent.at = null
    move(agent, agent.home)
    agent.retry = timing.retryMs
    log(`${agent.name} stands in the ${room} at ${agent.home.x},${agent.home.y}`)
    wander(agent)
  }

  await Promise.all(agents.map(enter))
  if (!mods.size) log(`No mods named (HAVEN_MODS or --mods): Ace and Charles will stand there and answer nobody.`)

  return {
    agents,
    stop () {
      stopped = true
      for (const a of agents) {
        for (const t of a.timers) clearTimeout(t)
        a.timers.clear()
        a.ws?.close()
      }
      for (const c of children) c.kill('SIGTERM')
    },
  }
}

// ─── bun run agents ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      api:   { type: 'string' },
      room:  { type: 'string', default: FIRST_ROOM },
      mods:  { type: 'string' },
      model: { type: 'string' },
    },
  })
  const api = values.api ?? (await import('../web/config/sierra.config.js')).default.junction.url
  const run = await startAgents({ api, room: values.room, mods: values.mods ?? process.env.HAVEN_MODS ?? '', model: values.model ?? null })
    .catch(e => { console.error(e.message); process.exit(1) })
  const end = () => { run.stop(); process.exit(0) }
  process.on('SIGINT', end)
  process.on('SIGTERM', end)
}
