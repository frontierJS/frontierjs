// src/domain/register/registers.ts
// The workspace's registers — `ISSUES.md`, `DECISIONS.md`, `IDEAS/` — as the
// /registers/ screen reads and writes them, and what is handed to Claude Code
// when a person brings one of them to the workbench.
//
// Nothing here parses a register. The records are fli's `collectRegisterAtlas`
// (which reads through `registers.js`, `decisions.js` and `next.js`), a ruling
// is fli's `decide`, and a row is filed by Claude running `fli register:file`
// — so this screen, `fli next`, `fli decide` and `register:check` cannot
// disagree about what a row says.

import { readdirSync, statSync } from 'node:fs'
import { dirname, join }         from 'node:path'
import { fileURLToPath }         from 'node:url'

// ─── fli ──────────────────────────────────────────────────────────────────────

export type Link = { label: string, href: string, edit: string }
export type At   = { file: string, line: number | null, href: string, edit: string }

export type Issue = {
  id: string, aliases: string[], pkg: string[], title: string, status: string,
  severity: string, verified: string, closed: boolean, body: string, refs: string[],
  blockedBy: string[], rank: { n: number | null, score: number, terms: string[] } | null,
  links: Link[], at: At,
}
export type Ruling = {
  id: string | null, date: string, section: string, title: string, status: string,
  supersededBy: string | null, body: string, refs: string[], links: Link[], at: At,
}
export type Question = {
  id: string, source: string, question: string, state: 'ruled' | 'decidable' | 'open',
  options: { letter: string, text: string }[], recommend: { letter: string, qualifier: string | null, why: string } | null,
  paper: string | null, at: At,
}
export type Idea = {
  id: string, title: string, status: string, dated: string, body: string,
  refs: string[], questions: number, links: Link[], at: At,
}
export type Atlas = {
  name: string, prefix: string | null, dir: string, sources: string[], sections: string[],
  ready: string[], blocked: string[],
  issues: Issue[], rulings: Ruling[], ideas: Idea[], questions: Question[],
}

type Decided = { ok: true, ruling: string, pick: string, closed: string | null, files: string[] } | { ok: false, reason: string }

type Option    = { letter: string, text: string }
type Recommend = { letter: string, qualifier: string | null, why: string }
type Asked = {
  id: string, file: string, line: number, question: string, body: string,
  options: Option[], recommend: Recommend | null, paper: { id: string, status: string } | null,
}
type AskEvent =
  | { type: 'session', id: string } | { type: 'text', text: string } | { type: 'tool', text: string }
  | { type: 'result', ok: boolean, stop: string | null, cost: number | null } | { type: 'error', text: string }

type Fli = {
  collectRegisterAtlas: (root: string) => Atlas
  findRegisterRoot:     (start: string) => string | null
  registerLayout:       (root: string) => { dir: string }
  decide: (o: { root: string, id: string, pick: string, why: string, section: string }) => Decided
  openDecisions:  (root: string) => { decidable: Asked[], open: Asked[] }
  rulingSections: (root: string) => string[]
  runAsk: (o: { root: string, prompt: string, session?: string | null, bin?: string, onEvent: (e: AskEvent) => void }) =>
    { error: string } | { child: unknown, done: Promise<number | null> }
}

// The cli is a devDependency and the image installs none, so it is reached
// only on a machine where the screen is offered at all.
let fli: Promise<Fli> | null = null
export const loadFli = () => fli ??= Promise.all([
  import('@frontierjs/cli/core/register-atlas.js'),
  import('@frontierjs/cli/core/registers.js'),
  import('@frontierjs/cli/core/decide.js'),
  import('@frontierjs/cli/core/decisions.js'),
  import('@frontierjs/cli/core/ask-claude.js'),
]).then(mods => Object.assign({}, ...mods) as unknown as Fli)

/** The register root this Basecamp sits in, found from this file rather than the cwd. */
export async function registerRoot(): Promise<string | null> {
  const f = await loadFli()
  return f.findRegisterRoot(dirname(fileURLToPath(import.meta.url)))
}

// ─── the read, cached on the files ────────────────────────────────────────────
//
// A read is ~3s here: `rankNext` walks git history for every row. The cache is
// keyed on the register files' mtimes, so a row Claude files in the workbench
// shows on the next poll; the TTL is for the ranking, whose git half moves
// without any register file changing.

const RANK_TTL_MS = 5 * 60_000

