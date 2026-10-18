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
// The model is `claude -p` (Haiku, low effort; `--model` names another) under
// the owner's own Claude login: the soul as the system prompt, the lines heard
// as the prompt, no tools, no hooks, no MCP, no session kept, run in the
// agent's own directory so no repo CLAUDE.md is read into a character. `HAVEN_AGENTS_CLAUDE` names another binary, which is how a
// test answers without spending anything.
//
// Two agents in earshot of each other would talk forever on the owner's bill,
// so a line said by either is never answered, whatever list names them; and an
// agent answers at most once per `REPLY_MS`, a line arriving meanwhile dropped.
//
// A mod's line naming an agent with `task:` (`ace task: …`, or a whisper
// holding `task:`) is work, not talk (14.11, `FJS-D1020`): the agent turns the
// words into one plan for the fix loop — a named `FJS-###` as it stands, else
// what the model makes of the words against the loop's ready rows — checks
// it, says it back, and starts `scripts/fix-loop.mjs` through the taskmaster's
// `startLoop`, so one loop runs at a time across the agents and the desk. It
// stands at the bench of the row the loop's log says it is on, and walks back
// to say each row's outcome. The model that plans has no tools either: a mod's
// words reach the machine only as a plan `loopArgv` accepted.

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { machineKeys, signIn } from '../web/src/lib/session/sign-in.js'
import { checkout, fileRow, LOCK_FILE, LOG_FILE, loopOutput, loopReport, MAX_ROWS, planName, readyRows, running, startLoop } from '../web/src/lib/hash/taskmaster.js'
import { layoutWorkshop } from '../web/src/pieces/workshop.js'
import { CLAUDE_ENV } from '../web/src/lib/study/session.js'
import { LEDGER } from '../web/src/lib/hash/ledger.data.js'
import { facingOf } from '../api/src/facing.ts'
import { parseRoll } from '../api/src/dice.ts'
import { FIRST_ROOM } from '../api/src/rooms.ts'
import { walkable, worldFor } from '../api/src/world.ts'

// ─── who they are ─────────────────────────────────────────────────────────────

/**
 * Who lives where: a nick each (the schema's lowercase), a soul and a spot.
 * A `room` is where an agent lives; one without stands in the room the runner
 * is given, the square, near its spawn. The one marked `desk` follows a loop
 * the workshop's taskmaster started, as it follows one a mod's task started.
 */
export const AGENTS = [
  { name: 'Ace',     nick: 'ace',     soul: 'ace.md',     home: { x: 26, y: 21 }, desk: true },
  { name: 'Charles', nick: 'charles', soul: 'charles.md', home: { x: 36, y: 21 } },
  { name: 'Wick',    nick: 'wick',    soul: 'wick.md',    home: { x: 24, y: 16 }, room: 'tavern' },
  { name: 'Marrow',  nick: 'marrow',  soul: 'marrow.md',  home: { x: 20, y: 6 },  room: 'tavern' },
  { name: 'Tam',     nick: 'tam',     soul: 'tam.md',     home: { x: 62, y: 12 }, room: 'tavern' },
  { name: 'Nell',    nick: 'nell',    soul: 'nell.md',    home: { x: 64, y: 10 }, room: 'tavern' },
  { name: 'Pike',    nick: 'pike',    soul: 'pike.md',    home: { x: 28, y: 14 }, room: 'tavern' },
]

export { CLAUDE_ENV }
export const SOULS_DIR = join(import.meta.dir, 'souls')
export const KEYS_DIR  = join(homedir(), '.fli', 'haven', 'agents')

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
  /** A loop that has not ended by now is left running and the agent walks back. */
  workMs:   60 * 60_000,
  /** How often a working agent reads the loop's log for the bench. */
  watchMs:  1_000,
  /** How often the `desk` agent looks for a loop the taskmaster started. */
  deskMs:   2_000,
}

/** How far from its spot an agent strays, in cells. */
export const WANDER = 2

/** Dollars one reply may spend, `--max-budget-usd`. */
export const REPLY_BUDGET_USD = 0.25

export const WORKSHOP = 'workshop'

/** Who a loop from the desk is reported to: nobody said it, so the agent answers the man who started it. */
export const DESK = 'Taskmaster'

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

/**
 * The task a line hands this agent, or null when it is talk: the words after
 * `task:`, in a line that names the agent or is whispered to it. A line
 * naming nobody is talk even when it holds `task:`, since the nearest agent
 * answering it would be a paid session nobody asked that agent for.
 *
 * @param {{ body: string, toId?: number | null }} line
 */
