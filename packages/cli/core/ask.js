// ─── ask.js — a developer's question, resolved against the workspace ─────────
//
// `core/intent.js` is this operation at the other end of the pipe, and the two
// must not be folded: **that one resolves a CUSTOMER's words against an APP's
// own seed, this one resolves a CONTRIBUTOR's words against the WORKSPACE's
// registers.** Different corpus, different verdicts, different reader. What they
// share is the mechanism and this module imports it rather than restating it —
// `terms()` for how a word is compared, and the rule that a tie is `ambiguous`
// rather than the likelier of two.
//
// ── Why six, and why they are not one search ────────────────────────────────
//
// *why is X this way* and *is X broken* both name X and land in different
// registers. A router that treats them as one question returns the ruling that
// CLOSED the defect somebody is still hitting, which is the most confident wrong
// answer this repo can produce. So the intent picks the artefact and the subject
// picks the row, and neither step is a model's.
//
// ── The point is the COST ───────────────────────────────────────────────────
//
// Answering is not the interesting part; a person with ripgrep can answer. What
// has never been measured is what answering COSTS, which is the only number that
// says whether the mental model is carrying its weight — `PHILOSOPHY.md` §III's
// *you should know where something lives before you go looking for it*, made
// falsifiable. So every resolver reports two byte counts:
//
//   read     the SPAN a reader must take in to have the answer. The metric.
//   scanned  what had to be opened to find it. What says whether a small model,
//            or a person, could have taken the same walk unaided.
//
// `read` counts the PAYLOAD and never the pointer, and the difference is not
// academic: counting what came back made `recipe` the cheapest intent in the
// table at six tokens, because it answered with a path to a 39,000-token file.
// A metric that rewards the shallowest possible answer measures nothing, so a
// row carries `payload` — the ruling's body, the issue's row, the paragraph
// that answers — and `line` is only how it prints. Where the row IS the answer,
// as an owner's path is, the two are the same string.
//
// A question that costs a lot is not a retrieval bug. It is a fact with no home,
// or with two — which is what `IDEAS/intent-recognizer.md` § *Read it backwards*
// says about a seed and is just as true of prose.
//
// Zero dependencies beyond `@frontierjs/toolbelt/inflect`, plain ESM, node or bun.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join }                                  from 'node:path'

import { terms }                                 from './intent.js'

const read = p => { try { return readFileSync(p, 'utf8') } catch { return null } }
const bytes = s => Buffer.byteLength(s ?? '', 'utf8')

// ─── classification ──────────────────────────────────────────────────────────
//
// Phrase triggers, most specific first, because the loose ones overlap on
// purpose: `which file owns X` is an owner question and `which file` alone is a
// locate one, so owner has to be asked first or every seam question becomes a
// grep. The order below IS the precedence and nothing else encodes it.

export const INTENTS = ['blast', 'owner', 'ruling', 'status', 'locate', 'recipe']

const TRIGGERS = [
  ['blast',  /\b(what proves|which drive|what drive|how do i prove|what should i run)\b/],
  ['owner',  /\b(who owns|which file owns|where do i add|who is the owner|who declares)\b/],
  ['ruling', /\bwhy\b/],
  ['status', /\b(open issue|known problem|known issue|still open|is .* built|has .* ever|broken)\b/],
  ['locate', /\b(where (is|does|are|do)|which file|which module)\b/],
  ['recipe', /\b(how do i|how does|how can i|how to)\b/],
]

/** The trigger words themselves are not the subject, so they come back out. */
const STRIP = /\b(what proves|which drive|what drive|how do i prove|what should i run|who owns|which file owns|where do i add|who is the owner|who declares|why|is there an?|open issue|known problem|known issue|where is|where does|where are|where do i|which file|which module|how do i|how does|how can i|how to|is there|do i|can i|live|lives|the|a|an|change|changes|prove|proves|cover|covers)\b/g

export function classify(text) {
  const t = String(text ?? '').toLowerCase()
  for (const [intent, re] of TRIGGERS) if (re.test(t)) return { intent, subject: subjectOf(t) }
  return { intent: null, subject: subjectOf(t) }
}

function subjectOf(t) {
  return t.replace(STRIP, ' ').replace(/[?]/g, ' ').replace(/\s+/g, ' ').trim()
}

