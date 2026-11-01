/**
 * @frontierjs/sierra — the schema readers behind a resource
 *
 * `columns`, `filters`, `summary`, `children`, `sealedFields` and
 * `requiredFields` are questions a screen asks of a model's schema, not steps
 * of a call, so they take the schema's pieces and close over nothing else of
 * `createResource`. The resource hands them what it resolved (`modelDef`, the
 * three field tables, `relations`) and the three things it owns that they
 * lean on: `formFields`, `options` and `relatedResource`.
 */

import {
  buildFieldRules, buildRelations, columnList, columnLabel, displayFor, filterOpFor,
  sealedFor, refusedFor, requiredFor, blankRefused,
} from './field-rules.js'
import { serviceNameFor } from './schema-registry.js'

export function createSchemaReaders({
  model, modelDef, readModel, fields, updateFields, readFields, relations, versionOf,
  registry, columnDefaults, declaredRules, formFields, options, relatedResource, currentUser,
}) {
  /**
   * Which columns a TABLE shows of this model, ranked, and what it left out.
   *
   * `formFields()`' counterpart, and not the same question: a form shows what
   * is WRITABLE, a table what is READABLE and IDENTIFYING. So this reads the
   * READ table — the only one carrying a `@computed` total or a `@generated`
   * name — and ranks rather than takes the first few, because the order columns
   * sit in a file is an order somebody chose for unrelated reasons.
   *
   * The model's own two answers travel with the call, so a hand-written table
   * and a generated one cannot rank differently: `x-identify` is the business
   * key a person recognizes and `x-label-field` the column that names the row.
   *
   * Answers `{ columns, omitted }` — every field not shown is named with a
   * reason, for `formFields()`' reason exactly.
   */
  function columns(opts) {
    return rankColumns({ ...columnDefaults, ...opts })
  }

  // The ranking with no `columns:` default under it. `summary()` asks a
  // different question from a table — what a FORM cannot show — so a table's
  // `only` narrowing it would drop columns from a detail screen in silence.
  function rankColumns(opts) {
    const answer = columnList({ ...readFields, ...declaredRules() }, {
      identify: modelDef?.['x-identify'],
      label:    modelDef?.['x-label-field'],
      ...opts,
    })
    // The renderer is resolved with the column rather than by the caller, for
    // `formFields()`' reason: the model name has to travel so a registered
    // display can claim `Order.total` rather than every money column in the
    // app, and a caller assembling that context by hand is a caller who can get
    // it wrong on one screen out of six.
    return {
      ...answer,
      columns: answer.columns.map(c => {
        const shown = displayFor(c.rule, { field: c.name, model })
        return { ...c, ...shown, ...relationLabel(shown) }
      }),
    }
  }

  // A cell holds a foreign key and nobody recognizes one. What a person
  // recognizes is that model's own label, the one a picker shows: its
  // `labelField`, the conventional columns below it and a declared list with
  // its hops. Without them on the answer `<Cell>` cannot read a loaded
  // `row[relation]` and prints the id. A registered display that claims
  // `relation` is handed the same three.
  function relationLabel(shown) {
    if (shown.display !== 'relation' || !shown.model) return null
    const { labelField, labelAlt, labelParts } = relatedResource(serviceNameFor(shown.model) ?? shown.model, shown.model)
    return { labelField, labelAlt, labelParts }
  }

  /**
   * Which columns a filter bar may offer, and with which question.
   *
   * Two inputs and they answer different halves. **`x-filterable` says whether
   * the Data boundary will take a `where` on this column at all** — absent
   * means yes, a string says why not (`computed` · `transient` · `encrypted`),
   * and it is the same function `$checkWhere` refuses with, so an offer here
   * cannot outrun what the boundary accepts. **`filterOpFor(display)` says what
   * a filter over that KIND asks**, which is why this is not a third registry:
   * the column already has one kind and `displayFor` named it.
   *
   * A column that cannot be filtered is RETURNED with the reason rather than
   * dropped, exactly as an unplaceable control and an unrenderable column are.
   * A bar renders the ones with an `op`; anything else has an answer for why
   * it is not there.
   *
   * Ranked and labelled by `columns()` under the same limit, so the bar offers
   * what the table shows and in the same order — two lists derived from one is
   * what stops a filter appearing for a column nobody can see. A page that pins
   * its table with `columns({ only })` passes the same `only` here; a caller
   * wanting a wider bar says `{ limit }`.
   *
   * **`search` is the third answer and it is the model's, not a column's.**
   * `$search` is served by `table.search()`, which a Litestone client offers
   * only under `@@fts` and refuses by name below it, so the question is *does
   * this model answer at all* — one answer per model, where the other two are
   * one per column. It carries the indexed columns and their labels, because a
   * box that cannot say what it searches leaves a person to guess why a word
   * they can SEE in the table did not match. Refused with a reason rather than
   * answered `null`, for the same rule as a column with no `op`.
   */
  function filters(opts = {}) {
    const { columns: cols, omitted } = columns(opts)
    const joined = throughFilters()

    const ftsFields = readModel?.['x-search']
    const search    = ftsFields?.length
      ? {
          fields: ftsFields,
          // The read schema is asked per field rather than the ranked column
          // list, because `@@fts` may index a column the table does not show —
          // one past the limit, or one no `columns()` tier ranks — and a label
          // resolved off the list would come back undefined for exactly those.
          labels: ftsFields.map(n => columnLabel(n, readModel?.properties?.[n])),
        }
      : { fields: null, reason: 'the model declares no @@fts, so the Data boundary refuses $search by name' }

    // A bar cannot list a table past the cap, and the kit never calls a service,
    // so a column whose options are FETCHED carries the asking, bound to its
    // name: `Form.mesa`'s `optionsFor` one surface along. An enum carries none.
    // `record` is `{ [name]: picks }`, so a pick beyond the first page still
    // arrives labeled.
    const asking = (f) => f.rule?.references || f.rule?.values
      ? { ...f, optionsFor: (opts = {}) => options(f.name, opts) }
      : f

    return {
      search,
      filters: cols.map((c) => {
        // The boundary's own answer first: a `@computed` column has no column
        // to compare, and no display name makes it filterable.
        const refused = readModel?.properties?.[c.name]?.['x-filterable'] ?? c.rule?.['x-filterable']
        if (refused) return { ...c, op: null, kind: null, reason: refused }

        // Amounts held in several currencies share no scale, so one range
        // over them compares cents with yen. `FJS-D556`.
        if (c.display === 'money' && !c.currency) {
          return { ...c, op: null, kind: null, reason: `${c.name} holds amounts in the currency of each row, which share no range` }
        }

        const f = filterOpFor(c.display)
        if (!f) return { ...c, op: null, kind: null, reason: `no filter for a ${c.display ?? 'column of unknown kind'}` }
        // A Json or file column compares nothing by value, but an optional one
        // can still be asked whether it holds anything — `IS NULL` is not a
        // match against the serialized document.
        if (!f.op && c.rule?.nullable) return { ...c, op: ['equals', 'not'], kind: 'empty' }
        // A declared key is filtered through the column its slot generated,
        // since the boundary takes no where on a key inside a Json blob.
        return asking({ ...c, ...f, ...(c.rule?.['x-slot'] ? { queryKey: c.rule['x-slot'] } : {}) })
      }).concat(joined.map(asking)),
      omitted,
    }
  }

  /**
   * The to-manys this list can be filtered THROUGH — one entry per `hasMany`
   * whose child is a join: a model with exactly one `belongsTo` back here and
   * exactly one to somewhere else (a `@@relator`'s shape). *Contacts carrying
   * any of these tags* is `{ tags: { some: { tagId: { in } } } }`, which the
   * Data boundary answers and `list.apply()` carries in the URL; what a screen
   * lacked was the offer.
   *
   * What to offer is the join's other end, and it is declared there already:
   * `entry.rule` is the child's rule for that key, so a `@values` binding or a
   * foreign key is read by `options(name)` exactly as it is for a column. A
   * child that is not a join, or whose schema is not registered, offers nothing
   * rather than a filter the bar could not populate.
   */
  function throughFilters() {
    const out = []

    for (const rel of Object.values(relations)) {
      if (rel.type !== 'hasMany') continue

      const childDef = registry.schemaFor(rel.model)
      if (!childDef) continue

      const kids = Object.values(buildRelations(childDef, registry.modelNameFor)).filter(r => r.type === 'belongsTo')
      const back = kids.filter(r => r.model === model)
      const away = kids.filter(r => r.model !== model)
      if (kids.length !== 2 || back.length !== 1 || away.length !== 1 || away[0].foreignKeys?.length !== 1) continue

      const field = away[0].foreignKeys[0]
      const rule  = buildFieldRules(childDef, registry.resolveRef, registry.modelNameFor)[field]
      if (!rule) continue

      out.push({
        name: rel.field, label: columnLabel(rel.field), display: 'relation',
        op: 'in', kind: 'set', rule, through: { field, model: rel.model },
      })
    }

    return out
  }

  /**
   * The columns a FORM cannot show — what a detail screen puts above one.
   *
   * A form shows what is writable, so everything a server owns is missing from
   * it BY RULE: a `@computed` total, a `@generated` name, a `@from` rollup, a
   * `@system` timestamp, the `@version`. Those are most of what a person opens
   * a record to read, and until the read schema reached the browser a detail
   * screen could not render one of them.
   *
   * **Defined against the form rather than restated**, so the two cannot drift:
   * a column belongs here exactly when `formFields()` offers no control for it.
   * That is the same question `controlFor` answers when it refuses a read-only
   * column and says the value wants the surface that did not exist yet.
   *
   * Answers `columns()`' shape — ranked, with a display resolved and `omitted`
   * carrying whatever the limit cut — so a caller renders it with the same
   * `<Cell>` a table uses.
   */
  function summary(opts = {}) {
    const offered = new Set(
      formFields().filter(f => f.control).map(f => f.name),
    )
    return rankColumns({ limit: 99, ...opts, except: [...offered, ...(opts.except ?? [])] })
  }

  /**
   * This model's child collections, each with the column that points back.
   *
   * A detail view is a model PLUS its relations, and the to-many half is the
   * one a screen cannot render from this model's schema alone: a `hasMany`
   * entry names the child model and carries no foreign key, because the key is
   * on the child. So the child's own schema is asked for the `belongsTo` that
   * points back here, and that column is what filters its list.
   *
   * A child whose schema is not registered is REPORTED rather than skipped —
   * usually a model with no service, which is the case a generated admin meets
   * first and the one that is silent otherwise.
   *
   * @returns {{field, model, service, foreignKey, reason?}[]}
   */
  function children() {
    const out = []

    for (const rel of Object.values(relations)) {
      if (rel.type !== 'hasMany') continue

      const childDef = registry.schemaFor(rel.model)
      if (!childDef) {
        out.push({ field: rel.field, model: rel.model, service: null, foreignKey: null,
                   reason: `no schema registered for ${rel.model}` })
        continue
      }

      // The back-reference, by MODEL rather than by name: a child may call the
      // relation anything, and two children of one parent is ordinary.
      const back = Object.values(buildRelations(childDef, registry.modelNameFor))
        .find(r => r.type === 'belongsTo' && r.model === model)

      if (!back?.foreignKeys?.length) {
        out.push({ field: rel.field, model: rel.model, service: serviceNameFor(rel.model), foreignKey: null,
                   reason: `${rel.model} declares no belongsTo back to ${model}` })
        continue
      }

      out.push({
        field: rel.field, model: rel.model,
        service: serviceNameFor(rel.model),
        foreignKey: back.foreignKeys[0],
      })
    }

    return out
  }

  /**
   * Which columns are frozen FOR THIS ROW.
   *
   * Two ways a column gets here and they are one question — *may this row still
   * accept a value for this field* — asked of the model's UPDATE schema:
   *
   *   `@immutable`            — frozen the moment the row exists
   *   `@immutable` + `@seals` — frozen once the row reaches a sealing state
   *
   * The method keeps the narrower name it was given: `@frontierjs/ui` already
   * calls it through `lockedBy(form, name)`, which is the general word, and
   * renaming the resource verb is a cross-package edit. The seal was only ever
   * the half that could not be answered from the schema alone.
   *
   * Until `FJS-807` this answered `[]` for every row of every model, because
   * the build shipped the CREATE schema and neither marker exists in it.
   *
   * Reached through the resource rather than imported, like `formFields` and
   * `options`, because `@frontierjs/ui` peers only on mesa and css and the rule
   * belongs to `sealedFor`. Answering a LIST rather than a predicate is what
   * keeps it one call per render instead of one per field.
   *
   * The row to ask about is the one that was READ, never the payload being
   * assembled: a save that issues the document and edits it in the same
   * submit is legitimate — the boundary grades against the STORED state — and
   * reading the payload's own state column would drop that edit in silence.
   *
   * No record answers `[]`, deliberately: a create form is making a draft.
   */
  function sealedFields(record) {
    // A column whose field write policy refuses THIS caller is frozen on a
    // create as well as an edit, so it is asked before the record is
    // (`FJS-1671`). The principal is the one this resource's app sees.
    const out = []
    const user = currentUser()
    for (const [name, rule] of Object.entries(fields)) {
      if (refusedFor(rule, user)) out.push(name)
    }
    if (!record) return out
    for (const [name, rule] of Object.entries(updateFields)) {
      if (out.includes(name)) continue
      // The version column is `readOnly` and is the one that MUST travel, which
      // is the same exception `stripReadOnly`'s keep list exists for. A caller
      // deleting it from the payload turns every optimistic write into one the
      // server refuses for having no revision.
      if (name === versionOf) continue

      // Frozen because the column may be written once — `@immutable` on a model
      // that does not seal, which the update schema marks `readOnly` outright.
      // Read against the CREATE table so a column that was never writable at
      // all (`@system`, `@generated`, `@computed`, `@from`, a tenancy stamp) is
      // not reported here: those are not frozen for this row, they are the
      // server's on every row, and a form never offered a box for them.
      // A @@transitions field is read-only in an update for another reason: a
      // move changes it, and it is no more frozen on one row than on another.
      if (rule?.readOnly && !fields[name]?.readOnly && rule['x-litestone-kind'] !== 'transition') {
        out.push(name); continue
      }

      // Frozen because the row has REACHED the state that seals it — the
      // answer no schema can carry, which is why it is asked of the record.
      if (sealedFor(rule, record)) out.push(name)
    }
    // A `@sealed` hasMany is frozen by the same state, and a relation has no
    // field rule to carry it, so the seal rides on its `x-relations` entry.
    for (const rel of modelDef?.['x-relations'] ?? []) {
      if (rel?.seal && rel.seal.states.includes(record[rel.seal.field])) out.push(rel.field)
    }
    return out
  }

  /**
   * Which columns need a value for the record as it stands NOW.
   *
   * `sealedFields`' opposite number: that one answers which columns this row
   * has frozen, this one which it has made necessary. Both are questions no
   * schema can answer, both are reached through the resource for the same
   * reason (`@frontierjs/ui` peers only on mesa and css), and both answer a
   * LIST rather than a predicate so a form asks once per render instead of once
   * per field.
   *
   * The record being ASSEMBLED and not the one that was read — the opposite of
   * `sealedFields`, and deliberately. A seal is graded against the STORED state
   * because the boundary grades it there; this is graded against what is about
   * to be written, because that is what the CHECK will see and because the
   * person may have just picked the status that makes the column required.
   *
   * `mode` is the write the form will make. On a patch a non-null column with
   * a default is necessary too, since blanking it is refused (`FJS-2065`).
   */
  function requiredFields(record, mode) {
    const out = []
    for (const [name, rule] of Object.entries(fields))
      if ((rule?.['x-litestone-required-where'] || blankRefused(rule, mode)) && requiredFor(rule, record, mode)) out.push(name)
    return out
  }

  return { columns, summary, children, filters, throughFilters, sealedFields, requiredFields }
}
