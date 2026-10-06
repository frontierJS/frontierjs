---
title: ws:ask
description: Answer a question about this workspace with a citation, and say what the answer cost
examples:
  - fli ws:ask "who owns $setAuth"
  - fli ws:ask "why may litestone import toolbelt"
  - fli ws:ask --score
args:
  -
    name: question
    description: The question, in plain words
    required: false
    variadic: true
flags:
  score:
    char: s
    type: boolean
    description: Run the graded question set and report tokens-to-fact and the miss rate
    defaultValue: false
  verbose:
    char: v
    type: boolean
    description: With --score, print every question and not only the misses
    defaultValue: false
---

Six intents, each naming one committed artefact: **owner** and **locate** read
`seams.snapshot.md` and the maps, **ruling** reads `DECISIONS.md`, **status**
`ISSUES.md`, **blast** `DRIVES.md`, **recipe** a package's own `CLAUDE.md`. The
intent picks the artefact and the subject picks the row; no model is involved,
so the same question answers the same way twice.

**The number is the point.** `read` is what came back and is what would land in
a context window or a person's head; `scanned` is what had to be opened to find
it. `--score` runs the graded set in `core/questions.js`, whose answers were
written against the tree before this resolver existed. A question it misses is a
finding — a fact with no home, or with two. Do not edit the question.

<script>
import { resolve } from 'path'
</script>

```js
const { ask, scoreQuestions, INTENTS } = await import(resolve(global.fliRoot, 'core/ask.js'))
const { QUESTIONS }                    = await import(resolve(global.fliRoot, 'core/questions.js'))

const root = await $.wsRoot()
if (!root) { log.error('No workspace found from here'); process.exitCode = 1; return }

const tok = (b) => Math.round(b / 4)

if (flag.score) {
  const s = scoreQuestions({ root, questions: QUESTIONS })
  echo('')
  const cited = s.rows.filter(r => r.got === r.cite).length
  echo(`  intent            ${s.intentHits}/${s.total}`)
  echo(`  citation          ${cited}/${s.total}`)
  echo(`  payload           ${s.hits}/${s.total}`)
  echo(`  median tokens-to-fact  ${tok(s.medianRead)}  (${s.medianRead} bytes)`)
  echo(`  scanned to get there   ${Math.round(s.totalScanned / 1024)} KB over ${s.total} question(s)`)
  echo('')
  for (const id of INTENTS) {
    const b = s.byIntent[id]
    if (!b) continue
    echo(`  ${id.padEnd(7)} ${b.hit}/${b.n}   ~${tok(b.read / b.n)} tok/question   scanned ${Math.round(b.scanned / 1024)} KB`)
  }
  echo('')
  for (const r of s.rows) {
    if (r.hit && !flag.verbose) continue
    const mark = r.hit ? '✓' : '✗'
    echo(`  ${mark}  ${(r.intent ?? '?').padEnd(7)} ${r.status.padEnd(10)} ${r.q}`)
    if (r.hit) continue
    // A payload miss cites the right document, so printing want/got alone
    // reads as `want X got X` and looks like a bug in the report.
    if (r.got === r.cite) echo(`      ${r.cite} is right; the payload does not carry "${r.contains}"`)
    else                  echo(`      want ${r.cite}   got ${r.got ?? '—'}`)
  }
  echo('')
  if (s.hits < s.total) echo(`  ${s.total - s.hits} miss(es). Each one is a fact with no home, or with two — not a question to reword.`)
  echo('')
  return
}

const text = String(Array.isArray(arg.question) ? arg.question.join(' ') : (arg.question ?? '')).trim()
if (!text) { log.error('Ask something: fli ws:ask "who owns $setAuth"'); process.exitCode = 1; return }

const a = ask({ root, text })
echo('')
if (!a.intent) {
  echo(`  ?  no intent matched. This answers: ${INTENTS.join(' · ')}`)
  echo('')
  return
}
echo(`  ${a.intent} · ${a.status}`)
echo('')
for (const h of a.hits) echo(`     ${h.line}`)
if (!a.hits.length) echo('     nothing matched')
echo('')
echo(`  read ${a.read} bytes (~${tok(a.read)} tok) · scanned ${Math.round(a.scanned / 1024)} KB`)
echo('')
```
