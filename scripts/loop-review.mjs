#!/usr/bin/env node
// ============================================================
// Read a loop's attempts back through their transcripts and name what repeats
//
//   bun run loop:review                          # last 20 fix-loop attempts
//   bun run loop:review -- --log frame-loop --last 50
//   bun run loop:review -- --ask                 # one session turns it into suggestions
//
// The loop log says what each attempt cost and how it ended; the transcript
// says why. An attempt's transcript is found by the `sessionId` its log entry
// carries, and an entry older than that field is matched instead by its start
// time and the row id its prompt opens with.
//
// What is reported is what repeats across sessions, because one session's
// detour is noise and the same detour in six is a missing pre-brief line, a
// hook, or a skill step: files read by most sessions, calls that fail the same
// way, the same call made twice in one session, tool calls denied, and how
// many calls a session makes before its first edit.
//
// The report is printed and written to ~/.fli/<log>-review.md. With --ask, one
// `claude -p` session in plan mode reads it and answers with changes to make —
// it edits nothing.
// ============================================================

import { readdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir }                                   from 'node:os'
import { join }                                      from 'node:path'

import { ROOT, LOG_DIR, readLog, writes, atRoot, runSession, parseArgs, printHelp } from './headless.mjs'

const args  = parseArgs(process.argv.slice(2))
if (args.help) { printHelp(import.meta.url); process.exit(0) }

const name  = args.log ?? 'fix-loop'
const last  = Number(args.last ?? 20)
const LOG   = join(LOG_DIR, `${name}.jsonl`)
const OUT   = join(LOG_DIR, `${name}-review.md`)
const TRANS = join(homedir(), '.claude', 'projects', ROOT.replace(/[^A-Za-z0-9]/g, '-'))

// ─── the attempts ───────────────────────────────────────────

const entries  = readLog(LOG)
const attempts = []
for (const [i, e] of entries.entries()) {
  if (e.outcome === 'started' || e.cost === undefined) continue
  const start = entries.slice(0, i).findLast(s => s.id === e.id && s.outcome === 'started')
  attempts.push({ ...e, startedAt: start?.at })
}
const recent = attempts.slice(-last)
if (!recent.length) { console.log(`[loop-review] no finished attempts in ${LOG}`); process.exit(0) }

const heads = transcriptHeads(Date.parse(recent[0].startedAt ?? recent[0].at) - 60_000)
for (const a of recent) {
  a.file  = a.sessionId ? join(TRANS, `${a.sessionId}.jsonl`) : matchByStart(a, heads)
  a.trace = a.file ? readTranscript(a.file) : null
}

// ─── the report ─────────────────────────────────────────────

const traced = recent.filter(a => a.trace)
const lines  = []
const out    = s => lines.push(s)
const money  = n => `$${n.toFixed(2)}`
const share  = n => `${n}/${traced.length}`

out(`# ${name} review — last ${recent.length} attempts (${traced.length} with a transcript)\n`)

out('## Outcomes\n')
out('| model/effort | outcome | attempts | cost | turns (avg) |')
out('| --- | --- | --- | --- | --- |')
for (const [key, group] of groupBy(recent, a => `${a.model}/${a.effort}\t${a.outcome}`)) {
  const [rung, outcome] = key.replaceAll('undefined', '?').split('\t')
  out(`| ${rung} | ${outcome} | ${group.length} | ${money(sum(group, a => a.cost))} | ${avg(group, a => a.turns ?? 0)} |`)
}
const closed = recent.filter(a => a.outcome === 'closed').length
out(`\nTotal ${money(sum(recent, a => a.cost))}; ${closed} closed, ${closed ? money(sum(recent, a => a.cost) / closed) : '—'} per closed row.\n`)