// ─── how a subject matches a row ─────────────────────────────────────────────
//
// Two passes and the raw one is not a fallback. `$setAuth` and `matchesQuery`
// do not survive word-splitting into anything a prose index would match, and
// they are exactly what an owner question asks about — so a raw lowercased
// token is compared against the row verbatim, and the singularized terms are
// compared against its prose. A row matching on either counts.

/**
 * Filler in a QUESTION, which is not the filler `intent.js` strips.
 *
 * Its `STOP` is small on purpose — that corpus is a customer describing a
 * feature, where `every` and `per` are the noise. Here the corpus is a
 * contributor asking, and what survives the trigger strip is `is`, `there`,
 * `no`, `does`. Each scored like a real word: *why is there no formatter*
 * tied four rulings on `no` alone and never surfaced `FJS-D32`, which is the
 * one whose title contains `formatter`. Two sets because there are two
 * corpora, not because one of them was copied.
 */
const ASK_STOP = new Set([
  'is', 'are', 'was', 'be', 'there', 'no', 'not', 'it', 'its', 'this', 'that',
  'does', 'do', 'did', 'has', 'have', 'with', 'when', 'any', 'some', 'about',
  'from', 'into', 'as', 'at', 'so', 'if', 'or', 'but',
])

function tokens(subject) {
  const raw = subject.split(/[\s,()]+/)
    .filter(w => w.length > 1 && !ASK_STOP.has(w))

  // Adjacent pairs, both spellings. A compound noun is ONE concept and this
  // repo says so in Axiom 2 — *pay run* split into `pay` and `run` matched a
  // drive about money and a drive literally called `bun run verify`, and the
  // drive named `verify:payrun` was not even in the tie.
  const pairs = []
  for (let i = 0; i < raw.length - 1; i++) {
    pairs.push(`${raw[i]} ${raw[i + 1]}`, raw[i] + raw[i + 1])
  }
  return { raw, words: terms(subject).filter(w => !ASK_STOP.has(w)), pairs }
}

/**
 * Whole-word containment, hand-rolled because `\b` cannot open on `$`.
 *
 * Substring matching put `port` inside `transport`, `export` and `important` —
 * thirty-eight times in `CLAUDE.md` alone — and answered *where does the port
 * formula live* with junction's devtools plugin. It is the same defect a `-w`
 * fixed in a ripgrep pass the day before, arriving through a different door.
 */
function hasWord(hay, tok) {
  // A long token may carry a short inflection: `contribute` has to reach
  // `contributed`, which singularizing does not do and which lost the one
  // paragraph in `packages/ui/CLAUDE.md` that answers how to add a control.
  // Gated on LENGTH, so `port` still cannot arrive at `important` this way —
  // three letters of slack on a ten-letter word is an ending, on a four-letter
  // word it is a different word.
  const slack = tok.length >= 6 ? 3 : 0

  let i = 0
  while ((i = hay.indexOf(tok, i)) !== -1) {
    const before = hay[i - 1] ?? ' '
    if (!/[a-z0-9_]/.test(before)) {
      const rest = hay.slice(i + tok.length)
      const tail = (rest.match(/^[a-z]*/) ?? [''])[0]
      if (tail.length <= slack && !/[a-z0-9_]/.test(rest[tail.length] ?? ' ')) return true
    }
    i += tok.length
  }
  return false
}

/**
 * A row's KEY is what it is called; its HAY is what is said about it. The key
 * weighs five times, because `mesa` in jetty's opening sentence is a mention and
 * `mesa` as the package name is the answer — and without the split the question
 * about Mesa's file extension was answered with jetty.
 */
function score(row, { raw, words, pairs = [] }) {
  const key = (row.key ?? '').toLowerCase()
  const hay = (row.hay ?? '').toLowerCase()

  // A key is a NAME, so it is compared the way inflect compares names: `port`
  // has to reach `ports.js` and `check` has to reach `checks.js`, which no
  // amount of substring care will do. Whole-word containment stays for the hay,
  // where the text is prose and a plural is a different word.
  const keyWords = new Set(terms(key.replace(/[/._:-]+/g, ' ')))

  let n = 0
  // A pair outranks either of its halves, because it is the more specific claim.
  for (const p of pairs) {
    // A pair matches a key as a UNIT or not at all. Reading it by its first
    // word scored `pay run` against the key `verify:pay` for full credit and
    // beat `verify:payrun`, which is the answer — a compound matching half of
    // itself is the same wrong turn as a substring match, one level up.
    const joined = p.replace(/\s+/g, '')
    if (keyWords.has(joined) || hasWord(key, joined) || hasWord(key, p)) n += 25
    else if (hasWord(hay, p)) n += 6
  }
  for (const r of raw)   {
    if (keyWords.has(terms(r)[0] ?? r) || hasWord(key, r)) n += 10
    else if (hasWord(hay, r)) n += 2
  }
  for (const w of words) {
    if (keyWords.has(w)) n += 5
    else if (hasWord(hay, w)) n += 1
  }
  return n
}

