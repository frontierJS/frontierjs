// ─── invariants.js — what fails when an invariant stops being true ───────────
//
// `CLAUDE.md` § Invariants is the top of the prose stack: nineteen rules that
// may not be broken without a ruling. `doc-invariant-ref` already grades the
// citations — that a paragraph pointing at Invariant 22 is pointing at nothing.
// What nothing asked is the other direction, and it is the one that matters:
// **does this invariant have anything that fails when it stops being true?**
//
// Measured before this module existed: six of the nineteen were cited by a
// `fli check` rule and the other thirteen were reachable from no artefact at
// all. That is the shape `PHILOSOPHY.md` §III names — *a check that can only
// fail open is not a check* — one tier above where it usually bites, because an
// unenforced invariant reads exactly like an enforced one.
//
// ── Two halves, and only one of them derives ─────────────────────────────────
//
// A `fli check` rule declares the invariant it serves, so that half is READ off
// the rule table and cannot go stale. The other half cannot be derived by
// anything: that Invariant 12 is held by a describe block in `render-ssr.test.js`
// is a statement somebody makes, exactly like a row of the drives table. So it
// is DECLARED here and CHECKED that it resolves — `invariant-enforcer` in
// `checks.js`, the same discipline `proof-target` applies to `fli proves`.
//
// ── `none` is an answer, and it is the point ─────────────────────────────────
//
// An invariant with no enforcer is not a bug in this module. It is the finding.
// Recording it as `none` is what separates *nothing checks this* from *something
// checks this and I could not find it*, and those two look identical in prose.

import { existsSync, readFileSync } from 'node:fs'
import { join }                     from 'node:path'

const read = p => { try { return readFileSync(p, 'utf8') } catch { return null } }

// ─── the invariants themselves ───────────────────────────────────────────────
//
// Parsed from `CLAUDE.md` rather than restated, because the numbering IS the
// citation key: every `Invariant N` in the repo points at this list by position,
// and a second copy of it here would be the restatement the whole framework is
// a bet against.

