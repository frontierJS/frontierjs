#!/usr/bin/env node
// ============================================================
// Turn open questions into decidable ones, one paper per headless session
//
//   bun run frame:loop                        # up to 3 papers
//   bun run frame:loop -- --rows 5 --max 4    # 5 papers, at most 4 questions each
//   bun run frame:loop -- --paper slices --dry-run
//
// A question is OPEN until its bullet carries lettered options and a
// recommendation (`core/decisions.js`); then it is DECIDABLE and the owner rules
// with `fli decide`. Each session runs `/frame-next` over one paper's open
// questions and writes those options — it never rules. The paper is the unit
// because its questions share its argument: framed one per session, the same
// paper is read once per question and three siblings can be framed to
// contradict each other.
//
// Papers are taken in `IDEAS/overview.md` order — a paper's rank is the first
// line of the overview naming its file, so the waves order the queue and a
// paper the overview never names comes last. Within a rank, the paper holding
// more open questions first. Within a paper, file order.
//
// What a session did is read off the register, not off what it says: after it
// ends, every question is re-read with `readDecisions` — the reader `fli
// decisions` and `fli decide` use — and graded:
//
//   framed    decidable, with a recommendation
//   settled   still open, with a recommendation naming a live ruling — `fli
//             decide <id> --by <ruling>` takes it with no --why
//   unclear   untouched, and the session said why (the log keeps the reason)
//   busy      another session holds the paper
//   failed    anything else — retried once on the next rung
//
// A session that writes DECISIONS.md, runs `fli decide`, or strikes a question
// has crossed the line the skill exists to hold, and the loop stops there.
//
// The session, its log and the ladder are `headless.mjs`. One line per attempt
// goes to ~/.fli/frame-loop.jsonl with the outcome of each question; a question
// with any outcome but `failed` there is not queued again.
// ============================================================

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL }  from 'node:url'

import { ROOT, LOG_DIR, LADDER, runSession, printAttempt, appendLog, readLog, citation, parseArgs, printHelp, writes } from './headless.mjs'

const LOG      = join(LOG_DIR, 'frame-loop.jsonl')
const DECIDING = import(pathToFileURL(join(ROOT, 'packages', 'cli', 'core', 'decisions.js')).href)
const REGISTER = import(pathToFileURL(join(ROOT, 'packages', 'cli', 'core', 'registers.js')).href)

const args       = parseArgs(process.argv.slice(2))
const rows       = Number(args.rows ?? 3)
const max        = Number(args.max ?? 5)
const budget     = Number(args.budget ?? 5)
const permission = args['permission-mode'] ?? 'auto'
const dryRun     = Boolean(args['dry-run'])

if (args.help) { printHelp(import.meta.url); process.exit(0) }

const { readDecisions, settledBy, liveRulings } = await DECIDING
const { readRegisters } = await REGISTER

// ─── the loop ───────────────────────────────────────────────

const skipped = new Set()
const tally   = { framed: 0, settled: 0, unclear: 0, busy: 0, failed: 0 }
let spent     = 0

for (let n = 0; n < rows; n++) {
  const item = nextPaper()
  if (!item) { console.log('[frame-loop] no open question left to frame'); break }
  const { paper, questions } = item

  console.log(`\n[frame-loop] ${n + 1}/${rows} ${paper.id} (${paper.file}) — ${questions.length} question(s)`)
  for (const q of questions) console.log(`[frame-loop]   ${q.id}`)
  if (dryRun) { console.log(preBrief(paper, questions)); skipped.add(paper.id); continue }

  let pending = questions
  let crossed = null
  const outcomes = {}
  for (const [rung, { model, effort }] of LADDER.entries()) {
    const before  = readFileSync(join(ROOT, 'DECISIONS.md'), 'utf8')
    const earlier = rung > 0 || readLog(LOG).some(e => e.id === paper.id)
    const prompt  = [
      `/frame-next ${paper.id} ${pending.map(q => q.id).join(' ')}`,
      earlier ? `An earlier frame-loop attempt at ${paper.file} did not finish; edits under these questions are that attempt's, so read git diff and build on them.` : '',
      preBrief(paper, pending),
    ].filter(Boolean).join('\n\n')

    appendLog(LOG, { id: paper.id, questions: pending.map(q => q.id), model, effort, outcome: 'started' })
    const lines = []
    const notes = {}
    const run   = await runSession(prompt, {
      model, effort, permission, cap: rung === 0 ? budget : budget * 2,
      tag: 'frame-loop', phases: { orient: 0, rules: 0, frame: 0, verify: 0, close: 0 },
      phaseOf: (part, edited) => { crossed ??= crossing(part); return phaseOf(part, edited) },
    })
    spent += run.cost

    const claims = claimed(run.report)
    const after  = new Map(readDecisions(ROOT).map(q => [q.id, q]))
    if (readFileSync(join(ROOT, 'DECISIONS.md'), 'utf8') !== before) crossed ??= 'DECISIONS.md changed while the session ran'
    for (const q of pending) {
      outcomes[q.id] = grade(q, after.get(q.id), claims.get(q.id)?.status)
      if (claims.get(q.id)?.note) notes[q.id] = claims.get(q.id).note
      if (outcomes[q.id] === 'ruled') crossed ??= `${q.id} was struck`
      lines.push(`${outcomes[q.id].padEnd(8)} ${q.id}${notes[q.id] ? ` — ${notes[q.id]}` : ''}`)
    }

    const summary = Object.values(outcomes).join(' ')
    appendLog(LOG, { id: paper.id, model, effort, cost: run.cost, turns: run.turns, minutes: run.minutes, phases: run.phases, outcome: summary, outcomes: { ...outcomes }, notes, stop: run.stop, denied: run.denied, crossed })
    printAttempt('frame-loop', { model, effort }, summary, run)
    for (const l of lines) console.log(`[frame-loop]   ${l}`)

    if (crossed) break
    pending = pending.filter(q => outcomes[q.id] === 'failed')
    if (!pending.length || Object.values(outcomes).includes('busy')) break
  }

  for (const o of Object.values(outcomes)) tally[o in tally ? o : 'failed']++
  if (crossed) {
    console.log(`[frame-loop] STOPPED — the session ruled rather than framed: ${crossed}. Read git diff before anything else runs.`)
    break
  }
  skipped.add(paper.id)
}