/**
 * Best row, or an honest refusal.
 *
 * A UNIQUE best resolves. A tie is `ambiguous` and names every row it could
 * not choose between — `intent.js`'s rule, for `intent.js`'s reason: run 1's
 * one wrong verdict read as a clean refusal and nothing said so.
 */
function best(rows, tk) {
  const scored = rows.map(r => ({ ...r, n: score(r, tk) })).filter(r => r.n > 0)
  if (!scored.length) return { status: 'missing', hits: [] }
  scored.sort((a, b) => b.n - a.n)

  // One row per CITATION, best score kept. A thing can be described in two
  // places — a drive has a row in each of DRIVES.md's tables — and two rows
  // pointing at one answer tied with each other, which read as *I cannot
  // choose* about a question that has exactly one answer.
  const byCite = new Map()
  for (const r of scored) if (!byCite.has(r.cite)) byCite.set(r.cite, r)
  const uniq = [...byCite.values()]

  const top = uniq.filter(r => r.n === uniq[0].n)
  return top.length === 1
    ? { status: 'resolved', hits: [uniq[0]] }
    : { status: 'ambiguous', hits: top.slice(0, 5) }
}

// ─── the six walks ───────────────────────────────────────────────────────────

const SEAMS    = 'seams.snapshot.md'
const DECISION = 'DECISIONS.md'
const ISSUES   = 'ISSUES.md'
const DRIVES   = 'DRIVES.md'

function rowsOf(text, re, make) {
  const out = []
  for (const m of text.matchAll(re)) { const r = make(m); if (r) out.push(r) }
  return out
}

