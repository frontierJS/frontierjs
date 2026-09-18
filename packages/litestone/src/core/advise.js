// ─── advise ───────────────────────────────────────────────────────────────────
//
// Two things the catalog cannot say, because both are about a COMBINATION rather
// than a word.
//
// VISIBILITY is the truth table that separates the five attributes people
// confuse — @computed, @transient, @system, @guarded, @encrypted. It is the same
// table the parser carries in prose above @transient, written so it can be
// looked up rather than read: three yes/no answers in, one word out. A wizard
// that walked a hand-drawn tree instead would be a second shape of the same
// fact, free to disagree with it.
//
// RULES are the refusals a schema earns by being legal and wrong. Every one of
// them parses — measured — so the parser will never say them, and each has cost
// somebody a runtime failure that named nothing useful.
//
// Both are here rather than in Studio so a terminal and an editor can ask them
// too. Neither reads the database: this is a judgement about a schema, and it
// must be answerable about a schema that has never been migrated.

import { parseGateString } from '../plugins/gate.js'
import { authClaimsUsed }   from './policy.js'
import { ID_GENERATORS }   from './ids.js'

// ─── The visibility table ─────────────────────────────────────────────────────
//
// stored       — is there a column?
// callerWrites — may a request put a value in it?
// callerReads  — does a request get it back?
//
// All eight combinations are named, including the three that are not a word:
// leaving a hole would make the wizard answer "nothing" where the truth is
// "you have described an ordinary column" or "that cannot be expressed".

export const VISIBILITY = [
  { stored: true,  callerWrites: true,  callerReads: true,
    word: null, answer: 'an ordinary column',
    note: 'Nothing to declare — this is what a field is without any of these attributes.' },

  { stored: true,  callerWrites: true,  callerReads: false,
    word: 'encrypted', answer: '@encrypted',
    note: 'Hidden from a reader and still writable, which is what a caller submitting a secret needs. Add @guarded as well and you have written @secret out longhand.' },

  { stored: true,  callerWrites: false, callerReads: true,
    word: 'system', answer: '@system',
    note: 'The application writes it by naming the column on the write — update({ …, system: [\'trackingCode\'] }) — which keeps the gate, the row policies and the audit actor that asSystem() would drop.' },

  { stored: true,  callerWrites: false, callerReads: false,
    word: 'guarded', answer: '@guarded',
    note: 'A system-context lock both ways. If the column is required, nothing below level 8 can create the row.' },

  { stored: false, callerWrites: false, callerReads: true,
    word: 'computed', answer: '@computed',
    note: 'Produced on read by application code. It cannot be filtered, sorted or paginated by; @derived is the one that can, because it is computed in SQL.' },

  { stored: false, callerWrites: true,  callerReads: false,
    word: 'transient', answer: '@transient',
    note: 'Validated with the model\'s own rules and then lifted onto ctx.transients, so nothing below the API boundary sees it.' },

  { stored: false, callerWrites: false, callerReads: false,
    word: null, answer: 'nothing at all',
    note: 'A value nobody writes and nobody reads is not a field. Delete it.' },

  { stored: false, callerWrites: true,  callerReads: true,
    word: null, answer: 'not expressible',
    note: 'A value read back has to be stored or computed. If the application computes it, that is @computed and the caller does not write it; if the caller writes it, it needs a column.' },
]

/** The word for three answers, or the row saying why there is not one. */
export function visibilityFor({ stored, callerWrites, callerReads }) {
  return VISIBILITY.find(r =>
    r.stored === !!stored && r.callerWrites === !!callerWrites && r.callerReads === !!callerReads) ?? null
}

/**
 * The question that is not in the table: an answer that depends on WHO is
 * asking is a field policy, not a visibility mode. Kept beside the table rather
 * than as a fourth axis, because it multiplies with every row instead of
 * partitioning them.
 */
export const PER_CALLER = {
  word: 'allow',
  answer: "@allow('read', …) on the field",
  note: 'The column is stripped from results when the expression is false. Several @allow on one field OR together, and asSystem() bypasses them. This is the answer whenever "may they see it" has a different answer for different callers.',
}

// ─── Rules ────────────────────────────────────────────────────────────────────

