/*
 * portability.js — the counting behind `bun run corpus -- --portability
 * <target>` (`IDEAS/mesa-ir.md` § 6 step 2): which files lower, and what to
 * lower next. Pure: `corpus.mjs` compiles and prints, this decides, and
 * `test/portability.test.js` pins the decisions over a fixed set of files —
 * a tally read only by eye once counted every unlocked file twice.
 *
 * A file is `{ file, offenses: [{ what, shape, loc }], calls: [{ name, loc,
 * imported, file }] }`: what the target refuses in its own template, and each
 * component tag it calls with the corpus file its import resolves to.
 *
 * A file lowers when every shape it is refused for is lowered AND every
 * component it calls lowers. A call that resolves to no corpus file is an
 * offender of its own, since nothing can say whether that child lowers.
 */

import { dirname, join, normalize } from 'node:path'
import { eachNode } from '../src/ir.js'

const IMPORT = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+\.mesa)['"]/g

/**
 * Where a `.mesa` specifier imported by `from` lands, as a root-relative
 * path, or null. A workspace package's components are its own files (each
 * package's exports map `./components/*` to itself), and `@/` is the app's
 * `src/`, the alias Sierra sets.
 */
export function resolveMesa(from, spec, packages) {
  if (spec.startsWith('.')) return normalize(join(dirname(from), spec))
  const pkg = spec.match(/^@frontierjs\/([^/]+)\/(.+)$/)
  if (pkg && packages.has(pkg[1])) return `packages/${pkg[1]}/${pkg[2]}`
  if (spec.startsWith('@/')) {
    const at = from.lastIndexOf('/src/')
    return at < 0 ? null : `${from.slice(0, at)}/src/${spec.slice(2)}`
  }
  return null
}

/** Every component tag in `ir`, with the file its default import resolves to. */
export function callsOf(file, source, ir, packages) {
  const imports = new Map()
  for (const [, name, spec] of source.matchAll(IMPORT)) imports.set(name, resolveMesa(file, spec, packages))
  const calls = []
  eachNode(ir.children, (n) => {
    if (n.kind !== 'component') return
    calls.push({ name: n.name, loc: n.loc, imported: imports.has(n.name), file: imports.get(n.name) ?? null })
  })
  return calls
}

/**
 * `files` with each call the report cannot follow moved out of `calls` and
 * into the caller's offenses — an edge to nothing would hold the caller even
 * once its shape is lowered.
 */
export function follow(files) {
  const known = new Set(files.map((f) => f.file))
  return files.map((f) => {
    const lost = f.calls.filter((c) => !(c.file && known.has(c.file)))
    if (!lost.length) return f
    return {
      ...f,
      calls: f.calls.filter((c) => !lost.includes(c)),
      offenses: [...f.offenses, ...lost.map((c) => ({
        what:  `<${c.name}>`,
        shape: c.imported ? 'component outside the corpus' : 'component with no import',
        loc:   c.loc,
      }))],
    }
  })
}

/**
 * The files that lower once every shape in `done` does. The GREATEST
 * fixpoint — start from every file whose own template passes and drop any
 * that calls a dropped one — so a component that calls itself, or two that
 * call each other, lower when nothing else stops them.
 */
export function lowering(files, done = new Set()) {
  const byFile = new Map(files.map((f) => [f.file, f]))
  const ok = new Set(files.filter((f) => f.offenses.every((o) => done.has(o.shape))).map((f) => f.file))
  for (let changed = true; changed;) {
    changed = false
    for (const file of ok) {
      if (byFile.get(file).calls.every((c) => ok.has(c.file))) continue
      ok.delete(file)
      changed = true
    }
  }
  return ok
}

/**
 * Per shape: the files it appears in, its uses, and how many more files
 * would lower if it alone lowered next. Then the greedy order — whichever
 * shape unlocks the most given those already lowered, ties to the shape in
 * the most files — as `{ shape, gain, lower }`, `lower` the running total.
 */
export function plan(files, steps = 12) {
  const shapes = new Map()
  for (const f of files) {
    for (const o of f.offenses) {
      const s = shapes.get(o.shape) ?? { shape: o.shape, uses: 0, files: new Set() }
      s.uses++
      s.files.add(f.file)
      shapes.set(o.shape, s)
    }
  }
  const base = lowering(files).size
  const rows = [...shapes.values()]
    .map((s) => ({ shape: s.shape, files: s.files.size, uses: s.uses, unlocks: lowering(files, new Set([s.shape])).size - base }))
    .sort((x, y) => y.files - x.files || y.unlocks - x.unlocks || (x.shape < y.shape ? -1 : 1))

  const done = new Set()
  const order = []
  let lower = base
  while (order.length < steps && done.size < rows.length) {
    let best = null
    for (const r of rows) {
      if (done.has(r.shape)) continue
      const gain = lowering(files, new Set([...done, r.shape])).size - lower
      if (!best || gain > best.gain || (gain === best.gain && r.files > best.files)) best = { shape: r.shape, files: r.files, gain }
    }
    done.add(best.shape)
    lower += best.gain
    order.push({ shape: best.shape, gain: best.gain, lower })
  }
  return { rows, order }
}