export function taskOf (line, nick) {
  const m = /(?:^|[^a-z0-9_-])task:\s*(\S[\s\S]*)$/i.exec(String(line.body ?? ''))
  if (!m || (line.toId == null && !names(line.body, nick))) return null
  return m[1].trim()
}

/**
 * The dice a mod's line asks this agent to throw -- `pike, roll 2d6`, `roll d20`,
 * or `ace roll` for one d6 -- else null. The agent throws through `dice.roll`,
 * so the line it answers with is the dice's and the model is never asked: a
 * roll is a number, and a model asked for one would invent it.
 *
 * @param {{ body: string, toId?: number | null }} line
 */
export function rollOf (line, nick) {
  const m = /(?:^|[^a-z0-9_-])roll(?:\s+(\S+?))?[\s.!?]*$/i.exec(String(line.body ?? ''))
  if (!m || (line.toId == null && !names(line.body, nick))) return null
  const spec = m[1] ?? 'd6'
  return parseRoll(spec) ? spec : null
}

/** Where an agent stands at a bench of the workshop: the aisle cell left of its workers' row, clear of their seats and count. */
export function benchSpot (bench, ledger = LEDGER) {
  const shop = layoutWorkshop(ledger)
  const b = [...shop.benches, ...shop.idle].find(b => b.name === bench)
  return b ? { x: b.x - 1, y: b.y + 1 } : null
}

// ─── a task as a plan ─────────────────────────────────────────────────────────

/** The `FJS-###` a task names, upper-cased and in order, none twice. */
export const idsIn = (task) => [...new Set([...String(task).matchAll(/\bFJS-(\d+)\b/gi)].map(m => `FJS-${m[1]}`))]

/** The system prompt of the call that plans: what the answer may be, and nothing of a character. */
export const PLANNER = [
  'You turn a task a mod hands you into one command for the fix loop, which fixes rows of the issue register.',
  'Answer one JSON object and nothing else:',
  `{"ids":["FJS-123"]} when the task is one of the ready rows listed, or up to ${MAX_ROWS} of them;`,
  '{"pkg":"<package>","sev":"S3,S4"} when it names an area of work rather than a row (sev may be left out);',
  '{"file":{"sev":"S3","area":"<package>","title":"<the defect in one sentence, as a reader meets it>"}} when it is a defect no listed row covers;',
  '{"none":"<why, in a few words>"} when it is not work the loop can do.',
  'A package is one of the packages listed. S1 is the most severe, S4 the least.',
].join('\n')

/** The prompt that plans: the task, then the rows the loop could take and the packages they name. */
export function planPrompt ({ task, rows }) {
  const pkgs = [...new Set(rows.flatMap(r => r.pkg))].sort()
  return [
    `The task: ${task}`,
    '',
    'Ready rows, best first:',
    rows.length ? rows.map(r => `${r.id} ${r.severity} ${r.pkg.join(' · ')} — ${r.title}`).join('\n') : '(none)',
    '',
    `Packages: ${pkgs.join(', ') || '(none)'}`,
  ].join('\n')
}

/** The first JSON object in a model's answer, or null. */
export function planOf (text) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ''))
  if (!m) return null
  try { const p = JSON.parse(m[0]); return p && typeof p === 'object' && !Array.isArray(p) ? p : null } catch { return null }
}

/**
 * A plan checked against what the loop can take: `{ plan }` the taskmaster
 * may start or `{ file }` to file first, else `{ refused }` saying why. An id
 * must be a ready row, a package one a ready row names, a severity S1–S4; a
 * plan's own words are never trusted to be a flag's.
 *
 * @param {any} p  the model's answer, or `{ ids }` from the task's own words
 * @param {{ id: string, pkg: string[], severity: string, title: string }[]} rows
 */
