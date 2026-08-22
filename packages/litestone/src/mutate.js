// src/mutate.js — schema mutation testing.
//
// Mutate the SCHEMA, not the code: drop a `@@gate`, grade one down, remove a
// `@guarded`, widen a `@length`, delete an `@@allow` — then run the suite that
// was derived from the ORIGINAL schema against a database built from the mutant.
// A mutant nothing notices is a hole, and it names itself.
//
// ── Why the schema and not the code ──────────────────────────────────────────
//
// Code mutation is combinatorial and most mutants are uninteresting. A `.lite`
// file is small and declarative, so the mutation space is ENUMERABLE: one mutant
// per attribute occurrence, low hundreds for a 37-model app, each a fast run
// against a file-copied database.
//
// ── The direction that makes it mean anything ────────────────────────────────
//
// Expectations come from the ORIGINAL schema; the database comes from the
// MUTANT. Deriving both from the mutant is the oracle problem in its purest
// form — drop a `@@gate` and the ladder loses the rows that would have caught
// it, so every mutant survives and the score reads 100%.
//
// ── What a survivor means ────────────────────────────────────────────────────
//
// Not "the schema is wrong". It means *nothing in the derived suite can see this
// change*, which is a fact about the suite — and every survivor this has
// reported so far named a check that did not exist yet and now does.

import { parse } from './core/parser.js'

// ─── the mutation catalogue ───────────────────────────────────────────────────
//
// Each entry finds its occurrences on one line and returns the replacement line.
// Line-oriented because `.lite` is: a `@@` attribute owns its line, and a field's
// attributes sit on the field's own line. The parser carries no positions, so
// there is nothing more precise to work from — every mutant is parsed before it
// is used, and one that does not parse is a kill the parser made.

const GATE_RE = /@@gate\(\s*"([^"]+)"\s*\)/