if (traced.length) {
  out('## Calls before the first edit\n')
  const edited = traced.filter(a => a.trace.firstEdit >= 0)
  out(`Average ${avg(edited, a => a.trace.firstEdit)} calls of ${avg(traced, a => a.trace.calls.length)}; ${traced.length - edited.length} session(s) never edited.`)
  for (const a of [...edited].sort((x, y) => y.trace.firstEdit - x.trace.firstEdit).slice(0, 5))
    out(`- ${a.id} (${a.outcome}): ${a.trace.firstEdit} calls before the first edit`)
  out('')

  out('## Files most sessions read\n')
  out('Candidates for the pre-brief, or for a CLAUDE.md line that makes reading them unnecessary.\n')
  const reads = new Map()
  for (const a of traced) for (const f of new Set(a.trace.reads)) reads.set(f, (reads.get(f) ?? 0) + 1)
  const common = [...reads].filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]).slice(0, 15)
  for (const [f, n] of common) out(`- ${f} — ${share(n)} sessions`)
  if (!common.length) out('No file was read by more than one session.')
  out('')

  out('## Calls that fail\n')
  const fails = new Map()
  for (const a of traced) for (const f of a.trace.failures) {
    const g = fails.get(f.key) ?? { n: 0, sessions: new Set(), sample: f }
    g.n++; g.sessions.add(a.id); fails.set(f.key, g)
  }
  for (const [key, g] of [...fails].sort((x, y) => y[1].n - x[1].n).slice(0, 12))
    out(`- \`${key}\` — ${g.n}× in ${g.sessions.size} session(s)\n  - call: \`${g.sample.call}\`\n  - error: ${g.sample.error}`)
  if (!fails.size) out('None.')
  out('')

  out('## The same call twice in one session\n')
  const repeats = traced.flatMap(a => a.trace.repeats.map(r => ({ ...r, id: a.id })))
  for (const r of repeats.sort((x, y) => y.n - x.n).slice(0, 10)) out(`- ${r.id}: \`${r.call}\` ×${r.n}`)
  if (!repeats.length) out('None.')
  out('')

  out('## Most-run commands\n')
  const cmds = new Map()
  for (const a of traced) for (const c of a.trace.commands) cmds.set(c, (cmds.get(c) ?? 0) + 1)
  out([...cmds].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([c, n]) => `\`${c}\` ${n}`).join(' · ') + '\n')
}

const denied = recent.flatMap(a => a.deniedTools ?? [])
if (denied.length) {
  out('## Denied tool calls\n')
  for (const [tool, g] of groupBy(denied, t => t)) out(`- ${tool} ×${g.length}`)
  out('')
}

out('## Costliest attempts that did not close\n')
for (const a of recent.filter(a => a.outcome !== 'closed').sort((x, y) => y.cost - x.cost).slice(0, 5)) {
  out(`- ${a.id} ${a.model ?? '?'}/${a.effort} ${a.outcome} ${money(a.cost)} · ${a.turns ?? '?'} turns${a.stop && a.stop !== 'success' ? ` · stop ${a.stop}` : ''}`)
  if (a.file) out(`  - transcript: ${a.file}`)
  if (a.report) out(`  - report: ${a.report.replace(/\s+/g, ' ').slice(-300)}`)
}
out('')

const report = lines.join('\n')
writeFileSync(OUT, report)
console.log(report)
console.log(`[loop-review] written to ${OUT}`)

if (args.ask) {
  const run = await runSession([
    `Below is a review of the last ${recent.length} ${name} attempts, built by scripts/loop-review.mjs from ~/.fli/${name}.jsonl and the session transcripts it names.`,
    'Suggest the changes that would cut cost per closed row or raise how many rows close: pre-brief lines in scripts/fix-loop.mjs, skill steps under .claude/skills/, hooks, or CLAUDE.md lines.',
    'Ground each in the numbers or a transcript you open; name the file and the change; rank by expected saving. Edit nothing.',
    '', report,
  ].join('\n'), {
    model: 'opus', effort: 'high', permission: 'plan', cap: Number(args.budget ?? 3),
    tag: 'loop-review', phases: { read: 0 }, phaseOf: () => 'read',
  })
  console.log(`\n${run.report.trim()}`)
  writeFileSync(OUT, `${report}\n## Suggestions\n\n${run.report.trim()}\n`)
}

// ─── transcripts ────────────────────────────────────────────

// First line only: a transcript opens with the prompt it was started with.
function transcriptHeads(since) {
  const heads = []
  let files = []
  try { files = readdirSync(TRANS).filter(f => f.endsWith('.jsonl')) } catch {}
  for (const f of files) {
    const path = join(TRANS, f)
    if (statSync(path).mtimeMs < since) continue
    try {
      const first = JSON.parse(readHead(path).split('\n')[0])
      heads.push({ path, at: Date.parse(first.timestamp), content: String(first.content ?? '') })
    } catch {}
  }
  return heads
}

function readHead(path) {
  const fd  = openSync(path, 'r')
  const buf = Buffer.alloc(16_384)
  const n   = readSync(fd, buf, 0, buf.length, 0)
  closeSync(fd)
  return buf.subarray(0, n).toString('utf8')
}

