// ─── decide.js — answering a question the registers hold ─────────────────────
//
// The one writer behind `fli register:decide` and `fli gui`'s decisions panel.
// A pick does three things and they are one act: a ruling is prepended to its
// `DECISIONS.md` section under the next free `<PREFIX>-D` id, the question is struck
// in its paper with that id beside it, and `register:check` grades the result.
// A write that makes the registers disagree with themselves is put back and
// refused, so neither file is ever left half answered.
//
// `settle` is the same act for a question an existing ruling already answers:
// the strike alone, citing that ruling, and no new id — a pick would mint a
// second ruling saying what the first one says.
//
// A bullet whose lead names an open row in `ISSUES.md` § Needs a decision is
// that row's question, argued where it has room for options (`fli file --sev
// decision`). Answering it closes the row in the same act, and a pick takes the
// row's id rather than the next one: the row reserved it, and every `blocked by`
// naming it then resolves to the ruling. Left open, the row would hold its
// blocked work up after the question was answered, with nothing saying so.
//
// ── What it refuses ─────────────────────────────────────────────────────────
//
// A question with no options (there is nothing to pick), one already ruled, an
// option letter the question does not carry, a section `DECISIONS.md` does not
// have, and a pick AGAINST the recommendation with no reason given. The last is
// the only judgement here: following the paper's recommendation is an argument
// already written down, and overruling it without saying why leaves a ruling
// whose reason nobody can recover.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative }                                      from 'node:path'

import { readDecisions, rulingSections, QUESTION_ID } from './decisions.js'
import { moveToClosed }                from './close.js'
import { errorKeys, newErrors }          from './register-check.js'
import { readRegisters, registerLayout } from './registers.js'

const WHY_MAX = 2000

// A lead naming its row (`FJS-D470 — Does it?`) says the id once; the heading already does.
const LEAD_ID = /^`?[A-Z][A-Z0-9]*-D\d+`?\s*[—–:-]\s*/

/**
 * Rule on one question.
 *
 * Answers `{ ok: true, ruling, files }` or `{ ok: false, reason }` — a refusal
 * is an answer rather than a throw, because both callers show it to a person.
 */
export function decide({ root, id, pick, why = '', section, today = new Date() }) {
  const q = readDecisions(root).find(d => d.id === id)
  if (!q)                     return refuse(`no question has the id ${id}`)
  if (q.state === 'ruled')    return refuse(`${id} is already ruled`)
  if (q.state !== 'decidable') return refuse(`${id} has no options to pick from — write them into ${q.file} first`)

  const letter = String(pick ?? '').trim().toUpperCase()
  const option = q.options.find(o => o.letter === letter)
  if (!option) return refuse(`${id} offers ${q.options.map(o => o.letter).join(', ')}, not ${letter || 'nothing'}`)

  if (!rulingSections(root).includes(section)) {
    return refuse(`DECISIONS.md has no section named ${JSON.stringify(section ?? '')}`)
  }

  const reason   = oneParagraph(why)
  const followed = q.recommend?.letter === letter
  if (!reason && !followed) {
    return refuse(q.recommend
      ? `${letter} is not the recommendation (${q.recommend.letter}), so the ruling has to say why`
      : `${id} carries no recommendation, so the ruling has to say why`)
  }
  if (reason.length > WHY_MAX) return refuse(`the reason is ${reason.length} characters; ${WHY_MAX} is the limit`)

  const { dir, prefix, declared } = registerLayout(root)
  if (!prefix) return refuse(`package.json declares no usable registers.prefix${declared ? ` (${JSON.stringify(declared)} is not [A-Z][A-Z0-9]*)` : ''}, so there is no id to issue`)

  const date     = isoDate(today)
  const row      = heldRow(root, q)
  const ruling   = row?.id ?? `${prefix}-D${nextDecisionNumber(root)}`
  const decPath  = join(dir, 'DECISIONS.md')
  const paperAbs = join(root, q.file)
  const before   = { dec: readFileSync(decPath, 'utf8'), paper: readFileSync(paperAbs, 'utf8') }

  const struck = strikeQuestion(before.paper, q, { date, ruling, answer: `${option.letter} — ${trimStop(option.text)}` })
  if (!struck) return refuse(`${q.file}:${q.line} no longer starts with the question's bold lead — reread it`)

  // The link is written INTO `DECISIONS.md`, so it is relative to that file.
  const link  = relative(dir, paperAbs)
  const entry = rulingEntry({ q, link, option, ruling, date, reason: reason || q.recommend.why, followed: !reason })
  const dec   = insertRuling(before.dec, section, entry)
  const close = row && closeRow(root, row, `Ruled [\`${ruling}\`](DECISIONS.md#${ruling.toLowerCase()}): **${letter}** — ${trimStop(option.text)}.`, today)
  if (close?.reason) return refuse(close.reason)

  const baseline = errorKeys(root)
  writeFileSync(decPath, dec)
  writeFileSync(paperAbs, struck)
  close?.write()

  const added = newErrors(baseline, root)
  if (added.length) {
    writeFileSync(decPath, before.dec)
    writeFileSync(paperAbs, before.paper)
    close?.undo()
    return refuse(`the ruling was put back: register:check found ${added.map(f => `${f.rule} — ${f.message}`).join('; ')}`)
  }

  return { ok: true, ruling, date, question: q.question, pick: letter, closed: row?.id ?? null, files: ['DECISIONS.md', q.file, ...(row ? [row.file] : [])] }
}

