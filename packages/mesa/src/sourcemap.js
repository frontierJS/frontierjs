/**
 * sourcemap.js — a source map for a compiled `.mesa` module.
 *
 * ── Why this is an alignment and not an emit ──────────────────────────────
 *
 * The obvious way to build a map is to record a source offset as each piece is
 * written. That cannot work here: `xBuild` produces a string and then four more
 * passes rewrite it — `hoistTemplates` MOVES template declarations to the top
 * of the module — so a line number recorded during emit names a line that no
 * longer holds that code. A map built that way is not merely coarse, it is
 * wrong, and a wrong map is worse than none: the debugger stops on the wrong
 * line with no sign that anything is off. Svelte carries open reports of
 * exactly that (sveltejs/svelte#10635, #16615).
 *
 * So the map is computed against the FINAL text, by finding source lines that
 * survived compilation unchanged. A line that was rewritten — `let a = 1`
 * becoming a signal — simply gets no mapping, and an unmapped line is honest:
 * the debugger falls back to the generated file for it and says so, rather than
 * pointing somewhere plausible and false.
 *
 * What survives is most of what matters at runtime: function bodies, event
 * handlers, imports, and the expressions inside them, which is where a stack
 * frame or a breakpoint actually lands.
 *
 * Three tiers, in increasing order of trust:
 *
 *   1. the line survived compilation unchanged, and is unique both ways
 *   2. the line DECLARED a name, and the name is carried into the generated
 *      binding — `let count = 0` and its `track()` call share no text
 *   3. the compiler carried an exact position through the passes, inside the
 *      emitted code. A template expression can be mapped no other way: its
 *      line is folded away and its text is rewritten, so there is nothing left
 *      to align against. An exact position wins over an inferred one.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 VLQ, as the source-map v3 spec defines it: sign in the low bit. */
export function encodeVLQ(value) {
  let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1
  let out = ''
  do {
    let digit = vlq & 0b11111
    vlq >>>= 5
    if (vlq > 0) digit |= 0b100000
    out += B64[digit]
  } while (vlq > 0)
  return out
}

/**
 * A line is only a mapping candidate if finding it in the output means
 * something. Punctuation and keywords appear everywhere, and a match on one
 * says nothing about where it came from.
 */