const isOptional = f => f.type?.optional === true
const has        = (f, kind) => (f.attributes ?? []).some(a => a.kind === kind)
const hasDefault = f => has(f, 'default') || has(f, 'generated') || has(f, 'sequence')
const modelAttr  = (m, kind) => (m.attributes ?? []).find(a => a.kind === kind)

/** The gate levels for a model, or null where none is declared. */
function gateOf(model) {
  const a = modelAttr(model, 'gate')
  if (!a) return null
  try { return parseGateString(a.value) } catch { return null }
}

/**
 * Column names a gate ladder is commonly graded from. A NAME heuristic and
 * nothing more — `Server.role` in basecamp is a fleet role and has nothing to do
 * with who may do what — so the name alone never raises this past a warning.
 */
const STANDING = new Set(['isAdmin', 'isOwner', 'isSystemAdmin', 'role', 'level', 'isStaff', 'isSuperuser'])

/**
 * Is this the model a caller's STANDING is read from?
 *
 * Two shapes litestone can actually see, and it is worth being exact about why
 * only these two:
 *
 *   @@auth              — the model auth() resolves to, said outright.
 *   the claim source    — under row tenancy, the model that carries the claim
 *                         column AND declares @@tenant(none). Carrying the
 *                         column makes it about a tenant; @@tenant(none) says
 *                         it is not SCOPED by one, which leaves the row that
 *                         defines the membership rather than a row inside it.
 *
 * Everything else is a guess. A gate resolver is application code and litestone
 * cannot read it, so a column that merely LOOKS like a standing gets a warning
 * phrased as a condition — measured on basecamp, where the same name is a real
 * privilege ladder on one model and a machine's job on another.
 */
function isStandingModel(model, schema) {
  if (modelAttr(model, 'auth')) return 'auth'
  const claim = schema.tenancy?.column ?? schema.tenancy?.claim
  if (!claim) return null
  const tenant = modelAttr(model, 'tenant')
  const spansTenants = tenant?.mode === 'none'
  const carriesClaim = (model.fields ?? []).some(f => f.name === claim)
  return spansTenants && carriesClaim ? 'claim' : null
}

/** The single `@id` a client can state, or null. The offline rules all ask it. */
function mintableIdField(model) {
  const ids = (model.fields ?? []).filter(f => has(f, 'id'))
  if (ids.length !== 1) return null
  const gen = (ids[0].attributes ?? []).find(a => a.kind === 'default')?.value
  return gen?.kind === 'call' && ID_GENERATORS[gen.fn] ? ids[0] : null
}