/**
 * Strike a question an existing ruling already answers — `decide --by`.
 *
 * Only the paper is written: the ruling is already in `DECISIONS.md`, and a
 * second one saying the same thing would be a second origin for it. Options are
 * not required, since a question that was settled before anybody framed it is
 * the common case. The reason rule is `decide`'s: a recommendation that names
 * the ruling is an argument already written down, and anything else says why.
 *
 * Answers `{ ok: true, ruling, question, files }` or `{ ok: false, reason }`.
 */
export function settle({ root, id, by, why = '', today = new Date() }) {
  const q = readDecisions(root).find(d => d.id === id)
  if (!q)                  return refuse(`no question has the id ${id}`)
  if (q.state === 'ruled') return refuse(`${id} is already ruled`)

  const ruling = String(by ?? '').trim().toUpperCase()
  const found  = readRegisters(root).decisions.find(d => d.id.toUpperCase() === ruling)
  if (!found) return refuse(`DECISIONS.md has no ruling ${ruling || '(none named)'}`)
  if (found.status === 'withdrawn') return refuse(`${found.id} is withdrawn, so it settles nothing`)
  if (found.status === 'superseded-by') {
    return refuse(`${found.id} is superseded${found.supersededBy ? ` by ${found.supersededBy} — settle by that one` : ''}`)
  }

  const reason = oneParagraph(why)
  const cited  = q.recommend?.why && new RegExp(`\\b${found.id}\\b`, 'i').test(q.recommend.why)
  if (!reason && !cited) {
    return refuse(`${id}'s recommendation does not name ${found.id}, so --why has to say how it answers the question`)
  }
  if (reason.length > WHY_MAX) return refuse(`the reason is ${reason.length} characters; ${WHY_MAX} is the limit`)

  const paperAbs = join(root, q.file)
  const before   = readFileSync(paperAbs, 'utf8')
  const struck   = strikeQuestion(before, q, { date: isoDate(today), ruling: found.id, answer: trimStop(reason || q.recommend.why) })
  if (!struck) return refuse(`${q.file}:${q.line} no longer starts with the question's bold lead — reread it`)

  const row   = heldRow(root, q)
  const close = row && closeRow(root, row, `Answered by [\`${found.id}\`](DECISIONS.md#${found.id.toLowerCase()}), an existing ruling.`, today)
  if (close?.reason) return refuse(close.reason)

  const baseline = errorKeys(root)
  writeFileSync(paperAbs, struck)
  close?.write()
  const added = newErrors(baseline, root)
  if (added.length) {
    writeFileSync(paperAbs, before)
    close?.undo()
    return refuse(`the strike was put back: register:check found ${added.map(f => `${f.rule} — ${f.message}`).join('; ')}`)
  }

  return { ok: true, ruling: found.id, question: q.question, closed: row?.id ?? null, files: [q.file, ...(row ? [row.file] : [])] }
}

// ─── the row a question answers ────────────────────────────────────────────────