function isCandidate(line) {
  const t = line.trim()
  if (t.length < 8) return false
  if (!/[A-Za-z_$]/.test(t)) return false          // punctuation only
  if (/^\/\//.test(t) || /^\/\*/.test(t) || /^\*/.test(t)) return false
  return true
}

/**
 * A line for comparison. The trailing semicolon is dropped because the emitter
 * adds one to statements copied over verbatim, and an import that differs from
 * its source by exactly `;` is the commonest surviving line there is.
 */
function norm(line) {
  return line.trim().replace(/;$/, '')
}

/** Every index at which `needle` occurs in `lines`, as whole normalized lines. */
function occurrences(lines, needle) {
  const out = []
  for (let i = 0; i < lines.length; i++) if (norm(lines[i]) === needle) out.push(i)
  return out
}

/*
 * ── The declaration tier ──────────────────────────────────────────────────
 *
 * Most of a script does NOT survive verbatim: `let count = 0` becomes a
 * `track()` call, `$: q = …` becomes a signal pair, and whole-line matching
 * gives all of them nothing. But a declaration has a NAME, and the name is
 * carried into the generated declaration — so the two can be matched on it
 * without matching their text.
 *
 * This maps a declaration to where the declaration went, which is what a
 * breakpoint on that source line should stop at. It is not a general
 * expression mapping: a line that merely mentions `count` is not a candidate,
 * because ten generated lines mention it and picking one would be a guess.
 */
const DECLARES = [
  /^let\s+([A-Za-z_$][\w$]*)\s*=/,
  /^const\s+([A-Za-z_$][\w$]*)\s*=/,
  /^var\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\$:\s*([A-Za-z_$][\w$]*)\s*=/,
]

function declaredName(line) {
  const t = line.trim()
  for (const re of DECLARES) {
    const m = t.match(re)
    if (m) return m[1]
  }
  return null
}

/** Generated lines that DECLARE the binding this source name became. */
function declarationSites(genLines, name) {
  const forms = [
    new RegExp(`^(?:const|let|var)\\s+\\$\\$sig_${name}\\s*=`),
    new RegExp(`^(?:const|let|var)\\s*\\[\\s*\\$\\$sig_${name}\\s*,`),
    new RegExp(`^(?:const|let|var)\\s+${name}\\s*=`),
  ]
  for (const re of forms) {
    const hits = []
    for (let i = 0; i < genLines.length; i++) if (re.test(genLines[i].trim())) hits.push(i)
    // The first form that matches at all decides, so a name with both a signal
    // and a plain binding is not counted twice.
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return null
  }
  return null
}

/**
 * @param {string} source     — the original `.mesa` text
 * @param {string} generated  — the compiled module, after every pass
 * @param {string} filename   — what to call the source in the map
 * @returns {object|null} a source-map v3 object, or null when nothing aligned
 */
/** Line and column of a character offset in `source`, both 0-based. */
function positionOf(source, offset) {
  const before = source.slice(0, offset)
  const line = before.split('\n').length - 1
  return { line, col: offset - (before.lastIndexOf('\n') + 1) }
}

/**
 * @param {string} source     — the original `.mesa` text
 * @param {string} generated  — the compiled module, after every pass
 * @param {string} filename   — what to call the source in the map
 * @param {Array<{genLine:number, srcOffset:number}>} [marks] — positions the
 *        compiler carried through the passes inside the emitted code. Template
 *        expressions can be mapped no other way: `_renderGroup` folds a run of
 *        binds into one block and `_domTraversal` collapses a run of traversal
 *        declarations, so neither the line nor the text of an expression
 *        survives for anything to align against.
 */
export function buildSourceMap(source, generated, filename, marks = []) {
  if (!source || !generated) return null

  const srcLines = source.split('\n')
  const genLines = generated.split('\n')

  // A source line that appears twice cannot be told apart by its text, and
  // neither can a generated one. Both directions have to be unique or the
  // mapping is a guess.
  const pairs = []
  const record = (g, s, line) => pairs.push({
    genLine: g,
    genCol: genLines[g].length - genLines[g].trimStart().length,
    srcLine: s,
    srcCol: line.length - line.trimStart().length,
  })

  const declaredNames = srcLines.map(declaredName)

  for (let s = 0; s < srcLines.length; s++) {
    const line = srcLines[s]

    // Tier 1 — the line survived unchanged.
    if (isCandidate(line)) {
      const t = norm(line)
      if (occurrences(srcLines, t).length === 1) {
        const hits = occurrences(genLines, t)
        if (hits.length === 1) { record(hits[0], s, line); continue }
      }
    }

    // Tier 2 — the line declared a name, and the name went somewhere.
    const name = declaredNames[s]
    if (!name) continue
    if (declaredNames.filter((n) => n === name).length !== 1) continue
    const g = declarationSites(genLines, name)
    if (g != null) record(g, s, line)
  }
  // Tier 3 — a position the compiler carried through the passes. These are
  // exact rather than inferred, so they win where they collide with a guess.
  for (const m of marks) {
    if (m.genLine < 0 || m.genLine >= genLines.length) continue
    const { line, col } = positionOf(source, m.srcOffset)
    if (line >= srcLines.length) continue
    pairs.push({
      genLine: m.genLine,
      genCol: genLines[m.genLine].length - genLines[m.genLine].trimStart().length,
      srcLine: line,
      srcCol: col,
      exact: true,
    })
  }

  if (!pairs.length) return null

  // One mapping per generated line, in order. A repeated or out-of-order
  // generated line is what produces "negative line, column, source index"
  // in a consumer, which is the failure this whole file is arranged around.
  // An exact position beats an aligned one on the same generated line.
  pairs.sort((a, b) => a.genLine - b.genLine || (b.exact ? 1 : 0) - (a.exact ? 1 : 0))
  const byLine = new Map()
  for (const p of pairs) if (!byLine.has(p.genLine)) byLine.set(p.genLine, p)

  let prevSrcLine = 0
  let prevSrcCol = 0
  const segments = []
  let lastGen = -1
  for (const [genLine, p] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    if (genLine <= lastGen) continue
    while (segments.length < genLine) segments.push('')
    // Generated column is absolute within its line, so it resets each line and
    // is written as-is; the other three are deltas against the previous segment.
    segments.push(
      encodeVLQ(p.genCol) +
      encodeVLQ(0) +
      encodeVLQ(p.srcLine - prevSrcLine) +
      encodeVLQ(p.srcCol - prevSrcCol),
    )
    prevSrcLine = p.srcLine
    prevSrcCol = p.srcCol
    lastGen = genLine
  }

  return {
    version: 3,
    file: filename ? filename.split('/').pop().replace(/\.mesa$/, '.mesa.js') : undefined,
    sources: [filename ?? 'component.mesa'],
    sourcesContent: [source],
    names: [],
    mappings: segments.join(';'),
  }
}
