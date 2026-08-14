// src/access.js — the declared access surface of a schema, as data and as prose
//
// Invariant 6 says access is declared in the schema, not in hooks. This module
// reads that declaration back out: every `@@gate`, `@@allow`, `@@deny`,
// `@guarded`, `@encrypted`, `@secret`, field `@allow` and `@@transitions` gate,
// in one table.
//
// Two consumers, one derivation:
//   deriveAccess(schema)            → structured, for a test runner
//   renderAccessSnapshot(access)    → markdown, committed and diffed in git
//
// The snapshot is the reviewable artefact. Change a gate and the diff is the
// few lines whose access moved, rather than the thousands of generated
// assertions that would have moved with it.
//
// Never imported by production code.

import { parseGateString, validateGate, LEVELS } from './plugins/gate.js'

// ─── Level labels ─────────────────────────────────────────────────────────────

const LEVEL_LABEL = {}
for (const [name, n] of Object.entries(LEVELS)) LEVEL_LABEL[n] = name

export function levelLabel(n) { return LEVEL_LABEL[n] ?? `LEVEL_${n}` }

const OPS        = ['read', 'create', 'update', 'delete']
const POLICY_OPS = ['read', 'create', 'update', 'post-update', 'delete']

// Every level a caller can actually arrive at. 9 is absent on purpose — LOCKED
// is a gate value, never a principal's standing.
export const REACHABLE_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8]

// ─── Policy expression → source text ──────────────────────────────────────────
//
// Round-trips a parsed `@@allow`/`@@deny` condition back to the syntax it was
// written in. The snapshot has to show the predicate itself: a policy compiles
// silently into the WHERE clause, so "which rows" is invisible everywhere else.

const PREC = { or: 1, and: 2, not: 3 }
const prec = (node) => PREC[node?.type] ?? 4

export function policyExprToString(node) {
  if (!node) return '?'

  const child = (n) => (prec(n) < prec(node) ? `(${policyExprToString(n)})` : policyExprToString(n))

  switch (node.type) {
    case 'or':      return `${child(node.left)} || ${child(node.right)}`
    case 'and':     return `${child(node.left)} && ${child(node.right)}`
    // A compare binds tighter than `!` in the grammar, so `!a == b` parses as
    // not(compare). The parens are added back for the reader and re-parse the same.
    case 'not':     return node.expr?.type === 'compare'
      ? `!(${policyExprToString(node.expr)})`
      : `!${child(node.expr)}`
    case 'compare': return `${child(node.left)} ${node.op} ${child(node.right)}`
    case 'auth':    return node.field ? `auth().${node.field}` : 'auth()'
    case 'now':     return 'now()'
    case 'check':   return node.operation ? `check(${node.field}, '${node.operation}')` : `check(${node.field})`
    case 'field':   return node.name
    case 'literal': {
      const v = node.value
      if (v === null)              return 'null'
      if (typeof v === 'string')   return `'${v}'`
      return String(v)
    }
    default:        return `<${node.type}>`
  }
}

// ─── deriveAccess ─────────────────────────────────────────────────────────────
//
// schema → {
//   models: [{
//     name, db, external, gate, gateSource, softDelete,
//     policies: { <op>: { allows: [{expr, message}], denies: [...] } },
//     fields:   [{ name, protection, allows: [{ operations, expr }] }],
//     transitions: [{ field, name, from, to, gate }],
//     unrestricted: boolean,
//   }],
//   levels, counts
// }
//
// Models come back sorted by name, not in schema order: inserting a model
// mid-file otherwise shifts every row below it and the diff stops naming what
// actually changed.