// The open § Needs a decision row the question's lead names, if any.
function heldRow(root, q) {
  const named = new Set((q.question.match(QUESTION_ID) ?? []).map(id => id.toUpperCase()))
  if (!named.size) return null
  return readRegisters(root).issues.find(r => !r.closed && r.severity === 'decision' && named.has(r.id.toUpperCase())) ?? null
}

// The row's move to § Closed, computed now and written by the caller alongside
// its other files, so one register:check grades them together.
function closeRow(root, row, how, today) {
  const abs    = join(root, row.file)
  const before = readFileSync(abs, 'utf8')
  const moved  = moveToClosed(before, row, how, today)
  if (moved.reason) return { reason: moved.reason }
  return { write: () => writeFileSync(abs, moved.text), undo: () => writeFileSync(abs, before) }
}

// ─── the two edits ────────────────────────────────────────────────────────────

// The paper's own convention for an answered question: the bold lead struck and
// the answer, with its id, beside it. The argument under it stays, because it is
// why the question was hard.
function strikeQuestion(src, q, { date, ruling, answer }) {
  const lines = src.split('\n')
  const i     = q.line - 1
  const lead  = `**${q.question}**`
  const at    = lines[i]?.indexOf(lead) ?? -1
  if (at < 0) return null
  lines[i] = lines[i].slice(0, at) +
    `~~${lead}~~ **Answered ${date} (\`${ruling}\`): ${answer}.**` +
    lines[i].slice(at + lead.length)
  return lines.join('\n')
}

function rulingEntry({ q, link, option, ruling, date, reason, followed }) {
  const others = q.options.filter(o => o !== option)
    .map(o => `**${o.letter}** (${trimStop(o.text)})`).join(', ')
  return [
    `### <a id="${ruling.toLowerCase()}"></a>${date} · \`${ruling}\` — ${trimStop(q.question.replace(LEAD_ID, ''))} — ${capitalize(trimStop(option.text))}.`,
    '',
    `Asked in [\`${q.file}\`](${link}) § Open questions. **${option.letter}** was picked over ${others || 'no other option'}.`,
    '',
    `${followed ? `The paper's recommendation, taken as written: ` : ''}${trimStop(reason)}.`,
    '',
  ]
}

// Newest first: a ruling goes directly under its section's heading.
function insertRuling(src, section, entry) {
  const lines = src.split('\n')
  const at    = lines.findIndex(l => l.trim() === `## ${section}`)
  let   i     = at + 1
  while (i < lines.length && lines[i].trim() === '') i++
  lines.splice(i, 0, ...entry)
  return lines.join('\n')
}

// ─── the id ───────────────────────────────────────────────────────────────────
//
// An id is issued once, anywhere a register can hold one — a ruling, an issue
// row, the archive, or a paper that reserved one before it was ruled. So the
// next is one past the highest seen in any of them.

export function nextDecisionNumber(root) {
  const { dir, prefix } = registerLayout(root)
  const files = ['DECISIONS.md', 'ISSUES.md', 'ISSUES_ARCHIVE.md'].map(f => join(dir, f))
  const ideas = join(dir, 'IDEAS')
  const id    = new RegExp(`${prefix}-D(\\d+)`, 'g')
  for (const d of [ideas, join(ideas, 'shipped')]) if (existsSync(d)) for (const n of readdirSync(d)) if (n.endsWith('.md')) files.push(join(d, n))

  let max = 0
  for (const f of files) {
    if (!existsSync(f)) continue
    for (const m of readFileSync(f, 'utf8').matchAll(id)) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function refuse(reason) { return { ok: false, reason } }

// A reason is one paragraph of a ruling. A newline in it would let a caller
// start a heading, and a ruling's body is never structured by the person typing.
function oneParagraph(text) { return String(text ?? '').replace(/\s+/g, ' ').trim() }

function trimStop(text) { return String(text).trim().replace(/[.?!;:,]+$/, '') }

function capitalize(text) { return text.charAt(0).toUpperCase() + text.slice(1) }

// UTC, because this date is WRITTEN INTO a register row and read by everybody
// afterwards: a decision recorded at 23:30 in Auckland and one recorded twenty
// minutes later in Los Angeles would otherwise be dated two days apart, in a
// file whose whole job is to say when something was settled.
function isoDate(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}