/** The seams snapshot's own table: names, owner, declared-in, other sites. */
function seamRows(root) {
  const text = read(join(root, SEAMS))
  if (text === null) return { rows: [], scanned: 0 }
  const rows = rowsOf(text, /^\| ((?:`[^`]+`(?: \/ `[^`]+`)*)) \| ([^|]+) \| ([^|]*) \| ([^|]*) \|$/gm,
    m => m[2].includes('none') ? null : {
      key: m[1], hay: m[1], cite: (m[2].match(/`([^`]+)`/) ?? [])[1] ?? null,
      line: m[0].trim(), payload: m[0].trim(),
    })
  return { rows: rows.filter(r => r.cite), scanned: bytes(text) }
}

/** Every committed map that names a source path beside a sentence about it. */
function mapRows(root) {
  const rows = []
  let scanned = 0
  for (const f of mapFiles(root)) {
    const text = read(join(root, f))
    if (text === null) continue
    scanned += bytes(text)
    for (const line of text.split('\n')) {
      const p = line.match(/`((?:packages|scripts)\/[a-zA-Z0-9/._-]+\.[cm]?[jt]s)`/)
      if (p) rows.push({ key: p[1], hay: line, cite: p[1], line: line.trim().slice(0, 200), payload: line.trim() })
    }
  }
  return { rows, scanned }
}

const WALKS = {
  owner: (root, tk) => {
    const { rows, scanned } = seamRows(root)
    return { ...best(rows, tk), scanned }
  },

  // ONE candidate set, not seams-then-maps.
  //
  // Trying seams first and returning on any match is a precedence nobody
  // declared, and it answered *where does the port formula live* with junction's
  // devtools plugin — `devtools({ port, auth })` is a seam, so the walk stopped
  // on a two-point mention and never opened a map. `check` did the same through
  // `db.$checkWhere`. Scoring both pools together lets the strongest row win on
  // its merits, which is the only tie-break that does not encode a guess.
  locate: (root, tk) => {
    const a = seamRows(root)
    const b = mapRows(root)
    return { ...best([...a.rows, ...b.rows], tk), scanned: a.scanned + b.scanned }
  },

  // The answer to *why* is the RULING, not its title. Citing the heading line
  // scored 46 tokens for something a reader still had to go and open.
  ruling: (root, tk) => {
    const text = read(join(root, DECISION))
    if (text === null) return { status: 'missing', hits: [], scanned: 0 }
    const heads = [...text.matchAll(/^#+ <a id="(fjs-d\d+)"><\/a>([^\n]+)$/gm)]
    const rows  = heads.map((m, i) => ({
      hay:     m[2],
      cite:    m[1].toUpperCase(),
      line:    m[0].slice(0, 200),
      payload: text.slice(m.index, heads[i + 1]?.index ?? text.length).trim(),
    }))
    return { ...best(rows, tk), scanned: bytes(text) }
  },

  status: (root, tk) => {
    const text = read(join(root, ISSUES))
    if (text === null) return { status: 'missing', hits: [], scanned: 0 }
    const rows = rowsOf(text, /^\| <a id="fjs-\d+"><\/a>(FJS-\d+) \| ([^|]*) \| ([^|]{0,400})/gm,
      m => ({ hay: `${m[2]} ${m[3]}`, cite: m[1],
              line: `${m[1]} — ${m[3].trim().slice(0, 160)}`, payload: m[0] }))
    return { ...best(rows, tk), scanned: bytes(text) }
  },

  // BOTH of DRIVES.md's tables, and the second one is the one being asked.
  //
  // The drives table says what a drive covers; the mapping table says what a
  // CHANGE needs, in the words somebody would use for it. *what proves a change
  // to a pay run* found neither `verify:payrun` nor `verify:batch` off the first
  // table, because neither Covers cell contains the phrase *pay run* — it is in
  // the mapping row, which is the half written for this exact question.
  blast: (root, tk) => {
    const text = read(join(root, DRIVES))
    if (text === null) return { status: 'missing', hits: [], scanned: 0 }

    const covers = rowsOf(text, /^\| `([^`]+)`: `([^`]+)` \|([^|]*)\|([^|]{0,300})/gm,
      m => ({ key: m[2], hay: m[4], cite: `${m[1]}:${m[2]}`,
              line: `${m[1]}: ${m[2]} — ${m[4].trim().slice(0, 140)}`, payload: `${m[1]}: ${m[2]}` }))

    const needs = rowsOf(text, /^\| ([^|`][^|]{0,240}) \| `([^`]+)`: `([^`]+)`/gm,
      m => ({ key: m[3], hay: m[1], cite: `${m[2]}:${m[3]}`,
              line: `${m[2]}: ${m[3]} — ${m[1].trim().slice(0, 140)}`, payload: `${m[2]}: ${m[3]}` }))

    return { ...best([...covers, ...needs], tk), scanned: bytes(text) }
  },

  // A recipe is a package's own CLAUDE.md, and which package is the whole
  // question. The candidate list is the directory listing, so a new package
  // needs no edit here.
  // A package's own map, down to the PARAGRAPH.
  //
  // The citation stays the document — a line number in an answer key breaks the
  // next time somebody edits above it — but what comes back is the block that
  // answers. `##` was too coarse to be that block: caravan has three headings
  // and *What bites here* is most of the file. The house writes a claim in bold
  // and then what it cost, so the paragraph is the unit the prose already has.
  recipe: (root, tk) => {
    let scanned = 0
    const rows = []
    for (const name of packages(root)) {
      const f    = `packages/${name}/CLAUDE.md`
      const text = read(join(root, f))
      if (text === null) continue
      scanned += bytes(text)
      for (const b of docBlocks(text)) {
        if (b.text.length < 40) continue
        rows.push({
          key: `${name} ${b.heading}`, hay: b.text, cite: f,
          line: b.text.replace(/\s+/g, ' ').slice(0, 180), payload: b.text,
        })
      }
    }
    return { ...best(rows, tk), scanned }
  },
}

/**
 * A document as the spans somebody would actually read.
 *
 * A whole SECTION where one is small enough to be the answer — litestone's
 * *Computed fields* is 841 bytes and includes the example, which is the answer
 * — and its paragraphs where it is not, because caravan has three headings and
 * *What bites here* is most of the file.
 *
 * **Fence-aware in both passes.** A blank line inside a code block is not a
 * paragraph break: splitting on it cut `computed.js` in half and answered *how
 * do I make a computed field* with the one-line blurb above the example.
 */
