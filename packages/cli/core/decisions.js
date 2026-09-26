// ─── decisions.js — what is waiting on the owner ─────────────────────────────
//
// An undecided question lives in one of two places. `ISSUES.md` § Needs a
// decision holds the ones with an id; an IDEAS paper's `## Open questions`
// holds the ones argued inside a proposal, which is where nearly all of them
// are. This reads both and says, per question, whether it is RULED, DECIDABLE
// or OPEN. Nothing is copied into a third list: a question stays in its paper,
// and answering it strikes it there.
//
// ── Decidable is a shape, not a judgement ───────────────────────────────────
//
// A question is decidable when its bullet carries lettered options and a
// recommendation:
//
//     - **Omit `@encrypted` columns from a scoped view, or expose them?** prose
//       - **A** — omit them, and report the omission
//       - **B** — expose the ciphertext
//       - **Recommend A** — a view that leaks nothing is the default a caller expects
//
// Without options it is OPEN: somebody has to do the work of finding the
// choices before the owner can make one, and that is a different queue from
// *pick one*. Ruled is the paper's existing convention, a struck bold lead
// followed by `**Answered …**`.
//
// ── Where the id comes from ─────────────────────────────────────────────────
//
// An issue row has one. A paper's bullet does not, so its id is the paper's id
// and a slug of the question — stable while the question's wording is, which
// is the same promise a heading anchor makes.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative }                        from 'node:path'

import { readRegisters, registerLayout } from './registers.js'

// A paper arguing its own questions under a numbered or qualified heading is
// still arguing them — `## 9. Open questions`, `## The open question worth
// settling early`.
export const QUESTIONS_HEADING = /^##\s+(?:\d+\.\s+)?(?:the\s+)?open questions?\b/i

// A paper whose argument was replaced or declined has no live questions.
const MOOT_STATUS = new Set(['superseded-by', 'withdrawn'])

const TOP_BULLET = /^(?:[-*]|\d+\.)\s+(.*)$/
const OPTION     = /^\s+[-*]\s+\*\*([A-Z])\*\*\s*[—–:-]\s*(.+)$/
const RECOMMEND  = /^\s+[-*]\s+\*\*Recommend(?:ed)?:?\s*([A-Z])\*\*\s*(?:[—–:-]\s*)?(.*)$/

// ─── the read ─────────────────────────────────────────────────────────────────

/**
 * Every question the registers hold, ruled ones included, in file order.
 *
 * Each is `{ id, source, file, line, question, state, options, recommend,
 * paper }` where `state` is `ruled` · `decidable` · `open`, `options` is
 * `[{ letter, text }]` and `recommend` is `{ letter, why }` or null.
 */
export function readDecisions(root) {
  return [...ideaQuestions(root), ...issueQuestions(root)]
}

/** The ones a person can answer now, and the ones waiting on work first. */
export function openDecisions(root) {
  const all = readDecisions(root)
  return {
    decidable: all.filter(q => q.state === 'decidable'),
    open:      all.filter(q => q.state === 'open'),
    ruled:     all.filter(q => q.state === 'ruled').length,
  }
}

/**
 * The `##` sections of `DECISIONS.md` a ruling may be filed under — every one
 * but the section that points back at the queue.
 */