console.log(`\n[frame-loop] ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(' · ')} · $${spent.toFixed(2)} spent · log ${LOG}`)

// ─── the queue ──────────────────────────────────────────────

// A question the log already carries an outcome for is not framed twice; a
// failed one is, since a failure is what the ladder exists for.
function nextPaper() {
  const done = new Set(readLog(LOG).flatMap(e => Object.entries(e.outcomes ?? {}).filter(([, o]) => o !== 'failed').map(([id]) => id)))
  const open = readDecisions(ROOT).filter(q => q.source === 'idea' && q.state === 'open' && !q.recommend && !done.has(q.id))

  const papers = new Map()
  for (const q of open) {
    if (skipped.has(q.paper.id) || (args.paper && q.paper.id !== args.paper)) continue
    if (!papers.has(q.paper.id)) papers.set(q.paper.id, { paper: q.paper, questions: [] })
    papers.get(q.paper.id).questions.push(q)
  }

  const overview = readFileSync(join(ROOT, 'IDEAS', 'overview.md'), 'utf8').split('\n')
  const rank = (file) => { const i = overview.findIndex(l => l.includes(basename(file))); return i === -1 ? Infinity : i }
  const [first] = [...papers.values()].sort((a, b) => rank(a.paper.file) - rank(b.paper.file) || b.questions.length - a.questions.length)
  return first && { paper: first.paper, questions: first.questions.slice(0, max) }
}

// ─── the pre-brief ──────────────────────────────────────────