export function readInvariants(root) {
  const text = read(join(root, 'CLAUDE.md'))
  if (text === null) return []

  const from = text.search(/^#+ Invariants\s*$/m)
  if (from < 0) return []
  const rest = text.slice(from)
  const to   = rest.slice(1).search(/^---\s*$/m)
  const body = to < 0 ? rest : rest.slice(0, to + 1)

  return [...body.matchAll(/^(\d+)\. \*\*(.+?)\*\*/gm)]
    .map(m => ({ n: Number(m[1]), title: m[2].replace(/\.$/, '').trim() }))
    .sort((a, b) => a.n - b.n)
}

// ─── the declared half ───────────────────────────────────────────────────────
//
// `kind` says what would fail and therefore how it is resolved:
//
//   test   a path in the tree — the suite that holds the assertion
//   phase  a phase of `bun run ci`, by the name `phase('…')` gives it
//   drive  a runnable id, resolved the way `fli proves` resolves one
//
// `covers` is required and is not decoration: an enforcer that holds HALF of an
// invariant is the most misleading row this table can carry, so the half is
// named where it is a half. A rule is not listed here — it declares its own
// invariant in `checks.js` and is read off that table.

export const ENFORCERS = {
  1: [{ kind: 'phase', at: 'hygiene',
        covers: 'the substrate package only — that `@frontierjs/toolbelt` declares no dependency. ' +
                'Nothing grades `Litestone ← Junction ← Sierra` itself' }],

  5: [{ kind: 'test', at: 'packages/junction/tests/plugin-contract.test.ts',
        covers: 'a second `app.claim(name)` throws naming the holder' }],

  6: [{ kind: 'test', at: 'packages/sierra/tests/static-safety-real.mjs',
        covers: 'the prerender half — a published route proves its reads against the model\'s own `@@gate`, ' +
                'against a real Litestone client' }],

  7: [{ kind: 'test', at: 'packages/litestone/test/litestone.test.ts',
        covers: '§ audit log redaction — `@secret`, `@encrypted` and `@guarded` log as `[redacted]` in a ' +
                'field entry and in a `before`/`after` snapshot' }],

  9: [{ kind: 'test', at: 'packages/junction/tests/patch-defaults.test.ts',
        covers: 'presence, not truthiness — an explicit `null` clears where an absent key does not' },
      { kind: 'test', at: 'packages/litestone/test/valuesets.test.ts',
        covers: 'the same rule at the Data boundary, where `?` is what makes the key optional' }],

  10: [{ kind: 'test', at: 'packages/toolbelt/test/specs/directives.spec.js',
         covers: 'the grammar both boundaries read — `splitParams` onto `{query, directives}`' },
       { kind: 'test', at: 'packages/junction/tests/query-directives.test.ts',
         covers: 'that no `$`-prefixed key survives the bridge into `ctx.query`' }],

  11: [{ kind: 'test', at: 'packages/mesa/test/browser/runtime/specs/delegation.spec.mjs',
         covers: 'nested roots, in a real browser — a handler fires once' }],

  12: [{ kind: 'test', at: 'packages/mesa/test/render-ssr.test.js',
         covers: '§ CSS scope ids are content-addressed — the same style content gives the same id in ' +
                 'any process, which is what lets two compilers dedupe one component' }],

  13: [{ kind: 'test', at: 'packages/css/test/specs/anatomy.spec.js',
         covers: 'the vocabulary against the real CSSOM, both directions — a class the vocabulary does ' +
                 'not name fails the suite' }],

  14: [{ kind: 'phase', at: 'typecheck',
         covers: 'a RAISED baseline fails; `scripts/typecheck-baselines.json` is the record' }],

  15: [{ kind: 'test', at: 'packages/cli/tests/compiler.test.js',
         covers: 'every shipped command file compiles AND the output is parsed' },
       { kind: 'test', at: 'packages/mesa/test/emission.test.js',
         covers: 'the compiler\'s own output is parsed rather than matched' }],
}

// ─── resolving one ───────────────────────────────────────────────────────────

const PHASE_CALL = name => new RegExp(String.raw`phase\(\s*'${name}'\s*\)`)

export function resolveEnforcer(root, e, { rules = [], runnableIds = null } = {}) {
  if (e.kind === 'test')  return existsSync(join(root, e.at))
  if (e.kind === 'rule')  return rules.some(r => r.id === e.at)
  if (e.kind === 'drive') return runnableIds ? runnableIds.has(e.at) : true
  if (e.kind === 'phase') {
    const ci = read(join(root, 'scripts', 'ci.mjs'))
    return ci !== null && PHASE_CALL(e.at).test(ci)
  }
  return false
}

// ─── the whole table ─────────────────────────────────────────────────────────
//
//   invariantCoverage({ root, rules })  → [{ n, title, enforcers, covered }]
//
// `enforcers` merges the derived half (rules declaring `invariant: n`) with the
// declared half above, each carrying `resolved`.

export function invariantCoverage({ root, rules = [], runnableIds = null } = {}) {
  return readInvariants(root).map(inv => {
    const derived = rules
      .filter(r => r.invariant === inv.n)
      .map(r => ({ kind: 'rule', at: r.id, covers: r.title, resolved: true, derived: true }))

    const declared = (ENFORCERS[inv.n] ?? []).map(e => ({
      ...e, derived: false, resolved: resolveEnforcer(root, e, { rules, runnableIds }),
    }))

    const enforcers = [...derived, ...declared]
    return { ...inv, enforcers, covered: enforcers.length > 0 }
  })
}

// ─── rendering ───────────────────────────────────────────────────────────────

const KIND_WORD = { rule: '`fli check`', test: 'test', phase: '`bun run ci`', drive: 'drive' }

export function renderInvariants(rows) {
  const out = []
  const uncovered = rows.filter(r => !r.covered)

  out.push('<!-- generated by: fli ws:invariants -->')
  out.push('')
  out.push('# Invariants — what fails when one stops being true')
  out.push('')
  out.push('Generated. `CLAUDE.md` § Invariants is the source of the list and its numbering;')
  out.push('a `fli check` rule declares the invariant it serves and is read off that table;')
  out.push('everything else is declared in `packages/cli/core/invariants.js` and checked to')
  out.push('resolve by `fli check`\'s `invariant-enforcer`.')
  out.push('')
  out.push('**`none` is an answer.** An invariant nothing grades reads exactly like one that is')
  out.push('enforced, which is the whole reason this file exists — so the gap is written down')
  out.push('rather than left to be rediscovered.')
  out.push('')
  out.push(`Covered: **${rows.length - uncovered.length} of ${rows.length}**.`)
  out.push('')

  for (const r of rows) {
    out.push(`### ${r.n}. ${r.title}`)
    out.push('')
    if (!r.enforcers.length) {
      out.push('**none** — nothing in this repo fails when it stops being true.')
      out.push('')
      continue
    }
    out.push('| Kind | What | Covers |')
    out.push('| --- | --- | --- |')
    for (const e of r.enforcers) {
      const at = e.resolved ? `\`${e.at}\`` : `\`${e.at}\` — **does not resolve**`
      out.push(`| ${KIND_WORD[e.kind] ?? e.kind} | ${at} | ${e.covers} |`)
    }
    out.push('')
  }

  if (uncovered.length) {
    out.push('## The gap')
    out.push('')
    out.push('Nothing here fails when these stop being true. Each is a rule to write, or a')
    out.push('statement that no mechanical check can reach it — and until one of the two is')
    out.push('recorded, neither has been decided.')
    out.push('')
    for (const r of uncovered) out.push(`- **${r.n}. ${r.title}**`)
    out.push('')
  }

  return out.join('\n') + '\n'
}