// An entry older than the 'started' line has only its finish time, and the
// transcript opening nearest THAT is the next attempt's, so it takes the
// latest one opened before the finish.
function matchByStart(a, heads) {
  const mine = heads.filter(h => h.content.includes(a.id))
  if (!a.startedAt) {
    const done = Date.parse(a.at)
    return mine.filter(h => h.at < done - 1_000).sort((x, y) => y.at - x.at)[0]?.path
  }
  const at = Date.parse(a.startedAt)
  return mine
    .filter(h => h.at >= at - 5_000 && h.at <= at + 120_000)
    .sort((x, y) => Math.abs(x.at - at) - Math.abs(y.at - at))[0]?.path
}

function readTranscript(path) {
  let events
  try { events = readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch { return null }
  const calls = []
  const byId  = new Map()
  const failures = []
  for (const e of events) {
    if (e.isSidechain) continue
    for (const part of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (e.type === 'assistant' && part.type === 'tool_use') {
        const call = { name: part.name, input: part.input ?? {}, text: callText(part), cwd: e.cwd }
        calls.push(call)
        byId.set(part.id, call)
      }
      if (e.type === 'user' && part.type === 'tool_result' && part.is_error && byId.has(part.tool_use_id)) {
        const call = byId.get(part.tool_use_id)
        failures.push({ key: failKey(call), call: call.text.slice(0, 160), error: resultText(part).replace(/\s+/g, ' ').slice(0, 200) })
      }
    }
  }
  const seen = new Map()
  for (const c of calls) { const k = `${c.name} ${JSON.stringify(c.input)}`; seen.set(k, { call: c.text.slice(0, 120), n: (seen.get(k)?.n ?? 0) + 1 }) }
  return {
    calls,
    failures,
    firstEdit: calls.findIndex(c => writes({ name: c.name, input: c.input })),
    reads:     calls.flatMap(readsOf),
    repeats:   [...seen.values()].filter(r => r.n > 1),
    commands:  calls.filter(c => c.name === 'Bash').map(c => commandHead(c.input.command)),
  }
}

function callText(part) {
  const i = part.input ?? {}
  return atRoot(String(i.command ?? i.file_path ?? i.pattern ?? i.skill ?? i.prompt ?? JSON.stringify(i)).split('\n')[0])
}

function resultText(part) {
  return typeof part.content === 'string' ? part.content : (part.content ?? []).map(c => c.text ?? '').join(' ')
}

function failKey(call) {
  return call.name === 'Bash' ? `Bash ${commandHead(call.input.command)}` : call.name
}

// The command's first two words once a leading cd is stripped: `fli next`, `bun run`.
function commandHead(command = '') {
  return atRoot(command.split('\n')[0]).replace(/^cd \S+\s*(&&|;)\s*/, '').replace(/^\(\s*/, '').split(/\s+/).slice(0, 2).join(' ')
}

// A Read, or each file a Bash prints or outlines — sessions chain several
// `sed -n` ranges into one call, so every segment counts. The shell keeps a cd
// across calls, so a relative path is resolved against the cwd the transcript
// recorded for that call, or one file read from two folders counts twice.
function readsOf(c) {
  if (c.name === 'Read') return [atRoot(String(c.input.file_path ?? ''))]
  if (c.name !== 'Bash') return []
  const prints = /(?:^|[;&|(]\s*)(?:sed -n\s+\S+|cat|head(?:\s+-n?\s*\d+)?|tail(?:\s+-n?\s*\d+)?|fli outline)\s+([^\s;|&<>()'"]+)/g
  const command = String(c.input.command ?? '')
  const lead    = /^cd ['"]?([^\s;&'"]+)['"]?\s*(&&|;)/.exec(command)?.[1]
  const dir     = lead?.startsWith('/') ? atRoot(`${lead.replace(/\/$/, '')}/`) : join(atRoot(`${c.cwd ?? ROOT}/`), lead ?? '')
  return [...command.matchAll(prints)].map(m => m[1])
    .filter(f => !f.startsWith('-') && !f.startsWith('/tmp/'))
    .map(f => f.startsWith('/') ? atRoot(f) : join(dir, f))
}

// ─── arithmetic ─────────────────────────────────────────────

function groupBy(list, key) {
  const groups = new Map()
  for (const x of list) { const k = key(x); groups.set(k, [...(groups.get(k) ?? []), x]) }
  return groups
}

function sum(list, f) { return list.reduce((n, x) => n + (f(x) ?? 0), 0) }
function avg(list, f) { return list.length ? Math.round(sum(list, f) / list.length) : 0 }
