// ─── next.js — what to work on next, and why that ─────────────────────────────
//
// The open register ranked. Severity is the first term and cannot be the only
// one: most open rows share a severity, so a list sorted by it alone is a list
// in file order. The other terms are what the registers and the tree already
// say — how many records cite a row, whether a row holds others up, and whether
// its files are ones somebody has been working in — and every term is printed
// beside the row it scored, so a ranking can be argued with rather than obeyed.
//
// ── Blocking is declared, not read out of prose ─────────────────────────────
//
// A row that cannot start until another closes says `blocked by FJS-###` in
// its own text. The prose was searched for dependency language first and every
// match was a *block* of something else, so an edge is written where it holds
// and nowhere else. A blocker that closes stops blocking with no edit, and one
// that names nothing is already `register:check`'s dangling citation.
//
// ── By hand ─────────────────────────────────────────────────────────────────
//
// A row a headless session cannot finish — a run longer than a session lasts,
// a check only the owner can make — says `by hand` as its own segment of the
// links cell, the way `blocked by` is written. It stays ranked, since a person
// reading `fli next` is who it is for, and `fix:loop` passes over it. Prose that
// merely says someone did a thing by hand is not the declaration.
//
// ── What this does not rank ─────────────────────────────────────────────────
//
// Proposals. `IDEAS/overview.md` ranks those by hand, and nothing a reader can
// measure about an unbuilt idea separates the first wave from the fifth.
//
// ── Reach ───────────────────────────────────────────────────────────────────
//
// A defect in a package many others import is met by all of them, and a row
// downstream of it may be its symptom. Reach is the count of workspace packages
// that depend on the row's package, directly or through another, read from the
// manifests. It is a tiebreak and no more: a dependency between two PACKAGES
// says nothing about whether one fix waits on another — `blocked by` says that —
// so its cap stays under one citation, and a cosmetic toolbelt row never jumps
// a cited sierra one.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { execFileSync } from 'node:child_process'

import { readRegisters } from './registers.js'
import { workspaceDeps } from './runnables.js'
import { openDecisions, QUESTION_ID } from './decisions.js'

// One table, and no flag moves it: a weight somebody can pass is a ranking
// that means whatever the last caller wanted.
export const WEIGHTS = Object.freeze({
  severity:  { S1: 100, S2: 60, S3: 30, S4: 10, decision: 30 },
  citedBy:   4,    // per record citing the row, up to CITED_CAP of them
  blocks:    10,   // per open row declaring itself blocked by this one
  touched:   12,   // a file the row links is in the working tree or a recent commit
  reach:     1,    // per REACH_PER packages depending on the row's, up to REACH_CAP
})
const CITED_CAP     = 5
const BLOCKS_CAP    = 3
const REACH_PER     = 3
const REACH_CAP     = 3
const RECENT_COMMITS = 10

// Any prefix: a blocker is only counted when it names an open row, so the
// register's own prefix is what survives the filter in `rankNext`.
const BLOCKED_BY = /\bblocked by\s+`?([A-Z][A-Z0-9]*-D?\d+)`?/gi
const BY_HAND    = /(^|·)\s*`?by hand`?\s*(·|\|?\s*$)/im

/**
 * The open rows, ranked, plus the ones that cannot start and what the owner
 * could decide now.
 *
 * `touched` is the set of repository-relative paths counted as recent; it is
 * read from git when absent, and handed in by a test.
 */
