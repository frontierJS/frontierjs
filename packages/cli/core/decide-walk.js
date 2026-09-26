// ─── decide-walk.js — the owner answering the queue, one key per question ────
//
// `fli decide` with no id. Every question that can be answered now is shown in
// turn — the settled ones first, since confirming a ruling that already exists
// is the cheapest answer there is — and a key answers it. Enter is always the
// recommendation.
//
// It writes nothing itself. A pick goes through `decide()` and a confirmation
// through `settle()`, so a walked answer passes the same refusals and the same
// `register:check` put-back as a typed one, and the walk cannot record a ruling
// the command would have refused.
//
// The terminal and the editor are handed in: `tty` is `context.tty`, `edit(text)`
// opens an editor on `text` and answers the file as saved, `view(q)` shows the
// question where it is argued. A test scripts all three.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { openDecisions, rulingSections } from './decisions.js'
import { decide, settle }                 from './decide.js'

const COMMANDS = { s: 'skip', v: 'view', esc: 'quit' }

/**
 * Walk the queue. Answers `{ ruled, settled, skipped, quit }`, counts of what
 * the person did — refusals are shown as they happen and counted as skipped.
 */
export async function walk({ root, tty, echo, edit, view, today = new Date() }) {
  const start = openDecisions(root)
  const queue = [...start.settled, ...start.decidable].map(q => q.id)
  const tally = { ruled: 0, settled: 0, skipped: 0, quit: false }
  let section = null

  if (!queue.length) {
    echo('\n  Nothing to answer: no question carries options or a settling ruling. `fli decisions --open` lists what needs framing.\n')
    return tally
  }

  for (const [i, id] of queue.entries()) {
    // Re-read per question: an answer moves every line below it in its paper,
    // and another session may have answered this one meanwhile.
    const now = openDecisions(root)
    const q   = now.settled.find(d => d.id === id) ?? now.decidable.find(d => d.id === id)
    if (!q) continue

    show(echo, q, i + 1, queue.length)
    const answer = q.by ? await confirmSettled(q) : await pickOption(q)
    if (answer === 'quit') { tally.quit = true; break }
    if (answer === 'skip') { tally.skipped++; continue }
    tally[answer]++
  }

  echo(`\n  ${tally.ruled} ruled · ${tally.settled} settled · ${tally.skipped} skipped${tally.quit ? ' · stopped early' : ''}\n`)
  return tally

  async function confirmSettled(q) {
    for (;;) {
      const key = await tty.keys('  Settle it?', { y: `yes, by ${q.by}`, ...COMMANDS })
      if (key === 'v') { await view(q); continue }
      if (key !== 'y') return key === 'esc' ? 'quit' : 'skip'
      return report(settle({ root, id: q.id, by: q.by, today }), 'settled')
    }
  }

  async function pickOption(q) {
    const rec     = q.recommend?.letter
    const letters = [...q.options].sort((a, b) => (b.letter === rec) - (a.letter === rec))
    const choices = Object.fromEntries(letters.map(o => [o.letter.toLowerCase(), o.letter === rec ? `${o.letter} (recommended)` : o.letter]))
    for (const [k, label] of Object.entries(COMMANDS)) if (!(k in choices)) choices[k] = label

    for (;;) {
      const key = await tty.keys('  Pick', choices)
      if (key === 'v' && !q.options.some(o => o.letter === 'V')) { await view(q); continue }
      if (key === 'esc') return 'quit'
      if (key === 's' && !q.options.some(o => o.letter === 'S')) return 'skip'

      const pick = key.toUpperCase()
      let why = ''
      if (pick !== rec) {
        why = readWhy(await edit(whyTemplate(q, pick)))
        if (!why) { echo('  No reason saved, so nothing was written — a pick against the recommendation says why.\n'); return 'skip' }
      }
      const where = await chooseSection()
      if (!where) return 'skip'
      return report(decide({ root, id: q.id, pick, why, section: where, today }), 'ruled')
    }
  }

  // The section used last is Enter, since a run through one paper files its
  // rulings together.
  async function chooseSection() {
    const all     = rulingSections(root)
    const ordered = section && all.includes(section) ? [section, ...all.filter(s => s !== section)] : all
    const keys    = '123456789abcdefghijklmnopqrtuwxyz'
    const choices = Object.fromEntries(ordered.map((s, i) => [keys[i], s]))
    echo('  Section:')
    for (const [k, s] of Object.entries(choices)) echo(`    ${k}  ${s}`)
    const key = await tty.keys('  File it under', { ...choices, esc: 'skip' })
    if (key === 'esc') return null
    section = choices[key]
    return section
  }

  function report(out, done) {
    if (!out.ok) { echo(`  ✗ ${out.reason}\n`); return 'skip' }
    const row = out.closed ? ` · closed ${out.closed}, and what waited on it is back in fli next` : ''
    echo(done === 'settled' ? `  ✓ struck — answered by ${out.ruling}${row}\n` : `  ✓ ${out.ruling} — ${out.pick}${row}\n`)
    return done
  }
}

function show(echo, q, n, of) {
  echo('')
  echo(`  [${n}/${of}] ${q.id}   ${q.file}:${q.line}`)
  echo(`  ${q.question}`)
  for (const o of q.options) echo(`    ${q.recommend?.letter === o.letter ? '★' : ' '} ${o.letter} — ${o.text}`)
  if (q.recommend?.why) echo(`      why ${q.recommend.letter}: ${q.recommend.why}`)
  if (q.by) echo(`      settled by ${q.by} — confirming strikes it citing that ruling, and mints no new one`)
  echo('')
}

// Lines starting with `#` are dropped, so the template can say what it is for.
function whyTemplate(q, pick) {
  return [
    '',
    `# Why ${pick} and not ${q.recommend?.letter ?? 'the recommendation'}? One paragraph; it becomes the ruling's reason.`,
    `# ${q.question}`,
    ...q.options.map(o => `#   ${o.letter} — ${o.text}`),
    q.recommend ? `# Recommended ${q.recommend.letter}: ${q.recommend.why}` : '# No recommendation was written.',
    '# Save an empty file to go back without ruling.',
    '',
  ].join('\n')
}

/** What an editor saved, with the template's comment lines gone. */
export function readWhy(text) {
  return String(text).split('\n').filter(l => !l.startsWith('#')).join(' ').replace(/\s+/g, ' ').trim()
}