function signature(root: string, dir: string): string {
  const stamp = (p: string) => { try { return statSync(p).mtimeMs } catch { return 0 } }
  const parts = ['ISSUES.md', 'ISSUES_ARCHIVE.md', 'DECISIONS.md', 'IDEAS', 'IDEAS/shipped'].map(n => stamp(join(dir, n)))
  // A paper edited in place moves its own mtime and not the directory's, and
  // a shipped paper can still hold a question nobody ruled.
  for (const sub of ['IDEAS', 'IDEAS/shipped']) {
    try { for (const n of readdirSync(join(dir, sub))) parts.push(stamp(join(dir, sub, n))) } catch {}
  }
  return `${root}|${parts.join(',')}`
}

let cached: { sig: string, at: number, atlas: Atlas } | null = null

export async function readAtlas(root: string): Promise<Atlas> {
  const f   = await loadFli()
  const dir = join(root, cached?.atlas.dir ?? '.')
  const sig = signature(root, dir)
  if (cached && cached.sig === sig && Date.now() - cached.at < RANK_TTL_MS) return cached.atlas
  const atlas = f.collectRegisterAtlas(root)
  cached = { sig: signature(root, join(root, atlas.dir)), at: Date.now(), atlas }
  return atlas
}

export function forgetAtlas() { cached = null }

// ─── the queue ────────────────────────────────────────────────────────────────
//
// /registers/decide/ is `fli decide`'s walk on a phone: the questions with
// lettered options, in the walk's order, one card each. Read off fli's
// `openDecisions` rather than the atlas, because a card needs the prose the
// question is argued in and the atlas's ranking (3s, git history) is nothing
// a card shows. A question an existing ruling settles is the walk's alone —
// confirming one is `fli decide --by`, which this screen does not offer.

export type Queued = {
  id: string, question: string, body: string, options: Option[], recommend: Recommend | null,
  paper: string | null, status: string, file: string, line: number,
}
export type Queue = { sections: string[], questions: Queued[], open: number }

let queued: { sig: string, queue: Queue } | null = null

export async function readQueue(root: string): Promise<Queue> {
  const f   = await loadFli()
  const sig = signature(root, f.registerLayout(root).dir)
  if (queued?.sig === sig) return queued.queue
  const queue = f.openDecisions(root)
  const out: Queue = {
    sections: f.rulingSections(root),
    open:     queue.open.length,
    questions: queue.decidable.map(q => ({
      id: q.id, question: q.question, body: q.body, options: q.options, recommend: q.recommend,
      paper: q.paper?.id ?? null, status: q.paper?.status ?? '', file: q.file, line: q.line,
    })),
  }
  queued = { sig, queue: out }
  return out
}

// ─── Claude explains a question ───────────────────────────────────────────────
//
// fli's `runAsk`, the read-only ask: `claude -p` with Read, Grep, Glob and a
// Bash allow-list, hooks off, a $2 budget — the argv keeps it read-only, not
// the prompt. Not the workbench: a send there joins the checkout's own chat,
// queues behind whatever it is running, and answers on another screen.
//
// Held in this process only. A restart loses an explanation, which costs one
// press; storing it would be a copy of a reply about files that move.

export type Turn = { ask: string | null, text: string, steps: number, doing: string }
export type Explanation = {
  id: string, state: 'working' | 'done' | 'error', turns: Turn[], cost: number, error: string | null, startedAt: string,
}

// Each run is a separate claude process on this laptop, and a swipe is cheap.
export const EXPLAINING_MAX = 3
const FOLLOW_MAX = 2000

const explanations = new Map<string, Explanation & { session: string | null }>()

export function explanationOf(id: string): Explanation | null {
  const held = explanations.get(id)
  if (!held) return null
  const { session, ...shown } = held
  return { ...shown, turns: held.turns.map(t => ({ ...t })) }
}

export function explainPrompt(q: Queued): string {
  return [
    'I am ruling on the open questions in this workspace one at a time, from my phone, and pressed "explain" on this one before picking.',
    '',
    `${q.id} — ${q.file}:${q.line}`,
    `**${q.question}** ${q.body}`.trim(),
    ...q.options.map(o => `- **${o.letter}** — ${o.text}`),
    q.recommend ? `- **Recommend ${q.recommend.qualifier ?? q.recommend.letter}** — ${q.recommend.why}` : '- No recommendation is written.',
    '',
    'You are read-only: Read, Grep, Glob, and git, rg and ls in Bash. Read the question where it is argued and what it cites — rulings in DECISIONS.md, rows in ISSUES.md, the code it names. Then explain, for someone choosing in the next minute:',
    '1. What is actually being decided, in two or three plain sentences.',
    '2. Each option: what changes if I pick it, what it costs, what it rules out.',
    '3. Whether the recommendation still holds against the code as it is now — cite file:line where it matters — and what would change your mind.',
    'Under 300 words. No preamble and no headings; the reply renders on a narrow card.',
  ].join('\n')
}