export function checkPlan (p, rows) {
  const ready = new Map(rows.map(r => [r.id, r]))
  const pkgs  = new Set(rows.flatMap(r => r.pkg))
  const sevs  = (v) => typeof v === 'string' && /^S[1-4](,S[1-4])*$/.test(v)
  if (!p || typeof p !== 'object') return { refused: "I couldn't make a loop of that" }
  if (Array.isArray(p.ids) && p.ids.length) {
    const ids = p.ids.map(id => String(id).toUpperCase())
    const gone = ids.find(id => !ready.has(id))
    if (gone) return { refused: `${gone} isn't one the loop can take — closed, by hand, or waiting on a ruling` }
    if (ids.length > MAX_ROWS) return { refused: `that's ${ids.length} rows, and I take ${MAX_ROWS} at most` }
    return { plan: { ids } }
  }
  if (p.pkg != null) {
    if (!pkgs.has(p.pkg)) return { refused: `nothing the loop can take is in ${String(p.pkg).slice(0, 40)}` }
    if (p.sev != null && !sevs(p.sev)) return { refused: `${String(p.sev).slice(0, 20)} isn't a severity` }
    return { plan: { pkg: p.pkg, ...(p.sev != null && { sev: p.sev }), rows: 1 } }
  }
  if (p.file && typeof p.file === 'object') {
    const { sev = 'S3', area, title } = p.file
    if (!/^S[1-4]$/.test(sev)) return { refused: `${String(sev).slice(0, 20)} isn't a severity` }
    if (typeof area !== 'string' || !/^\w[\w-]*$/.test(area)) return { refused: "I couldn't tell which package that is" }
    if (typeof title !== 'string' || title.trim().length < 8) return { refused: "I couldn't put that in a sentence" }
    return { file: { sev, area, title: title.trim() } }
  }
  if (typeof p.none === 'string' && p.none.trim()) return { refused: p.none.trim().slice(0, 120) }
  return { refused: "I couldn't make a loop of that" }
}

/** A plan said back before the loop starts: the row's id and title, or the package. */
export function planLine (plan, rows) {
  if (plan.ids) {
    const one = plan.ids.length === 1 && rows.find(r => r.id === plan.ids[0])
    return one ? `${one.id} — ${one.title.slice(0, 80)}` : plan.ids.join(', ')
  }
  return `the next ${plan.sev ? `${plan.sev} ` : ''}row in ${plan.pkg}`
}