export const RULES = [
  {
    id:       'required-guarded-uncreatable',
    severity: 'error',
    title:    'a required @guarded column makes the model uncreatable',
    blurb:    'A @guarded column is writable only from asSystem(). Required with no default, every ' +
              'create below level 8 must supply a value nothing at that level may write, so the model ' +
              'cannot be created through the ordinary path at all.',
    run(schema) {
      const out = []
      for (const model of schema.models ?? []) {
        const gate = gateOf(model)
        if (gate && gate.create >= 8) continue   // already system-only; nothing is lost
        for (const f of model.fields ?? []) {
          if (!has(f, 'guarded') || isOptional(f) || hasDefault(f)) continue
          out.push({
            model: model.name, field: f.name,
            message: `${model.name}.${f.name} is @guarded and required, so every create must supply a value nothing below level 8 may write. Three ways out and they are not equivalent: a @default generates it at the Data boundary; making it optional says a row without one is legitimate; or the service creates the row through asSystem(), which is the right answer for a credential the caller must never see — and is the reason a service reaches for asSystem() rather than a sign it has gone wrong. What asSystem() costs is the gate, the row policies and the audit actor, for the whole create.`,
          })
        }
      }
      return out
    },
  },

  {
    id:       'required-system-unfilled',
    severity: 'warn',
    title:    'a required @system column has to be filled on every create',
    blurb:    '@system is out of create-mode required on purpose, so a generated form never asks for ' +
              'it. A required one with no default therefore has no filler unless the application names ' +
              'the column on the write, and the failure lands at the write rather than at the form.',
    run(schema) {
      const out = []
      for (const model of schema.models ?? []) {
        for (const f of model.fields ?? []) {
          if (!has(f, 'system') || isOptional(f) || hasDefault(f)) continue
          out.push({
            model: model.name, field: f.name,
            message: `${model.name}.${f.name} is @system and required. It is out of create-mode required, so a generated form will not ask for it — the application must name it on the write (system: ['${f.name}']) or the create fails.`,
          })
        }
      }
      return out
    },
  },

  {
    id:       'gate-over-own-standing',
    severity: 'warn',
    title:    'the gate may let a caller rewrite the column it is graded from',
    blurb:    'A @@gate is per model, so a gate low enough to let a signed-in caller update the model ' +
              'that grades them lets them update the column they are graded from. Severity depends on ' +
              'whether the column is one a caller may write.',
    run(schema) {
      const out = []
      for (const model of schema.models ?? []) {
        const gate = gateOf(model)
        if (!gate || gate.update >= 8) continue
        const why = isStandingModel(model, schema)
        const rowPolicy = (model.attributes ?? []).some(a =>
          (a.kind === 'allow' || a.kind === 'deny') && a.operations?.some(op => op === 'update' || op === 'all'))

        for (const f of model.fields ?? []) {
          if (!STANDING.has(f.name)) continue
          const fieldPolicy = (f.attributes ?? []).some(a =>
            a.kind === 'fieldAllow' && a.operations?.some(op => op === 'write' || op === 'all'))
          if (fieldPolicy) continue

          const head = why
            ? `${model.name} is ${why === 'auth' ? 'the @@auth model' : 'where the tenancy claim is read from'}, is gated at update=${gate.update}, and carries '${f.name}'.`
            : `${model.name} is gated at update=${gate.update} and carries '${f.name}', which is a name a gate ladder is often graded from — and often is not, so this is a question rather than a finding.`
          const fix = rowPolicy
            ? `A row policy decides WHOSE row; add @allow('write', …) on the column to decide WHICH columns.`
            : `Add @@allow('update', id == auth().id || auth().isAdmin) for whose row, and @allow('write', auth().isAdmin) on the column.`
          const nudge = why ? '' : ` If a getLevel is graded from it, declare @@auth on the identity model and this becomes decidable rather than guessed.`

          out.push({
            model: model.name, field: f.name,
            severity: why ? 'error' : 'warn',
            message: `${head} A gate is per MODEL, so at that level a caller may write any other row's '${f.name}'. ${fix}${nudge}`,
          })
        }
      }
      return out
    },
  },

  {
    id:       'guarded-and-encrypted-is-secret',
    severity: 'info',
    title:    '@guarded with @encrypted is @secret written out',
    blurb:    'The two together are exactly what @secret expands into. Writing both by hand is legal ' +
              'and means the same thing; the shorter spelling says the intent.',
    run(schema) {
      const out = []
      for (const model of schema.models ?? []) {
        for (const f of model.fields ?? []) {
          if (has(f, 'secret') || !has(f, 'guarded') || !has(f, 'encrypted')) continue
          out.push({
            model: model.name, field: f.name,
            message: `${model.name}.${f.name} declares both. @secret expands into exactly @encrypted @guarded plus a log entry, so saying @secret keeps the pair from drifting apart.`,
          })
        }
      }
      return out
    },
  },

  {
    id:       'fts-over-a-column-search-cannot-read',
    severity: 'error',
    title:    'a @@fts index names a column whose stored text is not the value',
    blurb:    'FTS5 indexes what the COLUMN HOLDS. For @encrypted that is a ciphertext and for @hashed a ' +
              'digest, so no query can ever match one — the index builds, the search runs and returns ' +
              'nothing. A @guarded column is the other half: it matches, and then read() strips it from ' +
              'every result, so callers can search text they may never see and highlight/snippet render it.',
    run(schema) {
      const out = []
      for (const model of schema.models ?? []) {
        const fts = (model.attributes ?? []).filter(a => a.kind === 'fts')
        if (!fts.length) continue
        for (const attr of fts)
          for (const name of attr.fields ?? []) {
            const f = (model.fields ?? []).find(x => x.name === name)
            if (!f) continue                                  // parse already names an unknown column
            // Order matters: @secret is @encrypted AND @guarded, and the
            // encrypted half is the one that makes the search impossible.
            if (has(f, 'encrypted') || has(f, 'hashed')) {
              const how = has(f, 'encrypted') ? '@encrypted' : '@hashed'
              out.push({
                model: model.name, field: f.name,
                message: `${model.name}.${f.name} is in @@fts and is ${how}, so the index holds ` +
                  `${has(f, 'encrypted') ? 'a ciphertext' : 'a one-way digest'} rather than the text. ` +
                  `search() can never match it and nothing says so — the query succeeds with no rows. ` +
                  `Take the column out of the @@fts, or store a searchable column beside it.`,
              })
            } else if (has(f, 'guarded')) {
              out.push({
                model: model.name, field: f.name, severity: 'warn',
                message: `${model.name}.${f.name} is in @@fts and is @guarded. The match works and the ` +
                  `column is then stripped from every result, so a caller can search text they may not ` +
                  `read — and highlight()/snippet() render the matched fragment, which is that text.`,
              })
            }
          }
      }
      return out
    },
  },

  {
    id:       'foreign-key-without-index',
    severity: 'warn',
    title:    'a foreign key column with no index',
    blurb:    'SQLite indexes a PRIMARY KEY and a UNIQUE and nothing else — a foreign key column gets no ' +
              'index unless the schema asks for one, and litestone emits CREATE INDEX only for @@index. ' +
              'So every lookup by that key, every include of the children, and every @@softDelete(cascade) ' +
              'walk is a full table scan that is fast on the rows a test writes.',
    run(schema) {
      const out = []
      for (const model of schema.models ?? []) {
        // Covered means "an index whose FIRST column is this one" — a composite
        // is usable for a prefix and useless for anything else, which is the
        // same rule SQLite applies.
        // A PARTIAL unique is deliberately not on this list: it indexes only the
        // rows its predicate admits, so a foreign-key lookup over the others is
        // still a scan.
        const covered = new Set()
        for (const a of model.attributes ?? [])
          if ((a.kind === 'index' || a.kind === 'uniqueIndex') && a.fields?.length) covered.add(a.fields[0])

        for (const f of model.fields ?? []) {
          const rel = (f.attributes ?? []).find(a => a.kind === 'relation')
          if (!rel?.fields?.length) continue
          for (const col of rel.fields) {
            const scalar = (model.fields ?? []).find(x => x.name === col)
            if (!scalar) continue
            if (has(scalar, 'id') || has(scalar, 'unique') || covered.has(col)) continue
            out.push({
              model: model.name, field: col,
              message: `${model.name}.${col} is the foreign key for ${f.name} and nothing indexes it. ` +
                `Add @@index([${col}]) — or a composite starting with it, if there is a filter that ` +
                `always accompanies it.`,
            })
          }
        }
      }
      return out
    },
  },

  {
    id:       'transition-to-a-state-nothing-reaches',
    severity: 'warn',
    title:    'an enum value no transition can reach',
    blurb:    'A @@transitions field is a closed machine: once declared, the only way the column moves is ' +
              'transition(). A value that is not the default and is on no transition\'s right-hand side ' +
              'is therefore unreachable — a state the application names, can write at create and can ' +
              'never move a row into.',
    run(schema) {
      const out = []
      for (const model of schema.models ?? []) {
        for (const attr of (model.attributes ?? []).filter(a => a.kind === 'transitions')) {
          const field = (model.fields ?? []).find(f => f.name === attr.field)
          const en    = (schema.enums ?? []).find(e => e.name === field?.type?.name)
          if (!en) continue
          const moves    = Object.values(attr.transitions ?? {})
          const reached  = new Set(moves.map(m => m.to))
          const defaults = (field?.attributes ?? []).find(a => a.kind === 'default')
          // A default is the state every row starts in, so it is reached by
          // being created rather than by a transition.
          const start = defaults?.value?.value ?? defaults?.value?.name ?? defaults?.value
          for (const value of en.values ?? []) {
            const name = typeof value === 'string' ? value : value.name
            if (reached.has(name) || name === start) continue
            out.push({
              model: model.name, field: attr.field,
              message: `${model.name}.${attr.field} declares @@transitions and no move ends at ` +
                `'${name}', which is not the default either. Nothing can put a row in that state. ` +
                `Add the move, or drop the value from enum ${en.name}.`,
            })
          }
        }
      }
      return out
    },
  },

  {
    id:       'label-column-that-may-be-null',
    severity: 'warn',
    title:    '@@label names a column that may be null',
    blurb:    '@@label is what a picker SHOWS for a foreign key, and the options query sorts by that ' +
              'column and matches it with contains. A null there is a blank row in the list, sorted ' +
              'together at one end and matching no search — which reads as a broken picker rather than ' +
              'as a row with no name.',
    run(schema) {
      const out = []
      for (const model of schema.models ?? []) {
        const attr = modelAttr(model, 'labelField')
        if (!attr) continue
        const f = (model.fields ?? []).find(x => x.name === attr.field)
        if (!f || !isOptional(f)) continue
        out.push({
          model: model.name, field: attr.field,
          message: `${model.name}.${attr.field} is the @@label and is optional, so a row without one ` +
            `shows blank in every picker. Make it required, give it a @default, or point @@label at a ` +
            `column that is always there.`,
        })
      }
      return out
    },
  },

  {
    id:       'unique-on-an-optional-column',
    severity: 'info',
    title:    '@unique on an optional column admits any number of nulls',
    blurb:    'SQLite treats NULLs as distinct in a UNIQUE index, so an optional unique column permits ' +
              'unlimited rows holding null. Usually what was wanted — an external id most rows do not ' +
              'have — and worth saying once, because "at most one row may have no value" is what people ' +
              'read the declaration as saying.',
    run(schema) {
      const out = []
      for (const model of schema.models ?? [])
        for (const f of model.fields ?? [])
          if (has(f, 'unique') && isOptional(f))
            out.push({
              model: model.name, field: f.name,
              message: `${model.name}.${f.name} is optional and @unique, so any number of rows may hold ` +
                `null. The constraint applies only to rows that have a value.`,
            })
      return out
    },
  },

  {
    id:       'index-another-index-already-covers',
    severity: 'info',
    title:    'an index a longer one already answers',
    blurb:    'SQLite uses an index for any PREFIX of its columns, so @@index([a]) beside @@index([a, b]) ' +
              'is never chosen and @@index([email]) on a column that is already @unique duplicates the ' +
              'index the constraint built. Each one is a second B-tree written on every insert and update ' +
              'for no read it can serve. A @@softDelete model is exempt and that is not a hedge: there ' +
              'ddl.js emits every @@index WHERE deletedAt IS NULL and every UNIQUE in full, so the short ' +
              'one is a different, smaller index rather than a duplicate.',
    run(schema) {
      const out = []
      for (const model of schema.models ?? []) {
        // On a soft-delete model the two are not the same index: `createIndexes`
        // appends WHERE deletedAt IS NULL to every @@index and to nothing else,
        // so @@index([a]) beside @@unique([a, b]) is the smaller partial index
        // over exactly the rows an ordinary read wants. Measured on basecamp,
        // where this rule's first cut told it to delete nine of those.
        if (modelAttr(model, 'softDelete')) continue

        const indexes = (model.attributes ?? [])
          .filter(a => (a.kind === 'index' || a.kind === 'uniqueIndex') && a.fields?.length)

        for (const idx of indexes) {
          if (idx.kind !== 'index') continue          // a unique index is a constraint, not a choice
          const cols = idx.fields.join(', ')

          const single = idx.fields.length === 1
            ? (model.fields ?? []).find(f => f.name === idx.fields[0] && (has(f, 'unique') || has(f, 'id')))
            : null
          if (single) {
            out.push({
              model: model.name, field: idx.fields[0],
              message: `@@index([${cols}]) on ${model.name} duplicates the index ` +
                `${has(single, 'id') ? '@id' : '@unique'} already builds on that column.`,
            })
            continue
          }

          const longer = indexes.find(other =>
            other !== idx &&
            other.fields.length > idx.fields.length &&
            idx.fields.every((c, i) => other.fields[i] === c))
          if (longer)
            out.push({
              model: model.name, field: idx.fields[0],
              message: `@@index([${cols}]) on ${model.name} is a prefix of ` +
                `@@${longer.kind === 'index' ? 'index' : 'unique'}([${longer.fields.join(', ')}]), ` +
                `which SQLite already uses for it.`,
            })
        }
      }
      return out
    },
  },

  {
    id:       'declared-and-unreferenced',
    severity: 'info',
    title:    'a declaration nothing references',
    blurb:    'An enum, type, trait, function, valueset or claim nothing names. Usually a rename that left the ' +
              'old declaration behind, but a type may legitimately exist for an API payload the seed ' +
              'never stores, which is reported as external rather than as a finding.',
    run(schema) {
      const referenced = new Set()
      for (const owner of [...(schema.models ?? []), ...(schema.views ?? []), ...(schema.types ?? [])])
        for (const f of owner.fields ?? []) {
          if (f.type?.name) referenced.add(f.type.name)
          for (const a of f.attributes ?? []) if (a.kind === 'type' && a.name) referenced.add(a.name)
        }
      const out = []
      for (const e of schema.enums ?? [])
        if (!referenced.has(e.name))
          out.push({ model: e.name, field: null, message: `enum ${e.name} is declared and no field uses it.` })
      // A type has a second consumer this cannot see: Junction's validateInput
      // names one from a service's `methods:`, so an unreferenced type is a
      // question rather than a finding, and the message has to say which.
      for (const t of schema.types ?? [])
        if (!referenced.has(t.name))
          out.push({ model: t.name, field: null, external: true,
            message: `type ${t.name} is not used by any Json @type(${t.name}). That is only half the answer — a service may name it as an \`input:\`, which is outside the schema and invisible here.` })
      // The other direction is a parse-time refusal, so this is the only half
      // that can be silent: a claim nothing names is a claim the app is still
      // resolving per request for nobody, and after a rename it is the reason
      // a policy that reads correctly denies every reader (`FJS-666`).
      const usedClaims = authClaimsUsed(schema)
      for (const c of schema.claims ?? [])
        if (!usedClaims.has(c))
          out.push({ model: null, field: null,
            message: `claim ${c} is declared and no @@allow, @@deny or @@scope reads auth().${c}.` })
      return out
    },
  },

  {
    id:       'materialized-view-full-refresh',
    severity: 'info',
    title:    'a materialized view is rebuilt in full on every row written to its sources',
    blurb:    '@@refreshOn installs INSERT, UPDATE and DELETE triggers on each source table, and each ' +
              'one runs DELETE + the whole @@sql again. SQLite fires a row trigger per row, so the ' +
              'cost is one full recomputation per row written, inside the writing transaction.',
    run(schema) {
      const out = []
      for (const view of schema.views ?? []) {
        if (!view.materialized || !(view.refreshOn ?? []).length) continue
        const sources = view.refreshOn.join(', ')
        out.push({
          model: view.name, field: null,
          message: `${view.name} is @@materialized on ${sources}. The refresh is a full rebuild — DELETE plus the whole @@sql — and it runs once per ROW written to ${view.refreshOn.length > 1 ? 'any of those tables' : 'that table'}, synchronously, inside the write's own transaction. A createMany of 10,000 rows therefore re-aggregates ${view.refreshOn.length > 1 ? 'the sources' : 'the source'} 10,000 times. That is the right trade where the sources take single writes and a stale answer is unacceptable, and the wrong one wherever bulk writes or a large source table are ordinary — there, drop @@refreshOn and keep @@materialized — the table is then rebuilt only when db.${view.name}.refresh() is called, which is the same aggregate at a cost somebody chose — or drop @@materialized and read the plain view.`,
        })
      }
      return out
    },
  },

  {
    id:       'sync-reference-to-a-server-assigned-id',
    severity: 'warn',
    title:    'a queued write references a model whose id only the server can assign',
    blurb:    '@@sync says a write may be made with no server reachable. Two of them in one session is the ' +
              'ordinary case — a parent and then its children — and the child has to name a parent that ' +
              'has no id yet, because the id is assigned by the INSERT that has not happened. Unless the ' +
              'parent declares an id the client can mint, there is nothing to write in the foreign key.',
    run(schema) {
      const out = []
      const models = schema.models ?? []
      const byName = new Map(models.map(m => [m.name, m]))

      for (const child of models) {
        if (!modelAttr(child, 'sync')) continue
        for (const f of child.fields ?? []) {
          // The OWNING side only — the back-reference carries no foreign key, so
          // it is the same relation read from the end that has nothing to write.
          const rel = (f.attributes ?? []).find(a => a.kind === 'relation' && a.fields?.length)
          if (!rel || f.type?.kind !== 'relation') continue

          const parent = byName.get(f.type.name)
          // A parent that is not syncable cannot be made offline at all, so it
          // already exists and already has an id. Nothing is owed here.
          if (!parent || !modelAttr(parent, 'sync')) continue
          if (mintableIdField(parent)) continue

          const idField = (parent.fields ?? []).find(x => has(x, 'id'))
          out.push({
            model: parent.name, field: idField?.name ?? 'id',
            message: `${parent.name} declares @@sync and ${child.name}.${f.name} references it, but ` +
              `${parent.name}.${idField?.name ?? 'id'} is assigned by the server. A ${child.name} made in ` +
              `the same offline session has nothing to put in ${rel.fields.join(', ')}, because the ` +
              `${parent.name} it belongs to is still in the queue. Declare an id the client can mint — ` +
              `${idField?.name ?? 'id'} String @id @default(uuid()) — and both writes drain in order with ` +
              `the reference already correct. Keep it as it stands only where a ${parent.name} is never ` +
              `created offline, which @@sync on it says is not the case.`,
          })
        }
      }
      return out
    },
  },

  {
    id:       'sync-file-with-no-key-to-attach-to',
    severity: 'warn',
    title:    'a syncable model carries bytes and has no key a client can state',
    blurb:    'A write held on a device is replayed in two halves — the row, then its bytes as a patch ' +
              'naming that row. The patch needs an id, and a model whose @id only the server assigns has ' +
              'none until the row has landed, so a write carrying a file is not held at all.',
    run(schema) {
      const out = []
      for (const model of schema.models ?? []) {
        if (!modelAttr(model, 'sync')) continue
        if (mintableIdField(model)) continue
        for (const f of model.fields ?? []) {
          if (f.type?.name !== 'File') continue
          out.push({
            model: model.name, field: f.name,
            message: `${model.name} declares @@sync and ${model.name}.${f.name} is a File, but this ` +
              `model's key is the server's to assign. The bytes are replayed as a patch naming the row, ` +
              `and offline there is no row and no id — so a write carrying ${f.name} is not held, and ` +
              `fails the way it would with no @@sync at all. Give the model an id the client can mint — ` +
              `id String @id @default(uuid()) — or accept that this model's files need a network.`,
          })
        }
      }
      return out
    },
  },

  {
    id:       'sync-required-file',
    severity: 'warn',
    title:    'a required File on a syncable model cannot be written offline',
    blurb:    'The row half of a held write replays WITHOUT its bytes — that is what makes a small ' +
              'correction independent of a large photograph. A File column that is required therefore ' +
              'has no value on the replayed create, and the boundary refuses the row the device thought ' +
              'it had saved.',
    run(schema) {
      const out = []
      for (const model of schema.models ?? []) {
        if (!modelAttr(model, 'sync')) continue
        for (const f of model.fields ?? []) {
          if (f.type?.name !== 'File' || isOptional(f) || hasDefault(f)) continue
          out.push({
            model: model.name, field: f.name,
            message: `${model.name}.${f.name} is a required File on a model that declares @@sync. A held ` +
              `write replays the row first and its bytes after, so the create arrives with no ${f.name} ` +
              `and is refused — offline, this model cannot be created at all. Make it optional, which is ` +
              `the truth about a row whose photograph is still on the phone, or drop @@sync from a model ` +
              `whose whole point is the file.`,
          })
        }
      }
      return out
    },
  },
]

/** Every rule, over one schema. */
export function checkRules(schema) {
  const out = []
  // A finding may state its own severity: `gate-over-own-standing` is an error
  // where litestone can see that the model IS the standing, and a question
  // everywhere else, and one rule answering at two levels beats two rules whose
  // conditions have to stay each other's complement.
  for (const rule of RULES)
    for (const finding of rule.run(schema) ?? [])
      out.push({ id: rule.id, severity: finding.severity ?? rule.severity, title: rule.title, ...finding })
  return out
}