/**
 * Start explaining `q`, or ask a follow-up in the same session. A question
 * already being explained answers what it has so far rather than starting a
 * second run; one already explained answers that, until a follow-up asks
 * more. A press after a failed run starts over.
 */
export async function explain(root: string, q: Queued, input: { ask?: unknown, bin?: string }): Promise<Explanation | { refused: string }> {
  const follow = String(input.ask ?? '').trim()
  const was    = explanations.get(q.id)
  if (was?.state === 'working')            return explanationOf(q.id)!
  if (was?.state === 'done' && !follow)    return explanationOf(q.id)!
  const held = was?.state === 'error' && !follow ? undefined : was
  if (follow.length > FOLLOW_MAX) return { refused: `that is ${follow.length} characters; ${FOLLOW_MAX} is the limit` }
  const running = [...explanations.values()].filter(e => e.state === 'working').length
  if (running >= EXPLAINING_MAX) return { refused: `Claude is already explaining ${running} questions — wait for one to finish` }

  const f     = await loadFli()
  const entry: Explanation & { session: string | null } = held
    ?? { id: q.id, state: 'working', turns: [], cost: 0, error: null, startedAt: new Date().toISOString(), session: null }
  const turn: Turn = { ask: follow || null, text: '', steps: 0, doing: '' }
  const resume = held?.session ?? null
  const prompt = resume ? follow : follow ? `${explainPrompt(q)}\n\nAnd specifically: ${follow}` : explainPrompt(q)

  const run = f.runAsk({ root, prompt, session: resume, bin: input.bin, onEvent: e => {
    if (e.type === 'session') entry.session = e.id
    // Text before a tool call is narration ("let me read the paper"); the
    // last text block is the answer.
    if (e.type === 'text')    turn.text = e.text
    if (e.type === 'tool')    { turn.steps++; turn.doing = e.text }
    if (e.type === 'result' && !e.ok) entry.error = `Claude stopped before finishing (${e.stop ?? 'unknown'})`
    if (e.type === 'result')  entry.cost += e.cost ?? 0
    if (e.type === 'error')   entry.error = e.text
  } })
  if ('error' in run) return { refused: run.error }

  entry.state = 'working'
  entry.error = null
  entry.turns.push(turn)
  explanations.set(q.id, entry)
  run.done.then(code => { entry.state = entry.error || code ? 'error' : 'done' })
  return explanationOf(q.id)!
}

/** Every record holding `id`, of every kind — a ruling and the question it answered share one. */
export function recordsFor(atlas: Atlas, id: string) {
  const key = id.toLowerCase()
  const is  = (x: string | null | undefined) => !!x && x.toLowerCase() === key
  return {
    issues:    atlas.issues.filter(r => is(r.id) || r.aliases.some(is)),
    rulings:   atlas.rulings.filter(r => is(r.id)),
    questions: atlas.questions.filter(q => is(q.id)),
    ideas:     atlas.ideas.filter(i => is(i.id)),
  }
}

/** The ids `text` names that the registers hold, in the order they are written. */
export function namedIds(atlas: Atlas, text: string): string[] {
  const out  = new Set<string>()
  const word = atlas.prefix ? new RegExp(`\\b${atlas.prefix}-D?\\d+\\b`, 'gi') : null
  for (const m of word ? text.matchAll(word) : []) out.add(m[0].toUpperCase())
  // A paper's question id is `paper:slug`, which no prefix pattern reaches.
  for (const q of atlas.questions) if (q.state !== 'ruled' && text.includes(q.id)) out.add(q.id)
  return [...out].filter(id => {
    const r = recordsFor(atlas, id)
    return r.issues.length + r.rulings.length + r.questions.length + r.ideas.length > 0
  })
}

// ─── what Claude is handed ────────────────────────────────────────────────────

export const INTENTS = ['discuss', 'file', 'fix', 'frame'] as const
export type Intent = typeof INTENTS[number]

const TEXT_MAX = 20_000