const MUTATIONS = [
  {
    kind: 'gate-drop',
    describe: () => 'the model declares no @@gate at all',
    // The TOKEN, not the line. A `.lite` model may be written on one line, and
    // removing that line removes the model — every mutant then becomes "this
    // model does not exist", which the checks notice for the wrong reason.
    apply: (line) => _dropToken(line, '@@gate'),
  },
  {
    kind: 'gate-lower',
    describe: (m) => `@@gate ${m.op} lowered ${m.from} → ${m.to}`,
    apply(line) {
      const hit = line.match(GATE_RE)
      if (!hit) return []
      // A one-position gate ("4") applies to all four operations; expand so a
      // mutant can lower ONE of them, which is the interesting case — a gate
      // that is right for read and wrong for delete is the shape that ships.
      const parts = hit[1].split('.')
      const four  = parts.length === 4 ? parts : [parts[0], parts[0], parts[0], parts[0]]
      const ops   = ['read', 'create', 'update', 'delete']
      const out   = []
      for (let i = 0; i < 4; i++) {
        const from = Number(four[i])
        if (!Number.isInteger(from) || from <= 0) continue
        const to   = from - 1
        const next = [...four]; next[i] = String(to)
        out.push({
          line: line.replace(GATE_RE, `@@gate("${next.join('.')}")`),
          meta: { op: ops[i], from, to },
        })
      }
      return out
    },
  },
  {
    kind: 'allow-drop',
    describe: () => 'an @@allow row policy removed',
    apply: (line) => _dropToken(line, '@@allow'),
  },
  {
    kind: 'deny-drop',
    describe: () => 'an @@deny row policy removed',
    apply: (line) => _dropToken(line, '@@deny'),
  },
  {
    kind: 'guarded-drop',
    describe: () => 'a @guarded field opened to every reader',
    apply: (line) => _dropToken(line, '@guarded'),
  },
  {
    kind: 'encrypted-drop',
    describe: () => 'an @encrypted field stored in plaintext',
    apply: (line) => _dropToken(line, '@encrypted'),
  },
  {
    kind: 'unique-drop',
    describe: () => 'a @unique column allowed to repeat',
    // Not `@@unique`, which is a line of its own and a different mutant.
    apply: (line) => _dropToken(line, '@unique'),
  },
  {
    kind: 'validator-drop',
    describe: (m) => `@${m.rule} removed`,
    apply(line) {
      const out = []
      // Both the bare and the parenthesised form exist for most of these
      // (`@email` and `@email("Use your work address")`), and _dropToken takes
      // the argument list when there is one.
      for (const rule of ['email', 'url', 'phone', 'date', 'datetime', 'time',
                          'slug', 'regex', 'startsWith', 'endsWith']) {
        for (const m of _dropToken(line, `@${rule}`)) out.push({ ...m, meta: { rule } })
      }
      return out
    },
  },
  {
    kind: 'validator-widen',
    describe: (m) => `@${m.rule} widened to accept anything`,
    apply(line) {
      const widen = [
        [/@length\(\s*\d+\s*,\s*\d+/, '@length(0, 1000000', 'length'],
        [/@gte\(\s*-?\d+(\.\d+)?/,     '@gte(-1000000',       'gte'],
        [/@gt\(\s*-?\d+(\.\d+)?/,      '@gt(-1000000',        'gt'],
        [/@lte\(\s*-?\d+(\.\d+)?/,     '@lte(1000000',        'lte'],
        [/@lt\(\s*-?\d+(\.\d+)?/,      '@lt(1000000',         'lt'],
        [/@minItems\(\s*\d+/,          '@minItems(0',         'minItems'],
        [/@maxItems\(\s*\d+/,          '@maxItems(100000',    'maxItems'],
      ]
      const out = []
      for (const [re, to, rule] of widen) {
        if (!re.test(line)) continue
        const next = line.replace(re, to)
        if (next !== line) out.push({ line: next, meta: { rule } })
      }
      return out
    },
  },
]

// Where a line's code stops and its comment starts, or -1. Quote-aware, because
// `@default("http://x")` is not a comment and truncating there would produce a
// mutant that fails to parse — which counts as a kill, so the noise would look
// like coverage.
//
// This exists because the first run against `example` reported four surviving
// `guarded-drop` mutants on a model with no `@guarded` field: the matches were
// inside a doc comment explaining what `@guarded` is not. Editing prose produces
// a mutant identical in behaviour to the original, which survives everything, so
// every documented attribute name was quietly costing a point.
function _commentAt(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === quote && line[i - 1] !== '\\') quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '/' && line[i + 1] === '/') return i
  }
  return -1
}

// Every occurrence of `@name` or `@@name` on the line, with its argument list if
// it has one — one mutant each, because a field carrying two of the same rule is
// two separate holes.
//
// The argument list is matched by BALANCING parens, not by `[^)]*`. A policy
// expression contains `auth()`, so the lazy form stopped at the inner `)` and
// left `.id)` behind — a mutant that fails to parse, which counts as a kill, so
// the whole `allow-drop` family looked covered while nothing had run.
function _dropToken(line, name) {
  const out = []
  const at  = new RegExp(`(?<![\\w@])${name.startsWith('@@') ? '@@' : '@'}${name.replace(/^@+/, '')}\\b`, 'g')
  let hit
  while ((hit = at.exec(line)) !== null) {
    let end = hit.index + hit[0].length
    if (line[end] === '(') {
      const close = _closingParen(line, end)
      if (close === -1) continue        // unterminated — not ours to rewrite
      end = close + 1
    }
    // The whitespace before the attribute goes with it, so removing one from a
    // run of them does not leave a double space behind.
    let start = hit.index
    while (start > 0 && line[start - 1] === ' ') start--
    out.push({ line: line.slice(0, start) + line.slice(end) })
  }
  return out
}

// Index of the `)` matching the `(` at `open`, or -1. Quote-aware: a paren
// inside `@regex("a(b")` is not structure.
function _closingParen(line, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === quote && line[i - 1] !== '\\') quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

// ─── schemaMutants ────────────────────────────────────────────────────────────

/**
 * Every mutant of a `.lite` source, one per attribute occurrence.
 *
 * Each carries the full mutated text, so a caller can build a client from it
 * without knowing anything about how it was produced. `parses: false` means the
 * parser refused it — a kill, made by the parser rather than by the suite, and
 * counted as one.
 */
export function schemaMutants(schemaText, { kinds = null } = {}) {
  const lines   = schemaText.split('\n')
  const mutants = []
  let model = null
  let seq   = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Only the code half of the line is anything: an attribute named inside a
    // doc comment is prose, and mutating it produces a schema identical in
    // behaviour. The comment travels along untouched.
    const cut     = _commentAt(line)
    const code    = cut === -1 ? line : line.slice(0, cut)
    const comment = cut === -1 ? ''   : line.slice(cut)

    const open = code.match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)/)
    // A model opened on this line is still mutable ON this line — `.lite`
    // permits the whole model on one, and skipping the opening line skipped
    // every attribute such a model has, silently. Its own fixtures are written
    // that way, so the gap was invisible until a count came out one short.
    const wasOpen = Boolean(open)
    if (open) model = open[1]
    if (!wasOpen && /^\s*}\s*$/.test(code)) { model = null; continue }
    const inlineModel = wasOpen && /}\s*$/.test(code.trim())

    if (model && code.trim()) {
      for (const mutation of MUTATIONS) {
        if (kinds && !kinds.includes(mutation.kind)) continue
        for (const raw of mutation.apply(code)) {
          // A line reduced to nothing but its whitespace goes with the
          // attribute; a one-line model keeps everything else it held.
          const emptied = !raw.line.trim()
          const next    = [...lines]
          if (emptied) next.splice(i, 1)
          else         next[i] = raw.line + comment

          const text   = next.join('\n')
          const parsed = parse(text)
          mutants.push({
            id:     `${mutation.kind}#${++seq}`,
            kind:   mutation.kind,
            model,
            lineNo: i + 1,
            before: line.trim(),
            after:  emptied ? '(line removed)' : (raw.line + comment).trim(),
            describe: `${model}: ${mutation.describe(raw.meta ?? {})}`,
            text,
            parses: parsed.valid,
          })
        }
      }
    }

    // A model written entirely on one line closes here. Without this it stays
    // open, and whatever follows — an enum body, a stray attribute — is
    // attributed to it.
    if (inlineModel) model = null
  }

  return mutants
}

