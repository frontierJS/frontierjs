// api/src/barkeep.ts
// The barkeep's books (`IDEAS/haven.md` 8.4): a search over `docs/`,
// `VOCABULARY.md` and the package READMEs that answers with a passage and its
// path, or with nothing. No model (`FJS-D994`): a public Haven with one behind
// the bar is a bill any stranger can run up, and a question the docs cannot
// answer is counted (`barkeep.ask`, the Miss model) before one is paid to paper
// over it.
//
// A passage is a paragraph, a list item or a table row, under the headings it
// sits in; a fenced block is skipped, since a quote of code read alone in a
// bubble answers nothing. The search is plain: the question's words less the
// stopwords, each weighed by how rare it is across the books, and a passage
// answers only when it holds most of that weight -- a near miss quoted as an
// answer would hide the gap the count is for.
//
// The books are read from a checkout: `HAVEN_BARKEEP_ROOT`, else the repo this
// package sits in. A server with neither has no books, and says so.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface Passage { path: string, heading: string, text: string, first: boolean, terms: Map<string, number>, head: Set<string>, lead: Set<string> }
export interface Books { root: string, passages: Passage[], df: Map<string, number> }
export interface Answer { text: string, path: string, heading: string }

/** How much of a question's weight a passage must hold to be the answer. */
export const COVER = 0.6
/** A passage of fewer words than this is too short to be the answer on its own. */
const WORDY = 10

/** The longest quote, in characters, cut on a sentence where one ends in time. */
export const QUOTE = 420

const STOP = new Set(`a about all an and any are as ask at be barkeep but by can could do does for from get
have how i if in into is it its me my need no not of on or say should so tell than that the their them then there
these they thing this to us use was way we what when where which who why will with work would you your`.split(/\s+/))

/** A word as the search compares it: lower case, a plural's `s` and `ies` and an `ing` folded. */
export function stem (word: string): string {
  const w = word.toLowerCase()
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** The words a text weighs, stopwords out. `@guarded` and `asSystem()` keep their letters. */
export function termsOf (text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_]*(?:-[a-z0-9_]+)*/g) ?? [])
    .filter(w => w.length > 1 && !STOP.has(w))
    .map(stem)
}

// Markdown read as it is said: links as their words, emphasis and code ticks gone.
const plain = (s: string) => s
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/<a [^>]*><\/a>/g, '')
  .replace(/\*\*|__|`/g, '')
  .replace(/\s+/g, ' ')
  .trim()

/** The passages of one markdown file. */
export function passagesOf (path: string, markdown: string): Array<{ path: string, heading: string, text: string, first: boolean }> {
  const out: Array<{ path: string, heading: string, text: string, first: boolean }> = []
  const heads: string[] = []
  let para: string[] = []
  let fenced = false
  let header = ''
  let first = true
  const flush = () => {
    const text = plain(para.join(' '))
    if (text) { out.push({ path, heading: heads.filter(Boolean).join(' › '), text, first }); first = false }
    para = []
  }
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { flush(); fenced = !fenced; continue }
    if (fenced) continue
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      heads.length = h[1].length
      heads[h[1].length - 1] = plain(h[2])
      first = true
      continue
    }
    if (/^\s*\|/.test(line)) {
      flush()
      if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue
      const cells = line.split('|').slice(1, -1).map(c => plain(c)).filter(Boolean)
      // A table's first row is its header, said once beside each row under it.
      if (!header) { header = cells.join(' · '); continue }
      out.push({ path, heading: heads.filter(Boolean).join(' › '), text: cells.join(' — '), first: false })
      continue
    }
    header = ''
    if (!line.trim()) { flush(); continue }
    if (/^\s*([-*+]|\d+\.)\s/.test(line)) flush()
    para.push(line.replace(/^\s*([-*+]|\d+\.)\s+/, ''))
  }
  flush()
  return out
}

/** The files the barkeep reads under a root: `docs/` less its archives, `VOCABULARY.md`, each package's `README.md`. */
export function shelf (root: string): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      // The archives are what changed and when, and would answer today's
      // question with a ruling since overturned.
      if (statSync(p).isDirectory()) { if (!name.endsWith('-archive')) walk(p) }
      else if (name.endsWith('.md')) files.push(p)
    }
  }
  if (existsSync(join(root, 'docs'))) walk(join(root, 'docs'))
  if (existsSync(join(root, 'VOCABULARY.md'))) files.push(join(root, 'VOCABULARY.md'))
  const pkgs = join(root, 'packages')
  if (existsSync(pkgs)) for (const name of readdirSync(pkgs).sort()) {
    const readme = join(pkgs, name, 'README.md')
    if (existsSync(readme)) files.push(readme)
  }
  return files
}

/** Every passage under a root, with how many passages each word is in. */
export function readBooks (root: string): Books {
  const passages: Passage[] = []
  const df = new Map<string, number>()
  for (const file of shelf(root)) {
    for (const p of passagesOf(relative(root, file), readFileSync(file, 'utf8'))) {
      const terms = new Map<string, number>()
      for (const t of termsOf(p.text)) terms.set(t, (terms.get(t) ?? 0) + 1)
      const head = new Set(termsOf(p.heading))
      const lead = new Set(termsOf(p.heading.split(' › ').at(-1) ?? ''))
      for (const t of new Set([...terms.keys(), ...head])) df.set(t, (df.get(t) ?? 0) + 1)
      passages.push({ ...p, terms, head, lead })
    }
  }
  return { root, passages, df }
}

/** The root a server reads its books from, or null when it has none. */
export function booksRoot (env: Record<string, string | undefined> = process.env): string | null {
  const stated = env.HAVEN_BARKEEP_ROOT
  if (stated) return existsSync(stated) ? stated : null
  const repo = new URL('../../../../', import.meta.url).pathname
  return existsSync(join(repo, 'VOCABULARY.md')) ? repo : null
}

/** A quote cut to `QUOTE` characters, on the last sentence that ends inside it where there is one. */
export function quote (text: string, max = QUOTE): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return end > max / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))} …`
}

/** The passage that answers a question, or null when none holds `COVER` of its weight. */
export function answer (books: Books, question: string): Answer | null {
  const asked = [...new Set(termsOf(question))]
  if (!asked.length) return null
  const n = books.passages.length
  const idf = new Map(asked.map(t => [t, Math.log(1 + n / (books.df.get(t) ?? 0.5))]))
  const whole = asked.reduce((s, t) => s + idf.get(t)!, 0)
  let best: Passage | null = null
  let bestScore = 0
  for (const p of books.passages) {
    let held = 0
    let score = 0
    for (const t of asked) {
      const tf = p.terms.get(t) ?? 0
      const inHead = p.head.has(t)
      if (!tf && !inHead) continue
      held += idf.get(t)!
      score += idf.get(t)! * ((tf ? 1 + Math.log(tf) : 0) + (inHead ? 2 : 0))
    }
    if (held / whole < COVER) continue
    // A long passage holds every word by being long, and a short one -- a
    // table's cell of ticks, a line ending on the colon before a block of
    // code -- names the words and says nothing about them.
    score /= Math.sqrt(Math.max(WORDY, p.terms.size) / WORDY)
    score *= Math.min(1, p.terms.size / WORDY)
    if (p.text.endsWith(':')) score /= 2
    // The opening of a section named for the word is where it is defined.
    if (p.first && asked.some(t => p.lead.has(t))) score *= 1.5
    if (score > bestScore) { best = p; bestScore = score }
  }
  return best && { text: quote(best.text), path: best.path, heading: best.heading }
}