/** What the loop did, as the line said for it: each row's outcome and the loop's own summary. */
export function reportLine (report, speaker) {
  if (report.nothing && !report.rows.length) return `Nothing was ready for the loop, ${speaker}.`
  if (!report.rows.length) return `The loop stopped before it took a row, ${speaker}.`
  const rows = report.rows.map(r => `${r.id} ${r.outcome ?? 'stopped short'}`).join(', ')
  return report.summary ? `${rows} — ${report.summary}.` : `${rows}.`
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
 * @param {{ name: string, room: string, heard: { nick: string, body: string, whisper?: boolean }[], speaker: string, line: { body: string, toId?: number | null, shot?: boolean } }} p
 */
export function promptFor ({ name, room, heard, speaker, line }) {
  const said = (h) => `${h.nick}${h.whisper ? ' (whispered)' : ''}: ${h.body}`
  return [
    `You are standing in Haven, in ${room === FIRST_ROOM ? 'the square' : `the ${room}`}. Lines you have heard lately, oldest first:`,
    heard.length ? heard.map(said).join('\n') : '(nothing yet)',
    '',
    line.shot
      ? `${speaker} just shot you with an arrow and knocked you back.`
      : `${speaker}${line.toId != null ? ' just whispered to you' : ' just said'}: ${line.body}`,
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
export function claudeArgv ({ soul, model = 'haiku', effort = 'low' }) {
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
export async function askSoul ({ soul, model, ...rest }) {
  const r = await runClaude({ argv: claudeArgv({ soul, model }), ...rest })
  return r?.code === 0 ? r.out : null
}

/** The plan a task's words make, `checkPlan`'s answer: a named id with no model asked, else the model's. */
export async function planFor ({ task, rows, model, ...rest }) {
  const ids = idsIn(task)
  if (ids.length) return checkPlan({ ids }, rows)
  const out = await askSoul({ soul: PLANNER, prompt: planPrompt({ task, rows }), model, ...rest })
  return out == null ? { refused: 'my head is empty right now' } : checkPlan(planOf(out), rows)
}

/**
 * `bin` with `argv`, the prompt on stdin: `{ code, out }`, or null when it
 * never ran or was killed. A failed exit is said through `log`; what it
 * printed is the caller's to read, since a print session that stopped short
 * (its budget, an error) still prints the JSON result that says why.
 */
export function runClaude ({ bin, argv, prompt, cwd, env, timeoutMs = TIMING.modelMs, log = () => {}, children }) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(bin, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
      if (code !== 0) log(`${bin} exited ${code}${err.trim() ? `: ${err.trim().split('\n').slice(-3).join(' / ')}` : ''}`)
      resolve(code == null ? null : { code, out })
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

/** A room's scene and the walkable cell nearest `at` in it. */
const abode = (room, at) => {
  const world = worldFor(room)
  return { room, world, home: standOn(world, at) }
}

/**
 * Sign the agents in, walk them into `room` and keep them there until `stop()`.
 * Resolves once every agent stands in the room.
 *
 * @param {{
 *   api: string, room?: string, agents?: typeof AGENTS, mods?: Set<string> | string,
 *   bin?: string, model?: string | null, keysDir?: string, soulsDir?: string,
 *   timing?: Partial<typeof TIMING>, wander?: boolean, log?: (line: string) => void,
 *   workRoot?: string | null, loopLock?: string, loopLog?: string,
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
  const workRoot = opts.workRoot !== undefined ? opts.workRoot : checkout()
  const loopAt   = { file: opts.loopLock ?? LOCK_FILE, log: opts.loopLog ?? LOG_FILE }
  const children = new Set()
  const nicks    = new Map()
  const pending  = new Map()
  // A loop an agent has followed once, by pid: one it walked away from past
  // `workMs` is still running, and would be taken up again on the next look.
  const tended   = new Set()
  let stopped    = false

  const agents = (opts.agents ?? AGENTS).map(spec => ({
    ...spec,
    soulText: readFileSync(join(soulsDir, spec.soul), 'utf8'),
    dir:      join(keysDir, spec.nick),
    id:       null, token: null, ws: null, roomId: null,
    ...abode(spec.room ?? room, spec.home),
    at: null, spot: spec.home,
    calls:    new Map(), callId: 0, roster: new Map(), heard: [],
    lastReply: 0, busy: false, working: null, timers: new Set(), retry: timing.retryMs,
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
      // At a bench it stands still under its `(…)`, which a step would drop.
      if (!agent.busy && !agent.working && agent.at) {
        // Knocked out of its patch by a bolt, it walks back rather than standing
        // where no step is inside the patch.
        const off   = (c) => Math.max(Math.abs(c.x - agent.home.x), Math.abs(c.y - agent.home.y))
        const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .map(([dx, dy]) => ({ x: agent.at.x + dx, y: agent.at.y + dy }))
          .filter(c => off(c) <= WANDER || off(c) < off(agent.at))
          .filter(c => !agent.world || walkable(agent.world, c.x, c.y))
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

  /** Say `text` in the agent's room, in a whisper back when `line` was one. */
  async function speak (agent, text, line, speaker) {
    const answer = await call(agent, 'messages', 'create', {
      data: { roomId: agent.roomId, body: text, ...(line.toId != null && { toId: line.memberId }) },
    })
    if (answer.type === 'service_error') log(`${agent.name}: the line was refused — ${answer.error?.message ?? 'no reason'}`)
    else log(`${agent.name} → ${speaker}: ${text}`)
  }

  /** Leave the room for `slug`, to stand at `at` there: a door is a reconnect (`FJS-2834`). */
  async function walkTo (agent, slug, at) {
    for (const t of agent.timers) clearTimeout(t)
    agent.timers.clear()
    const was = agent.ws
    agent.ws = null
    was?.close()
    agent.room  = slug
    agent.world = worldFor(slug)
    agent.home  = standOn(agent.world, at ?? agent.world?.spawn ?? { x: 1, y: 1 })
    await enter(agent)
  }

  /** Stand at the bench of the row the loop is on, while it runs; resolves when it ends or `workMs` passes. */
  function followLoop (agent, lock) {
    const end = Date.now() + timing.workMs
    return new Promise(resolve => {
      const look = () => {
        if (stopped) return resolve(false)
        const row  = loopReport(loopOutput({ log: loopAt.log, from: lock.from })).rows.at(-1)
        const at   = row && row.pkg[0] !== agent.working.bench && benchSpot(row.pkg[0])
        if (at) {
          agent.working.bench = row.pkg[0]
          agent.home = standOn(agent.world, at)
          move(agent, agent.home, { thinking: true })
          log(`${agent.name} is at the ${row.pkg[0]} bench on ${row.id}`)
        }
        if (running({ file: loopAt.file })?.pid !== lock.pid) return resolve(true)
        if (Date.now() > end) return resolve(false)
        // Not `later`: a dropped socket clears the agent's timers, and the loop
        // goes on without it.
        setTimeout(look, timing.watchMs)
      }
      look()
    })
  }

  /**
   * A mod's task: planned, checked and said back, then the fix loop started
   * on it and followed bench to bench, and each row's outcome said back in
   * the square. One loop at a time, the desk's included; a task while one
   * runs is refused in a line rather than queued, since a queue would spend
   * the owner's money for a mod who has walked off.
   */
  async function work (agent, line, task, speaker) {
    const busy = agent.working ?? running({ file: loopAt.file })
    if (busy) {
      const where = agent.working ? `at the ${agent.working.bench ?? 'workshop'} bench` : `minding the loop on ${busy.on}`
      await speak(agent, `Still ${where}, ${speaker} — one at a time.`, line, speaker).catch(() => {})
      return
    }
    if (!workRoot) {
      await speak(agent, `There's no workshop on this machine to take that to, ${speaker}.`, line, speaker).catch(() => {})
      return
    }
    agent.working = { task, speaker, bench: null }
    const back = agent.room
    let said = null
    move(agent, agent.at, { thinking: true })
    try {
      const rows    = await readyRows({ root: workRoot })
      const checked = await planFor({ bin, task, rows, model: opts.model, cwd: agent.dir, timeoutMs: timing.modelMs, children, log: m => log(`${agent.name}: ${m}`) })
      move(agent, agent.at)
      if (checked.refused) {
        log(`${agent.name}: ${speaker}'s task refused — ${checked.refused}`)
        await speak(agent, oneLine(`Can't take that one, ${speaker}: ${checked.refused}.`, agent.name), line, speaker)
        return
      }
      let plan = checked.plan
      if (checked.file) {
        const id = await fileRow({ root: workRoot, ...checked.file, detail: `Handed to ${agent.name} in Haven by ${speaker}: ${task}` })
        log(`${agent.name} filed ${id} for ${speaker}: ${checked.file.title}`)
        rows.push({ id, severity: checked.file.sev, pkg: [checked.file.area], title: checked.file.title })
        plan = { ids: [id] }
      }
      const lock = startLoop(plan, { root: workRoot, ...loopAt })
      tended.add(lock.pid)
      log(`${agent.name} started the loop on ${planName(plan)} for ${speaker} (pid ${lock.pid}): ${task}`)
      await speak(agent, oneLine(`Taking ${planLine(plan, rows)} — off to the workshop, ${speaker}.`, agent.name), line, speaker)
      said = await tend(agent, lock, speaker)
    } catch (e) {
      log(`${agent.name}: ${e.message}`)
      said = `Couldn't take that one, ${speaker}: ${e.message}.`
    } finally {
      agent.working = null
    }
    await comeBack(agent, back, said, line, speaker)
  }

  /** Into the workshop and bench to bench behind the loop; answers the line to say for it. */
  async function tend (agent, lock, speaker) {
    await walkTo(agent, WORKSHOP)
    const ended = await followLoop(agent, lock)
    return ended
      ? reportLine(loopReport(loopOutput({ log: loopAt.log, from: lock.from })), speaker)
      : `Left the loop running on ${lock.on}, ${speaker} — it's past my time.`
  }

  /**
   * A loop the desk started (`Taskmaster.mesa`'s `/yes`): the `desk` agent says
   * where it is going, follows it as its own, and says the outcome back in its
   * room. The desk stays the one that starts it, so one loop still runs at a time.
   */
  async function adopt (agent, lock) {
    tended.add(lock.pid)
    agent.working = { task: lock.on, speaker: DESK, bench: null }
    const back = agent.room
    let said = null
    log(`${agent.name} follows the desk's loop on ${lock.on} (pid ${lock.pid})`)
    try {
      await speak(agent, oneLine(`The taskmaster has the loop on ${lock.on} — off to the workshop.`, agent.name), {}, DESK)
      said = await tend(agent, lock, DESK)
    } catch (e) {
      log(`${agent.name}: ${e.message}`)
      said = `Lost the loop on ${lock.on}: ${e.message}.`
    } finally {
      agent.working = null
    }
    await comeBack(agent, back, said, {}, DESK)
  }

  /** Back to its spot in `back` from the workshop, and `said` said there. */
  async function comeBack (agent, back, said, line, speaker) {
    if (stopped || !said) return
    if (agent.room !== back) {
      try {
        await walkTo(agent, back, agent.spot)
      } catch (e) {
        log(`${agent.name}: ${e.message}`)
        return reenter(agent)
      }
    } else move(agent, agent.at)
    const text = oneLine(said, agent.name)
    if (text) await speak(agent, text, line, speaker).catch(e => log(`${agent.name}: ${e.message}`))
  }

  async function reply (agent, line, speaker) {
    const now = Date.now()
    if (agent.busy || now - agent.lastReply < timing.replyMs) {
      log(`${agent.name}: not answering ${speaker} yet — ${agent.busy ? 'still on the last one' : 'too soon after the last'}`)
      return
    }
    agent.busy = true
    agent.lastReply = now
    move(agent, agent.at, { thinking: true })
    try {
      const heard = []
      for (const h of agent.heard.filter(h => h.id !== line.id).slice(-CONTEXT_LINES))
        heard.push({ nick: await nickOf(agent, h.memberId) ?? '?', body: h.body, whisper: h.toId != null })
      const prompt = promptFor({ name: agent.name, room: agent.room, heard, speaker, line })
      const text   = oneLine(await askSoul({ bin, soul: agent.soulText, prompt, model: opts.model, cwd: agent.dir, timeoutMs: timing.modelMs, children, log: m => log(`${agent.name}: ${m}`) }), agent.name)
      if (!text || stopped) return
      await speak(agent, text, line, speaker)
    } catch (e) {
      log(`${agent.name}: ${e.message}`)
    } finally {
      agent.busy = false
      move(agent, agent.at)
    }
  }

  /** Throw `dice` in the agent's room. The dice say it; there is nothing more for the agent to. */
  async function throwFor (agent, dice) {
    try {
      const answer = await call(agent, 'dice', 'roll', { data: { roomId: agent.roomId, dice } })
      if (answer.type === 'service_error') log(`${agent.name}: the dice were refused — ${answer.error?.message ?? 'no reason'}`)
      else log(`${agent.name} rolled: ${answer.result?.body}`)
    } catch (e) { log(`${agent.name}: ${e.message}`) }
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
    for (const agent of chosen) {
      const task = taskOf(line, agent.nick)
      const dice = task ? null : rollOf(line, agent.nick)
      void (task ? work(agent, line, task, speaker) : dice ? throwFor(agent, dice) : reply(agent, line, speaker))
    }
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

  // A bolt knocks a figure to `to`, and only its owner moves a figure
  // (`Scene.mesa`), so a struck agent steps there itself. A mod's shot is then
  // answered like a line with no words; anyone else's only knocks it.
  function shot (agent, blast) {
    const hit = (blast.struck ?? []).find(s => String(s.id) === String(agent.id))
    if (!hit) return
    move(agent, hit.to, agent.busy ? { thinking: true } : {})
    if (isAgent(blast.by)) return
    void nickOf(agent, blast.by).then((shooter) => {
      if (!shooter || !mods.has(shooter)) { log(`${agent.name}: shot by ${shooter ?? `member ${blast.by}`}, not a mod — no answer`); return }
      void reply(agent, { body: '', shot: true }, shooter)
    })
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
    else if (frame.event === 'bolt') shot(agent, d)
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

    const ws = new WebSocket(wsUrl(api, agent.room), ['fjs', `fjs.bearer.${token}`])
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

    const found = await call(agent, 'rooms', 'find', { meta: { query: { slug: agent.room } } })
    const row = (found.result?.data ?? []).find(r => r.slug === agent.room)
    if (!row) throw new Error(`${api} has no room '${agent.room}'`)
    agent.roomId = row.id
    agent.at = null
    move(agent, agent.home)
    agent.retry = timing.retryMs
    log(`${agent.name} stands in the ${agent.room} at ${agent.home.x},${agent.home.y}`)
    wander(agent)
  }

  await Promise.all(agents.map(enter))
  const deskHand = workRoot ? agents.find(a => a.desk) : null
  const deskWatch = deskHand && setInterval(() => {
    if (stopped || agents.some(a => a.working)) return
    const lock = running({ file: loopAt.file })
    if (lock && !tended.has(lock.pid)) adopt(deskHand, lock)
  }, timing.deskMs)
  if (!mods.size) log(`No mods named (HAVEN_MODS or --mods): Ace and Charles will stand there and answer nobody.`)

  return {
    agents,
    stop () {
      stopped = true
      if (deskWatch) clearInterval(deskWatch)
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
  const run = await startAgents({ api, room: values.room, mods: values.mods ?? process.env.HAVEN_MODS ?? '', model: values.model })
    .catch(e => { console.error(e.message); process.exit(1) })
  const end = () => { run.stop(); process.exit(0) }
  process.on('SIGINT', end)
  process.on('SIGTERM', end)
}