export function rankNext(root, { pkg = null, touched = null } = {}) {
  const doc    = readRegisters(root)
  const open   = doc.issues.filter(r => !r.closed)
  const openId = new Set(open.map(r => r.id))
  const recent = touched ?? recentPaths(root)
  const reachOf = dependentCounts(root)

  // Who cites whom, over every live record — a ruling or a proposal leaning on
  // an open row is weight on that row. A record citing itself is not.
  const citers = new Map()
  const live   = [...open, ...doc.decisions, ...doc.ideas.filter(i => !['superseded-by', 'withdrawn'].includes(i.status))]
  // A `blocked by` reference is scored once, as blocking, not again as a citation.
  for (const r of live) {
    const edges = new Set(blockedBy(r))
    for (const ref of new Set(r.refs)) {
      if (ref === r.id || edges.has(ref) || !openId.has(ref)) continue
      citers.set(ref, (citers.get(ref) ?? 0) + 1)
    }
  }

  const blockers = new Map(open.map(r => [r.id, blockedBy(r).filter(id => openId.has(id))]))
  const blocking = new Map()
  for (const [id, bs] of blockers) for (const b of bs) blocking.set(b, (blocking.get(b) ?? 0) + 1)

  const scored = open.map(r => {
    const terms = []
    const sev   = WEIGHTS.severity[r.severity] ?? 0
    terms.push({ term: 'severity', value: sev, note: r.severity })

    const cited = Math.min(citers.get(r.id) ?? 0, CITED_CAP)
    if (cited) terms.push({ term: 'cited', value: cited * WEIGHTS.citedBy, note: `cited by ${citers.get(r.id)}` })

    const holds = Math.min(blocking.get(r.id) ?? 0, BLOCKS_CAP)
    if (holds) terms.push({ term: 'blocks', value: holds * WEIGHTS.blocks, note: `blocks ${blocking.get(r.id)}` })

    const near = r.files.filter(isCode).filter(f => recent.has(f.replace(/\/$/, '')) || [...recent].some(p => f.endsWith('/') && p.startsWith(f)))
    if (near.length) terms.push({ term: 'touched', value: WEIGHTS.touched, note: `touched recently: ${near[0]}` })

    // A row filed against two packages reaches as far as the wider of them.
    const [wide] = r.pkg.filter(p => reachOf.has(p)).sort((a, b) => reachOf.get(b) - reachOf.get(a))
    const reach  = wide ? Math.min(Math.floor(reachOf.get(wide) / REACH_PER), REACH_CAP) : 0
    if (reach) terms.push({ term: 'reach', value: reach * WEIGHTS.reach, note: `${wide} reaches ${reachOf.get(wide)}` })

    return {
      id:        r.id,
      pkg:       r.pkg,
      severity:  r.severity,
      status:    r.status,
      title:     r.title,
      file:      r.file,
      line:      r.line,
      score:     terms.reduce((n, t) => n + t.value, 0),
      terms,
      blockedBy: blockers.get(r.id),
      byHand:    byHand(r),
      // A row inherited from an older audit is a lead: probe it before acting.
      probeFirst: r.status === 'stale?',
    }
  })

  const inPkg = r => !pkg || r.pkg.includes(pkg)
  // Ties keep file order, which is the register's own order within a severity.
  const ranked = scored.filter(inPkg).sort((a, b) => b.score - a.score)

  const decisions = openDecisions(root)
  // A row whose id leads a bullet with options is answered by `fli decide`;
  // printed as unframed, it sent the owner to frame what was already framed.
  const framed = new Set(decisions.decidable.flatMap(q => q.question.match(QUESTION_ID) ?? []))
  const owed   = ranked.filter(r => r.severity === 'decision')
  return {
    ready:   ranked.filter(r => !r.blockedBy.length && r.severity !== 'decision'),
    blocked: ranked.filter(r => r.blockedBy.length),
    decide:  {
      decidable: decisions.decidable.length,
      // An open ruling row that holds work up is the one worth naming.
      framed:    owed.filter(r => framed.has(r.id)),
      rows:      owed.filter(r => !framed.has(r.id)),
    },
    weights: WEIGHTS,
  }
}

// Markdown and generated snapshots change in every session that writes a
// register, so a row linking one would read as *being worked on* forever.
function isCode(path) {
  return !/\.md$/i.test(path) && !/\.snapshot\./.test(path)
}

export function byHand(record) {
  return BY_HAND.test(String(record.body ?? ''))
}

export function blockedBy(record) {
  return [...String(record.body ?? '').matchAll(BLOCKED_BY)].map(m => m[1].toUpperCase())
}

// ─── reach ────────────────────────────────────────────────────────────────────
//
// Keyed by FOLDER, because that is what a register row's package cell names. A
// row naming no member — `repo`, `example` — reaches nothing.

export function dependentCounts(root) {
  const members = workspaceDeps(root)
  const folderOf = new Map([...members].map(([folder, m]) => [m.name, folder]))
  const up = new Map()
  for (const [folder, m] of members) for (const d of m.deps) {
    const dep = folderOf.get(d)
    up.set(dep, [...(up.get(dep) ?? []), folder])
  }
  const counts = new Map()
  for (const folder of members.keys()) {
    const seen = new Set(), queue = [folder]
    while (queue.length) for (const u of up.get(queue.pop()) ?? []) if (!seen.has(u)) { seen.add(u); queue.push(u) }
    counts.set(folder, seen.size)
  }
  return counts
}

// ─── recent ───────────────────────────────────────────────────────────────────
//
// The working tree and the last few commits. `execFileSync` with a fixed argv:
// nothing a caller supplies reaches git.

function recentPaths(root) {
  const git = argv => {
    try { return execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }) }
    catch { return '' }
  }
  const out = new Set()
  for (const text of [git(['diff', '--name-only', 'HEAD']), git(['log', `-n${RECENT_COMMITS}`, '--name-only', '--pretty=format:'])]) {
    for (const line of text.split('\n')) if (line.trim()) out.add(line.trim())
  }
  return out
}