export function rulingSections(root) {
  const file = join(registerLayout(root).dir, 'DECISIONS.md')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n')
    .map(l => l.match(/^##\s+(.+?)\s*$/)?.[1])
    .filter(s => s && !/^Open\b/i.test(s))
}

// ─── IDEAS ────────────────────────────────────────────────────────────────────

function ideaQuestions(root) {
  const dir = join(registerLayout(root).dir, 'IDEAS')
  if (!existsSync(dir)) return []

  const out = []
  for (const name of readdirSync(dir).filter(n => n.endsWith('.md')).sort()) {
    const rel   = relative(root, join(dir, name))
    const lines = readFileSync(join(dir, name), 'utf8').split('\n')
    const meta  = frontmatter(lines)
    if (MOOT_STATUS.has(meta.status)) continue

    const paper = { id: meta.id || name.replace(/\.md$/, ''), status: meta.status || '', file: rel }
    const seen  = new Map()
    let inside  = false
    let fence   = false
    let current = null

    const close = () => {
      if (!current) return
      out.push(finish(current))
      current = null
    }

    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) { fence = !fence; return }
      if (fence) return

      if (/^##\s/.test(line)) { close(); inside = QUESTIONS_HEADING.test(line); return }
      if (!inside) return

      const top = line.match(TOP_BULLET)
      if (top && !/^\s/.test(line)) {
        close()
        const lead = questionLead(top[1])
        const base = `${paper.id}:${slug(lead.question)}`
        const n    = (seen.get(base) ?? 0) + 1
        seen.set(base, n)
        current = {
          id:        n === 1 ? base : `${base}-${n}`,
          source:    'idea',
          file:      rel,
          line:      i + 1,
          question:  lead.question,
          struck:    lead.struck,
          text:      [top[1]],
          options:   [],
          recommend: null,
          paper,
        }
        return
      }
      if (!current) return

      const rec = line.match(RECOMMEND)
      if (rec) { current.recommend = { letter: rec[1], why: rec[2].trim() }; current.last = current.recommend; return }

      const opt = line.match(OPTION)
      if (opt) { const o = { letter: opt[1], text: opt[2].trim() }; current.options.push(o); current.last = o; return }

      // A wrapped line belongs to whatever it is indented under: the last option
      // or recommendation when there is one, the question's own prose otherwise.
      if (/^\s+\S/.test(line)) {
        if (current.last?.text !== undefined)     current.last.text += ' ' + line.trim()
        else if (current.last?.why !== undefined) current.last.why  += ' ' + line.trim()
        else current.text.push(line.trim())
      }
    })
    close()
  }
  return out
}

function finish(q) {
  const body  = q.text.join(' ')
  const ruled = q.struck || /\*\*Answered\b/.test(body)
  const state = ruled ? 'ruled' : q.options.length >= 2 ? 'decidable' : 'open'
  const { text, last, struck, ...rest } = q
  return { ...rest, state }
}

// `**Question?** prose` → the bold lead. A bullet with no bold lead is still a
// question; its first sentence stands in, so a paper written in plainer prose is
// queued rather than dropped.
function questionLead(text) {
  const struck = text.match(/^~~\*\*(.+?)\*\*~~/)
  if (struck) return { question: struck[1].trim(), struck: true }
  const bold = text.match(/^\*\*(.+?)\*\*/)
  if (bold) return { question: bold[1].trim(), struck: false }
  return { question: text.split(/(?<=[.?])\s/)[0].trim(), struck: false }
}

// ─── ISSUES ───────────────────────────────────────────────────────────────────
//
// A row's question cell is a paragraph and has nowhere to hold options, so a
// row is always OPEN here. Its options belong in the paper its Detail links,
// where they become a bullet this reader can offer.

function issueQuestions(root) {
  return readRegisters(root).issues
    .filter(r => !r.closed && r.severity === 'decision')
    .map(r => ({
      id:        r.id,
      source:    'issue',
      file:      r.file,
      line:      r.line,
      question:  firstSentence(r.title ?? ''),
      state:     'open',
      options:   [],
      recommend: null,
      paper:     null,
    }))
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function frontmatter(lines) {
  if (lines[0] !== '---') return {}
  const meta = {}
  for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
    const m = lines[i].match(/^([a-z-]+):\s*(.*)$/i)
    if (m) meta[m[1]] = m[2].trim()
  }
  return meta
}

export function slug(text) {
  return text.toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
}

function firstSentence(text) {
  const s = String(text).replace(/\s+/g, ' ').trim()
  const m = s.match(/^(.{20,240}?[.?])(\s|$)/)
  return m ? m[1] : s.slice(0, 240)
}