// Located, not read: where the paper's argument sits, each question whole, what
// each cites, and which rulings share its terms. Weighing any of it is the
// session's.
function preBrief(paper, questions) {
  const lines = readFileSync(join(ROOT, paper.file), 'utf8').split('\n')
  const out   = ['## Pre-brief (frame-loop, by script)', '', `Paper: ${paper.file} (id \`${paper.id}\`, status ${paper.status || 'none'})`]

  const lede = opening(lines)
  if (lede) out.push('', `Opening: ${lede}`)

  const heads = lines.flatMap((l, i) => /^#{2,3}\s/.test(l) ? [{ text: l.trim(), start: i + 1 }] : [])
  if (heads.length) {
    out.push('', 'Its sections (line ranges; read the ones a question leans on, not the whole paper):')
    heads.forEach((h, i) => out.push(`- ${h.start}-${(heads[i + 1]?.start ?? lines.length + 1) - 1}  ${h.text}`))
  }

  const rulings = headings()
  for (const q of questions) {
    const text = bullet(lines, q.line)
    out.push('', `### ${q.id}`, '', `${paper.file}:${q.line}, verbatim:`, '', ...text.map(l => `    ${l}`))

    const cited = [...new Set(text.join(' ').match(/FJS-D?\d+/g) ?? [])]
    const said  = (id) => rulings.find(r => r.id === id)?.line ?? citation(id) ?? 'not found in DECISIONS.md, ISSUES.md or ISSUES_ARCHIVE.md'
    if (cited.length) out.push('', 'Cited:', ...cited.map(id => `- ${id}: ${said(id)}`))

    const near = neighbors(text.join(' '), rulings.filter(r => !cited.includes(r.id)))
    if (near.length) out.push('', 'Rulings sharing its terms (a candidate for `settled` if one already answers it):', ...near.map(r => `- ${r.id} (${r.shared.join(', ')}): ${r.title}`))
  }

  out.push('', 'Start from this rather than re-finding it; whether the options are real, grounded and complete is still yours.')
  return out.join('\n')
}

// The first paragraph under the title, where a paper states what it proposes.
function opening(lines) {
  const title = lines.findIndex(l => /^#\s/.test(l))
  const para  = []
  for (const l of lines.slice(title + 1)) {
    if (/^#{1,3}\s/.test(l)) break
    if (!l.trim()) { if (para.length) break; continue }
    if (/^[>|`-]/.test(l.trim()) && !para.length) continue
    para.push(l.trim())
  }
  const text = para.join(' ')
  return text.length > 600 ? `${text.slice(0, 600)}…` : text
}

// A question is its bullet: the lead line and every indented line under it,
// ending at the next line that starts in column one.
function bullet(lines, line) {
  const out = [lines[line - 1]]
  for (const l of lines.slice(line)) {
    if (l.trim() && !/^\s/.test(l)) break
    out.push(l)
  }
  while (out.length && !out.at(-1).trim()) out.pop()
  return out
}

// Every ruling, retired ones included, so a citation of a superseded one says so.
function headings() {
  return readRegisters(ROOT).decisions.map(d => {
    const retired = d.status && d.status !== 'amended-by'
    return {
      id:    d.id,
      live:  !retired,
      title: d.title.slice(0, 200),
      line:  `${d.title.slice(0, 200)} (DECISIONS.md${retired ? `, ${d.status}${d.supersededBy ? ` ${d.supersededBy}` : ''}` : ''})`,
      text:  `${d.title} ${d.body.split('\n')[0]}`,
    }
  })
}

// Only a term shaped like code is a subject: a plain word (`Product`,
// `retryable`), a document path or an SQL keyword matches rulings about
// something else. A term in more than a dozen rulings is vocabulary.
function neighbors(text, rulings) {
  const CODE_SHAPED = /[$@_(]|[a-z][A-Z]|\.(?!md$)\w|\w-\w/
  const live   = rulings.filter(r => r.live)
  const terms  = [...new Set([...text.matchAll(/`([^`\n]{3,60})`/g)].map(m => m[1]))]
    .filter(t => !/^FJS-/.test(t) && !/\.md$/.test(t) && CODE_SHAPED.test(t))
  const usable = terms.filter(t => live.filter(r => r.text.includes(t)).length <= 12)
  return live
    .map(r => ({ ...r, shared: usable.filter(t => r.text.includes(t)) }))
    .filter(r => r.shared.length)
    .sort((a, b) => b.shared.length - a.shared.length)
    .slice(0, 5)
}

// ─── reading the session back ───────────────────────────────

function claimed(report) {
  const out = new Map()
  for (const m of String(report).matchAll(/^frame-next: (\S+) (framed|settled|unclear|busy|failed)\b[ \t—–-]*(.*)$/gm)) out.set(m[1], { status: m[2], note: m[3].trim() })
  return out
}

// The register decides; the claim only says what the register cannot — that a
// question was left alone on purpose, or that the paper was somebody else's.
function grade(q, now, claim) {
  if (!now)                   return 'failed'
  if (now.state === 'ruled')  return 'ruled'
  if (claim === 'busy')       return 'busy'
  if (now.state === 'decidable' && now.recommend) return 'framed'
  if (settledBy(now, liveRulings(ROOT))) return 'settled'
  if (claim === 'unclear' && now.state === 'open' && !now.recommend) return 'unclear'
  return 'failed'
}

// ─── phases, and the line ───────────────────────────────────

// A call that writes is framing even when it verifies in the same breath.
function phaseOf(part, edited) {
  const text = `${part.input?.command ?? ''} ${part.input?.file_path ?? ''} ${part.input?.skill ?? ''}`
  if (part.name === 'Skill' && /decision-rules/.test(text)) return 'rules'
  if (writes(part)) return 'frame'
  if (/\bfli decisions\b|readDecisions/.test(text)) return 'verify'
  if (/\bfli done\b/.test(text)) return 'close'
  return edited ? 'frame' : 'orient'
}

function crossing(part) {
  const path = part.input?.file_path ?? ''
  const cmd  = part.input?.command ?? ''
  if (['Edit', 'Write'].includes(part.name) && /(^|\/)DECISIONS\.md$/.test(path)) return `wrote ${path}`
  if (part.name === 'Bash' && /\bfli (register:)?decide\b|(sed -i|\btee\b|>)[^|;&]*\bDECISIONS\.md\b/.test(cmd)) return `ran ${cmd.split('\n')[0].slice(0, 100)}`
  return null
}