export function docBlocks(text, maxWhole = 2500) {
  const sections = []
  let fence = false
  let cur = { heading: '', lines: [] }

  for (const l of text.split('\n')) {
    if (/^\s*```/.test(l)) fence = !fence
    const h = fence ? null : l.match(/^#+ (.+)$/)
    if (h) { if (cur.lines.length) sections.push(cur); cur = { heading: h[1], lines: [l] } }
    else cur.lines.push(l)
  }
  if (cur.lines.length) sections.push(cur)

  const out = []
  for (const s of sections) {
    const body = s.lines.join('\n').trim()
    if (!body) continue
    if (body.length <= maxWhole) { out.push({ heading: s.heading, text: body }); continue }

    // A blank line is not the only break, and in these documents it is barely a
    // break at all: `packages/ui/CLAUDE.md` § What bites here is 34 KB with TWO
    // blank lines in it, so splitting on them returned the whole section as one
    // block. The unit this house actually writes in is the top-level bullet —
    // *bold the claim, then say what it cost* — one fact each.
    let f = false
    let buf = []
    const flush = () => { const t = buf.join('\n').trim(); if (t) out.push({ heading: s.heading, text: t }); buf = [] }
    for (const l of s.lines) {
      if (/^\s*```/.test(l)) f = !f
      if (!f && l.trim() === '')   { flush(); continue }
      if (!f && /^[-*+] /.test(l)) { flush(); buf.push(l); continue }
      buf.push(l)
    }
    flush()
  }
  return out
}

function packages(root) {
  try {
    return readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name).sort()
  } catch { return [] }
}

/**
 * Committed maps that name a path beside a sentence about it. `docs/` holds the
 * reference the root `CLAUDE.md` points at — CI, testing, ports — so an engine
 * named only there is still found.
 */
function mapFiles(root) {
  const out = ['CLAUDE.md', 'DRIVES.md']
  for (const name of ['CI.md', 'TESTING.md', 'PORTS.md'])
    if (existsSync(join(root, 'docs', name))) out.push(`docs/${name}`)
  for (const name of packages(root)) {
    const f = `packages/${name}/CLAUDE.md`
    if (existsSync(join(root, f))) out.push(f)
  }
  return out
}

// ─── ask ─────────────────────────────────────────────────────────────────────

export function ask({ root, text }) {
  const { intent, subject } = classify(text)
  if (!intent) return { text, intent: null, subject, status: 'unclassified', hits: [], read: 0, scanned: 0 }

  const out  = WALKS[intent](root, tokens(subject))
  const read = out.hits.reduce((n, h) => n + bytes(h.payload ?? h.line ?? ''), 0)
  return { text, intent, subject, status: out.status, hits: out.hits, read, scanned: out.scanned ?? 0 }
}

// ─── the score ───────────────────────────────────────────────────────────────
//
// A hit is the TOP row being the cited one. An `ambiguous` is a miss even when
// the right row is among the ones it could not choose between: *I found five
// things* is not an answer somebody can act on, and counting it as one is how
// the number stops meaning anything.

export function scoreQuestions({ root, questions }) {
  const rows = questions.map(q => {
    const a = ask({ root, text: q.q })
    return {
      ...q, ...a,
      got:  a.hits[0]?.cite ?? null,
      // A citation pins the document; for a recipe it does not pin the ANSWER,
      // and the router was 4/4 on the file while handing back a component
      // listing for *how do I contribute a control*. `contains` is a phrase
      // read out of the tree that the payload must carry. It can only ever make
      // the score worse, which is the direction an assertion may be added in.
      held: q.contains ? (a.hits[0]?.payload ?? '').includes(q.contains) : true,
      hit:  a.status === 'resolved' && a.hits[0]?.cite === q.cite
            && (!q.contains || (a.hits[0]?.payload ?? '').includes(q.contains)),
      intentHit: a.intent === q.intent,
    }
  })

  const hits   = rows.filter(r => r.hit)
  const reads  = hits.map(r => r.read).sort((a, b) => a - b)
  const median = reads.length ? reads[Math.floor(reads.length / 2)] : null

  const byIntent = {}
  for (const r of rows) {
    const b = byIntent[r.intent ?? 'unclassified'] ??= { n: 0, hit: 0, read: 0, scanned: 0 }
    b.n++; b.read += r.read; b.scanned += r.scanned; if (r.hit) b.hit++
  }

  return {
    rows,
    total:       rows.length,
    hits:        hits.length,
    intentHits:  rows.filter(r => r.intentHit).length,
    medianRead:  median,
    totalRead:   rows.reduce((n, r) => n + r.read, 0),
    totalScanned: rows.reduce((n, r) => n + r.scanned, 0),
    byIntent,
  }
}