/** One line per record, so Claude starts at the row rather than searching for it. */
function cite(atlas: Atlas, id: string): string[] {
  const r = recordsFor(atlas, id)
  const at = (a: At) => `${a.file}${a.line ? `:${a.line}` : ''}`
  return [
    ...r.issues.map(i => `- ${i.id} — issue, ${i.closed ? 'closed' : `${i.severity}, ${i.status}`} (${at(i.at)}): ${i.title}`),
    ...r.questions.map(q => `- ${q.id} — question, ${q.state} (${at(q.at)}): ${q.question}`),
    ...r.rulings.map(d => `- ${d.id} — ruling ${d.date}${d.status ? `, ${d.status}` : ''} (${at(d.at)}): ${d.title}`),
    ...r.ideas.map(i => `- ${i.id} — paper, ${i.status} (${at(i.at)}): ${i.title}`),
  ]
}

/**
 * The prompt for one send, or a refusal a person can act on.
 *
 * `fix` and `frame` are the repo's own skills, so the loop they run is the one
 * `fix:loop` and `frame:loop` run and not a second description of it here.
 * Each takes exactly one id, of the kind it works on.
 */
export function composePrompt(atlas: Atlas, input: { text?: unknown, intent?: unknown }): { prompt: string, ids: string[] } | { refused: string } {
  const text   = String(input.text ?? '').trim()
  const intent = String(input.intent ?? 'discuss') as Intent
  if (!INTENTS.includes(intent)) return { refused: `'${intent}' is not one of ${INTENTS.join(', ')}` }
  if (!text)                     return { refused: 'paste an issue, a question or an id first' }
  if (text.length > TEXT_MAX)    return { refused: `that is ${text.length} characters; ${TEXT_MAX} is the limit` }

  const ids   = namedIds(atlas, text)
  const notes = (id: string) => text.replace(id, '').trim()

  if (intent === 'fix') {
    const open = ids.filter(id => recordsFor(atlas, id).issues.some(i => !i.closed))
    if (open.length !== 1) return { refused: open.length ? `fix takes one open row, and this names ${open.join(', ')}` : 'fix takes the id of an open row — paste one, or discuss it first' }
    const rest = notes(open[0])
    return { ids, prompt: `/fix-next ${open[0]} --ask${rest ? `\n\nFrom the person who sent it:\n\n${rest}` : ''}` }
  }

  if (intent === 'frame') {
    const open = ids.filter(id => recordsFor(atlas, id).questions.some(q => q.state !== 'ruled'))
    if (open.length !== 1) return { refused: open.length ? `frame takes one open question, and this names ${open.join(', ')}` : 'frame takes the id of an open question' }
    const rest = notes(open[0])
    return { ids, prompt: `/frame-next ${open[0]}${rest ? `\n\nFrom the person who sent it:\n\n${rest}` : ''}` }
  }

  const named = ids.flatMap(id => cite(atlas, id))
  const head  = [
    text,
    '',
    '---',
    `Sent from Basecamp's Registers screen. The text above is about this workspace's registers — ISSUES.md, DECISIONS.md and IDEAS/ — and may be a row that exists or one that does not yet.`,
    ...(named.length ? ['', 'Records it names:', ...named] : []),
    '',
    'First place it: an existing row (read it at its line), a ruling that already settles it, or new. Search with `fli register:find <terms>` before calling it new — a duplicate is the likeliest outcome.',
  ]

  const tail = intent === 'file' ? [
    'Then write it down, and nothing else:',
    '- New: `fli register:file --sev <S1-S4|decision> --area <package> --title "…" --detail "…"`. Severity from the table headers in ISSUES.md; the detail cites file:line.',
    '- Already a row: `fli register:amend <id> --detail "…"` only where this adds a fact the row lacks.',
    '- Already settled by a ruling: write nothing and name the ruling.',
    'Change no source file. End with the id you wrote and one line on why that severity.',
  ] : [
    'Then talk it through with me. Change no file — not the registers, not the source — until I say which way.',
    '1. Does it still reproduce? Read the code and cite file:line, saying still present, looks fixed or unclear.',
    '2. What already governs it — the rulings and rows it cites, and the realm hazard skill where one applies.',
    '3. End with the options you see, lettered, a recommendation and why, and the next step each would be: file it, amend the row, frame it as a question, or fix it.',
  ]

  return { ids, prompt: [...head, ...tail].join('\n') }
}

/** A branch name for a send, from the first id it names. */
export function branchSlug(ids: string[], taken: (slug: string) => boolean): string {
  const base = (ids[0] ?? 'discuss').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'discuss'
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`
    if (!taken(slug)) return slug
  }
  return `${base}-${Date.now().toString(36)}`
}