export function deriveAccess(schema) {
  const models = [...(schema.models ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(model => describeModel(model))

  const counts = {
    models:       models.length,
    gated:        models.filter(m => m.gate).length,
    unrestricted: models.filter(m => m.unrestricted).length,
    policied:     models.filter(m => Object.keys(m.policies).length > 0).length,
    protected:    models.filter(m => m.fields.length > 0).length,
    transitions:  models.reduce((n, m) => n + m.transitions.length, 0),
  }

  return { models, levels: LEVELS, counts }
}

function describeModel(model) {
  const attrs      = model.attributes ?? []
  const gateAttr   = attrs.find(a => a.kind === 'gate')
  const gateSource = gateAttr ? String(gateAttr.value) : null

  let gate = null
  if (gateAttr) {
    gate = parseGateString(gateAttr.value)
    validateGate(gate, model.name)
  }

  const policies = {}
  for (const attr of attrs) {
    if (attr.kind !== 'allow' && attr.kind !== 'deny') continue
    for (const op of attr.operations) {
      policies[op] ??= { allows: [], denies: [] }
      const entry  = { expr: policyExprToString(attr.expr), message: attr.message ?? null }
      policies[op][attr.kind === 'allow' ? 'allows' : 'denies'].push(entry)
    }
  }

  const fields = []
  for (const field of model.fields ?? []) {
    const fa         = field.attributes ?? []
    const protection = fieldProtection(fa)
    const allows     = fa.filter(a => a.kind === 'fieldAllow')
      .map(a => ({ operations: a.operations, expr: policyExprToString(a.expr) }))

    if (protection || allows.length) fields.push({ name: field.name, protection, allows })
  }

  const transitions = []
  for (const attr of attrs) {
    if (attr.kind !== 'transitions') continue
    for (const [name, t] of Object.entries(attr.transitions ?? {}))
      transitions.push({ field: attr.field, name, from: t.from, to: t.to, gate: t.gate ?? null })
  }

  const softAttr = attrs.find(a => a.kind === 'softDelete')

  return {
    name:       model.name,
    db:         attrs.find(a => a.kind === 'db')?.name ?? null,
    external:   attrs.some(a => a.kind === 'external'),
    gate,
    gateSource,
    softDelete: softAttr ? (softAttr.cascade ? 'cascade' : true) : false,
    policies,
    fields,
    transitions,
    // Nothing at the Data boundary refuses this model to anyone. Not the same
    // as "public data" — it is "nobody said", which is what the snapshot exists
    // to make visible.
    unrestricted: !gateAttr && Object.keys(policies).length === 0,
  }
}

// @secret expands at parse time to @encrypted + @guarded(all) and keeps its own
// attribute, so a @secret field carries all three. Report the one that was written.
function fieldProtection(attrs) {
  if (attrs.some(a => a.kind === 'secret'))    return '@secret'
  if (attrs.some(a => a.kind === 'hashed'))    return '@hashed'
  const enc = attrs.find(a => a.kind === 'encrypted')
  if (enc)                                     return enc.deterministic ? '@encrypted(deterministic: true)' : '@encrypted'
  const guarded = attrs.find(a => a.kind === 'guarded')
  if (guarded)                                 return guarded.level === 'all' ? '@guarded(all)' : '@guarded'
  return null
}

// ─── expectedVerdict ──────────────────────────────────────────────────────────
//
// What `@@gate("R.C.U.D")` MEANS, stated here and nowhere else in this file's
// dependency path. `levelPasses()` in the gate plugin says the same thing and
// this deliberately does not call it.
//
// That is not the usual rule and it is not an oversight. A test whose expected
// value comes from the code under test cannot fail: the first cut of this asked
// `levelPasses()`, and deleting the SYSTEM sentinel from the plugin outright
// produced zero mismatches across 333 executed assertions, because both sides
// moved together. An oracle has to be independent of the thing it grades.
//
// The two statements are held together by one exhaustive test over every
// (required 0–9 × level 0–8) pair, which is where a divergence surfaces —
// loudly, in one place, instead of silently across every suite that trusts it.

export function expectedVerdict(required, level) {
  if (required === 9) return 'deny'                       // LOCKED — no exceptions
  if (required === 8) return level === 8 ? 'allow' : 'deny' // SYSTEM — asSystem() only
  return level >= required ? 'allow' : 'deny'
}

// ─── gateLadder ───────────────────────────────────────────────────────────────
//
// One model's gate as the full grid a runner asserts: every operation against
// every reachable level.

export function gateLadder(modelAccess) {
  if (!modelAccess.gate) return []
  const rows = []
  for (const op of OPS) {
    const required = modelAccess.gate[op]
    for (const level of REACHABLE_LEVELS)
      rows.push({ op, required, level, label: levelLabel(level), expect: expectedVerdict(required, level) })
  }
  return rows
}

// ─── renderAccessSnapshot ─────────────────────────────────────────────────────
//
// The committed artefact. Every section is omitted when empty, so a small
// schema gets a small file and the diff of adding the first `@@transitions` is
// the section appearing.

export function renderAccessSnapshot(access, opts = {}) {
  const { source = 'schema.lite', command = 'fli test:access' } = opts
  const { models, counts } = access
  const out = []

  out.push('# Access snapshot')
  out.push('')
  // The machine half of the same sentence. `scripts/ci.mjs`'s snapshots phase
  // reads this line and reruns the command with --check, so a snapshot names
  // what regenerates it rather than CI carrying a list.
  out.push(`<!-- generated by: litestone access --schema ${source} -->`)
  out.push('')
  out.push(`Generated from \`${source}\` by \`${command}\`. **Do not edit.**`)
  out.push('')
  out.push('Every line below is a rule the Data boundary enforces on every caller —')
  out.push('`@@gate` refuses, `@@allow`/`@@deny` filter. Regenerate after a schema change')
  out.push('and read the diff: it names exactly which access moved. A line that changed')
  out.push('without a schema change you meant to make is a shipped security bug.')
  out.push('')
  out.push(`\`\`\`\n${counts.models} models · ${counts.gated} gated · ${counts.unrestricted} unrestricted`)
  out.push(`${counts.policied} with row policies · ${counts.protected} with protected fields · ${counts.transitions} gated transitions\n\`\`\``)
  out.push('')

  // ── Unrestricted ──
  const open = models.filter(m => m.unrestricted)
  if (open.length) {
    out.push('## Unrestricted')
    out.push('')
    out.push('No `@@gate`, no `@@allow`. Every caller reaches every row, including an')
    out.push('unauthenticated one. Intended for reference data; anything else is a hole.')
    out.push('')
    for (const m of open) out.push(`- \`${m.name}\``)
    out.push('')
  }

  // ── Gate ladder ──
  const gated = models.filter(m => m.gate)
  if (gated.length) {
    out.push('## Gates')
    out.push('')
    out.push('Minimum level per operation. `SYSTEM` is reachable only through `asSystem()`;')
    out.push('`LOCKED` is reachable by nothing, `asSystem()` included.')
    out.push('')
    out.push('| Model | Read | Create | Update | Delete |')
    out.push('| --- | --- | --- | --- | --- |')
    for (const m of gated) {
      const cells = OPS.map(op => `${m.gate[op]} ${levelLabel(m.gate[op])}`)
      out.push(`| \`${m.name}\` | ${cells.join(' | ')} |`)
    }
    out.push('')
  }

  // ── Row policies ──
  const policied = models.filter(m => Object.keys(m.policies).length)
  if (policied.length) {
    out.push('## Row policies')
    out.push('')
    out.push('A policy compiles into the WHERE clause. It never raises — a wrong one is an')
    out.push('empty result with a 200, so read these as "which rows", not "which callers".')
    out.push('An operation with no `@@allow` is unrestricted at this layer.')
    out.push('')
    for (const m of policied) {
      out.push(`### \`${m.name}\``)
      out.push('')
      for (const op of POLICY_OPS) {
        const p = m.policies[op]
        if (!p) continue
        for (const a of p.allows) out.push(`- allow **${op}** — \`${a.expr}\`${a.message ? ` — "${a.message}"` : ''}`)
        for (const d of p.denies) out.push(`- deny **${op}** — \`${d.expr}\`${d.message ? ` — "${d.message}"` : ''}`)
      }
      out.push('')
    }
  }

  // ── Field protection ──
  const withFields = models.filter(m => m.fields.length)
  if (withFields.length) {
    out.push('## Protected fields')
    out.push('')
    out.push('`@guarded` needs a system context. `@encrypted`/`@secret` are ciphertext at rest')
    out.push('and log as `[redacted]` in the audit trail. A field `@allow` strips the column')
    out.push('rather than refusing the row.')
    out.push('')
    out.push('| Model | Field | Rule |')
    out.push('| --- | --- | --- |')
    for (const m of withFields) {
      for (const f of m.fields) {
        const rules = []
        if (f.protection) rules.push(`\`${f.protection}\``)
        for (const a of f.allows) rules.push(`\`@allow('${a.operations.join(',')}', ${a.expr})\``)
        out.push(`| \`${m.name}\` | \`${f.name}\` | ${rules.join(' · ')} |`)
      }
    }
    out.push('')
  }

  // ── Transition gates ──
  const withTransitions = models.filter(m => m.transitions.length)
  if (withTransitions.length) {
    out.push('## State transitions')
    out.push('')
    out.push('A move a caller may not make is refused even where `@@gate` allows the update.')
    out.push('An ungated move needs only the model\'s update level.')
    out.push('')
    out.push('| Model | Field | Move | From → To | Level |')
    out.push('| --- | --- | --- | --- | --- |')
    for (const m of withTransitions) {
      for (const t of m.transitions) {
        const lvl = t.gate == null ? '—' : `${t.gate} ${levelLabel(t.gate)}`
        out.push(`| \`${m.name}\` | \`${t.field}\` | \`${t.name}\` | ${t.from.join(', ')} → ${t.to} | ${lvl} |`)
      }
    }
    out.push('')
  }

  // ── Legend ──
  out.push('## Levels')
  out.push('')
  out.push('| # | Name | Who |')
  out.push('| --- | --- | --- |')
  const who = {
    0: 'unauthenticated',
    1: 'authenticated, unverified',
    2: 'verified, read-only',
    3: 'can submit, cannot manage',
    4: 'full member',
    5: 'app admin',
    6: 'account/tenant owner',
    7: 'global system admin — a real, revocable human',
    8: '`asSystem()` only — jobs, migrations. No identity, no audit trail',
    9: 'nothing passes',
  }
  for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) out.push(`| ${n} | ${levelLabel(n)} | ${who[n]} |`)
  out.push('')

  return out.join('\n')
}
