// ─── blast — how far a change to this file reaches ───────────────────────────
//
// One number per tracked code file: how many files NAME it. `fli gs` marks the
// few that are high, so a diff that touches a hub says so before it is
// committed rather than after a drive goes red.
//
// **It computes nothing itself.** `referenceGraph` in `core/codegraph.js` is
// the one answer to *who names this file* — relative paths, a package's own
// `exports` map, and a path suffix inside the same region — and a second
// matcher here would be a second answer that disagrees with the codegraph page
// about the same tree. What this module owns is the narrow collection: the
// texts that reading needs and nothing else.
//
// The cost is the scan, and it cannot be narrowed by target: knowing who names
// `parser.js` means reading everyone. Measured on this workspace at ~390ms over
// 2,075 texts, against ~6s for the full codegraph — the difference is the
// TypeScript function measurement, which this question does not need.
//
// Two filters were tried and both are refused. `git grep -F` per changed file
// is slower (60 spawns, ~1.3s) and is that second matcher. Prefiltering texts
// by the target's BASENAME is unsound: `@frontierjs/toolbelt/inflect` resolves
// through `exports` to `src/inflect/index.js`, and the importing text contains
// `inflect` and never `index.js`, so the filter drops real edges in silence.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Statically, because importing THIS module is already the decision to pay for
// it — `core/codegraph.js` is ~1,150 lines and nothing on fli's read-only path
// imports blast at all. Measured at 6ms.
import { referenceGraph, regionReader, packageIndex, isCode, band, BLAST } from './codegraph.js'
import { kindOf }                                                       from './file-kind.js'

const TEXT_LIMIT = 2_000_000

/**
 * `{ usedBy, code }` for the tree at `root`.
 *
 * `code` is the set the tally COULD have counted. A file absent from `usedBy`
 * is named by nothing; a file absent from `code` was never a candidate, and the
 * two must not render the same — *nothing names this* and *nothing read this*
 * are different sentences.
 *
 * Answers empty on anything it cannot read, rather than throwing: a blast mark
 * is an annotation on a listing, and a listing that refuses to print because a
 * git call failed is worse than one printing no marks.
 */
export function usedByIndex(root) {
  const empty = { usedBy: new Map(), code: new Set() }
  try {
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 1 << 29 })
    const paths = git('ls-files', '-z').split('\0').filter(Boolean).sort()
    if (!paths.length) return empty

    const files     = new Map(paths.map(p => [p, { path: p, kind: kindOf(p) }]))
    const texts     = new Map()
    const manifests = []
    for (const p of paths) {
      const kind = files.get(p).kind
      const manifest = p.endsWith('package.json')
      if (!manifest && kind !== 'source' && kind !== 'test' && kind !== 'private') continue
      try {
        const buf = readFileSync(join(root, p))
        if (buf.length > TEXT_LIMIT || buf.subarray(0, 8000).includes(0)) continue
        const text = buf.toString('utf8')
        // A manifest is read for `packageIndex` and is not itself a reference
        // source — its every dependency string would resolve as an import.
        if (manifest) { try { manifests.push({ path: p, json: JSON.parse(text) }) } catch {} ; continue }
        texts.set(p, text)
      } catch {}
    }

    const isSource = p => isCode(files.get(p))
    const graph = referenceGraph(texts, {
      isSource,
      regionOf: regionReader(paths),
      packages: packageIndex(manifests),
    })

    const usedBy = new Map()
    for (const names of graph.values()) for (const n of names) usedBy.set(n, (usedBy.get(n) ?? 0) + 1)
    return { usedBy, code: new Set(paths.filter(isSource)) }
  } catch {
    return empty
  }
}

/**
 * `path → { usedBy, band } | null` over an index, bound once.
 *
 * ONE accessor rather than a count and a band separately, because the two are
 * read together everywhere and a caller holding only the count would have to
 * band it — which is the thresholds restated somewhere they can drift from
 * codegraph's page.
 *
 * `null` is a file the tally never had a reading for (not tracked, not code),
 * and it must not render as 0: *nothing names this* and *nothing read this*
 * are different sentences, and only one of them is a fact about the file.
 *
 * Bands are codegraph's own `BLAST` — 0 named by nothing · 1 by 1-3 · 2 by
 * 4-15 · 3 by more than 15 — so a file the page draws as a hub is one here.
 */
export const blastReader = ({ usedBy, code }) => (path) =>
  code.has(path) ? { usedBy: usedBy.get(path) ?? 0, band: band(usedBy.get(path) ?? 0, BLAST) } : null