// ─── mutationScore ────────────────────────────────────────────────────────────

/**
 * Build a database from each mutant, run the ORIGINAL schema's derived checks
 * against it, and report the mutants nothing noticed.
 *
 * `build(text)` opens an env for one mutant's schema text — passed in rather
 * than imported, so this module does not depend on `createTestEnv` and can be
 * driven against anything that answers the same two questions.
 *
 * `check(env, original)` returns the mismatches. The default runs both executed
 * checks; `original` is the parsed ORIGINAL schema and is what the expectations
 * must come from — deriving them from the env would make every mutant survive.
 */
export async function mutationScore({ schema, build, check, kinds = null, onMutant = null }) {
  const original = parse(schema)
  if (!original.valid) throw new Error(`mutationScore: the original schema does not parse:\n${original.errors.join('\n')}`)

  // The three executed checks. Every one of them was added because a mutant
  // survived without it — which is the loop this exists to close.
  const runCheck = check ?? (async (env, orig) => [
    ...await env.verifyGateLadder({ against: orig.schema }),
    ...await env.verifyConstraints(null, { against: orig.schema }),
    ...await env.verifyFieldProtection({ against: orig.schema }),
    ...await env.verifyRowPolicies({ against: orig.schema }),
  ])

  const mutants  = schemaMutants(schema, { kinds })
  const survived = []
  const errored  = []
  const refused  = []
  let killed     = 0
  let byParser   = 0

  for (const mutant of mutants) {
    if (!mutant.parses) { byParser++; killed++; onMutant?.({ ...mutant, outcome: 'parser' }); continue }

    // Built in its own try, because refusing to build and failing to check are
    // different answers. A schema the framework will not LOAD is killed — it
    // cannot ship — and several are: `parse()` accepts a non-monotonic
    // `@@gate("4.3.4.5")` and the gate plugin refuses it at construction, so
    // the two halves of "is this schema legal" do not agree and only the second
    // one is reached here.
    let env, outcome
    try {
      env = await build(mutant.text)
    } catch (err) {
      killed++
      onMutant?.({ ...mutant, outcome: 'refused', thrown: err.message })
      refused.push({ ...mutant, thrown: err.message })
      continue
    }

    try {
      const mismatches = await runCheck(env, original)
      // ONLY a verdict disagreement kills. An `error` row means the check could
      // not run — a fixture that would not build, a write that failed for an
      // unrelated reason — and counting those was worth 36 points on a 14-mutant
      // schema: every mutant came back with the same 22 error rows and the score
      // read 93% while four mutations were going completely unnoticed. A
      // mutation score that counts its own harness failures as successes is the
      // oracle problem wearing a percentage.
      //
      // `uncheckable` and `rejected-by-another-rule` are the same shape and were
      // added later (`FJS-351`): both say *this case could not tell you
      // anything*. `uncheckable` is generated from the ORIGINAL schema, so it
      // appears identically under every mutant — the exact shape the 22 error
      // rows had. No schema in this repo has one of these AND a mutant that
      // would otherwise survive, so this is the argument rather than a measured
      // regression; the argument is the same one already written above it.
      const INCONCLUSIVE = new Set(['error', 'skipped', 'uncheckable', 'rejected-by-another-rule'])
      const verdicts = mismatches.filter(m => !INCONCLUSIVE.has(m.got))
      outcome = verdicts.length ? 'killed' : 'survived'
      if (outcome === 'killed') killed++
      else survived.push({ ...mutant, noise: mismatches.length })
    } catch (err) {
      // The suite itself fell over — that says nothing about the mutant either
      // way, so it is not graded. Counting it as a kill is how a mutation score
      // flatters itself.
      outcome = 'error'
      errored.push({ ...mutant, thrown: err.message })
    } finally {
      try { env.close?.() } catch { /* nothing to close */ }
    }
    onMutant?.({ ...mutant, outcome })
  }

  const graded = mutants.length - errored.length
  return {
    total:    mutants.length,
    graded,
    killed,
    byParser,
    refused,
    survived,
    errored,
    // Over the mutants that actually ran. A score over the total would improve
    // every time a mutant failed to build, which is the wrong direction.
    score: graded ? killed / graded : 1,
  }
}
