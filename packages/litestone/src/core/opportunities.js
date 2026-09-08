// ─── opportunities ────────────────────────────────────────────────────────────
//
// The question every other artefact in this repo cannot ask.
//
// `db/access.snapshot.md` is the access surface you HAVE, `db/ddl.snapshot.sql`
// the DDL you emit, `surface.snapshot.md` the API you answer. All of them are
// derived from the seed, so a word absent from the seed is absent from every one
// of them — and nobody has ever got an error for never having heard of `@@fts`,
// `trait` or `@@transitions`. They write the application without them, at a cost
// nothing measures.
//
// `advise.js` answers the neighbouring question and it is not this one. A RULE
// is *legal and wrong*: the schema says something and something later refuses
// it. An OPPORTUNITY is *legal and missing*: the schema says nothing, everything
// works, and a word would have said it better. That difference decides the
// vocabulary — a rule has a severity because it is a defect, and these carry a
// `confidence` because the schema is not wrong and the author may have meant it.
//
// Every finding names the WORD it is about — as TYPED, prefix included — which
// is what makes this a routing device rather than a lint: the panel links to
// that word's card and the next thing to type is `litestone explain <word>`,
// printed verbatim. `test/opportunities.test.ts` asserts every one resolves, so
// a suggestion cannot point at something that does not exist.
//
// Nothing here reads the database. A schema that has never been migrated is
// exactly when this is worth asking.

import { lookup } from './catalog.js'

const has        = (f, kind) => (f.attributes ?? []).some(a => a.kind === kind)
const modelAttr  = (m, kind) => (m.attributes ?? []).find(a => a.kind === kind)
const isOptional = f => f.type?.optional === true
const scalarOf   = f => (f.type?.kind === 'scalar' ? f.type.name : null)
const isRelation = (f, schema) => (schema.models ?? []).some(m => m.name === f.type?.name)

/** Is there a column? `@computed`, `@transient` and `@derived` have none. */
const isStored = f => !has(f, 'computed') && !has(f, 'transient') && !has(f, 'derived')

/** The name the emitted SQL uses — `@map` renames the column and nothing else. */
const fieldColumn = (model, name) => {
  const f = (model.fields ?? []).find(x => x.name === name)
  return f?.attributes?.find(a => a.kind === 'map')?.value ?? name
}

/** A model the app declared, as opposed to one litestone or a plugin added. */
const authored = schema => (schema.models ?? []).filter(m => !modelAttr(m, 'external'))

// ─── the checks ───────────────────────────────────────────────────────────────
//
// Ordered strongest first, because a list whose first row is a maybe is a list
// people stop reading.

export const OPPORTUNITIES = [
  {
    id:         'credential-column-in-plain-text',
    confidence: 'likely',
    word:       '@secret',
    title:      'a column that looks like a credential, stored as text',
    blurb:      'A column named for a password, a token or a key, stored as text. @hashed is ' +
                'one-way and right for a password; @encrypted is readable again and right for a ' +
                'token the application must present; @secret is both plus a system-context lock. ' +
                '**@guarded is not one of them** and the distinction is the whole finding: it ' +
                'decides who may ASK, and the value is still plaintext in a file that gets backed ' +
                'up, replicated and copied to a laptop. A guarded column is graded lower here ' +
                'rather than cleared, because the author has plainly thought about the column.',
    run(schema) {
      const NAMES = /^(password|passwd|pwd|secret|token|apiKey|accessToken|refreshToken|privateKey|clientSecret)$/i
      const out = []
      for (const model of authored(schema))
        for (const f of model.fields ?? []) {
          if (!NAMES.test(f.name) || scalarOf(f) !== 'String') continue
          if (has(f, 'hashed') || has(f, 'encrypted') || has(f, 'secret')) continue
          // A value with no COLUMN cannot be at rest. `@transient` is the shape
          // this is about — a credential on its way through, validated and then
          // lifted off the payload — and basecamp's NotificationChannel.secret
          // is exactly it, which the first cut of this reported as plaintext.
          if (!isStored(f)) continue
          const guarded = has(f, 'guarded')
          out.push({ model: model.name, field: f.name,
            confidence: guarded ? 'possible' : 'likely',
            message: guarded
              ? `${model.name}.${f.name} is @guarded, so no caller reads it — and it is still ` +
                `plaintext at rest. @encrypted adds the other half; the two together are @secret.`
              : `${model.name}.${f.name} is a String and nothing protects it, in either sense. A ` +
                `password wants @hashed; a token the application presents again wants @encrypted.` })
        }
      return out
    },
  },

  {
    id:         'column-declared-and-inert',
    confidence: 'likely',
    word:       '@@softDelete',
    title:      'the column a feature needs, without the feature',
    blurb:      'A `deletedAt DateTime?` with no @@softDelete is an ordinary nullable column: ' +
                'remove() hard-deletes, no read filters it, restore() throws by name. Same for ' +
                'an isTemplate Boolean with no @@hasTemplates. The column is the tell that ' +
                'somebody wanted the feature and wrote the schema half of it.',
    run(schema) {
      const PAIRS = [
        { column: 'deletedAt',  attr: 'softDelete',    word: '@@softDelete'   },
        { column: 'isTemplate', attr: 'hasTemplates',  word: '@@hasTemplates' },
      ]
      const out = []
      for (const model of authored(schema))
        for (const p of PAIRS) {
          if (!(model.fields ?? []).some(f => f.name === p.column)) continue
          if (modelAttr(model, p.attr)) continue
          out.push({ model: model.name, field: p.column, word: p.word,
            message: `${model.name} has a ${p.column} column and no ${p.word}, so nothing reads it. ` +
              `Declare the attribute, or drop the column.` })
        }
      return out
    },
  },

  {
    id:         'model-outside-the-gate-ladder',
    confidence: 'likely',
    word:       '@@gate',
    title:      'an ungated model in a gated schema',
    blurb:      'A schema that declares any @@gate has GatePlugin installed for all of it, and a ' +
                'model declaring none is open at every level to everyone the transport lets in. ' +
                'That is a decision in a schema where the neighbors are graded — one worth ' +
                'writing down, if only as the level it is genuinely readable at.',
    run(schema) {
      const models = authored(schema)
      const gated  = models.filter(m => modelAttr(m, 'gate'))
      // Nothing to say about a schema that has not opted into gates at all.
      if (!gated.length || gated.length === models.length) return []
      return models.filter(m => !modelAttr(m, 'gate')).map(m => ({
        model: m.name, field: null,
        message: `${m.name} declares no @@gate while ${gated.length} of ${models.length} models do. ` +
          `Every level reaches it, including STRANGER.`,
      }))
    },
  },

  {
    id:         'gate-with-nothing-saying-whose-row',
    confidence: 'likely',
    word:       '@@allow',
    title:      'a gate with no row policy',
    blurb:      'A @@gate is per MODEL: it answers *may a caller at this level do this at all*, ' +
                'never *to which rows*. Without a @@allow beside it, a caller who clears the gate ' +
                'reaches every row in the table — which is right for a catalogue and wrong for ' +
                'anything belonging to somebody. Nothing in a schema distinguishes those two, so ' +
                'this raises only where litestone can SEE the rows belong to someone: a relation ' +
                'to the @@auth model, or the tenant column. Everywhere else it asks.',
    run(schema) {
      const authModel = authored(schema).find(m => modelAttr(m, 'auth'))?.name ?? null
      const claim     = schema.tenancy?.column ?? schema.tenancy?.claim ?? null

      const out = []
      for (const model of authored(schema)) {
        const gate = modelAttr(model, 'gate')
        if (!gate) continue
        const policied = (model.attributes ?? []).some(a => a.kind === 'allow' || a.kind === 'deny')
        if (policied) continue
        // A model only reachable from a system context has no *whose row* to
        // answer — nothing below level 8 reaches it either way.
        if (/^8|^9/.test(String(gate.value ?? ''))) continue

        // Owned means structurally owned, never name-shaped: a relation whose
        // target is the principal, or the column the tenancy block names.
        // `Product` in a shop schema has neither, and every caller reading every
        // product is what a catalogue IS.
        const owned = (model.fields ?? []).some(f =>
          (authModel && f.type?.name === authModel) || (claim && f.name === claim))

        out.push({ model: model.name, field: null,
          confidence: owned ? 'likely' : 'possible',
          message: owned
            ? `${model.name} is @@gate("${gate.value}"), carries the row's owner, and declares no ` +
              `@@allow — so any caller who clears the gate reads and writes everybody's rows.`
            : `${model.name} is @@gate("${gate.value}") and declares no @@allow, so a caller who ` +
              `clears the gate reaches every row. Right for a catalogue; worth stating either way.` })
      }
      return out
    },
  },

  {
    id:         'format-column-with-no-validator',
    confidence: 'likely',
    word:       '@email',
    title:      'a column named for a format nothing checks',
    blurb:      'A validator is one word and it reaches all three realms: the write is refused at ' +
                'the Data boundary, the JSON Schema carries the keyword, and a generated form gets ' +
                'the right input type before anyone submits it.',
    run(schema) {
      const BY_NAME = [
        { re: /^(email|emailAddress|contactEmail)$/i, attr: 'email', word: '@email' },
        { re: /^(url|website|homepage|link|href)$/i,  attr: 'url',   word: '@url'   },
        { re: /^(phone|phoneNumber|mobile|tel)$/i,    attr: 'phone', word: '@phone' },
      ]
      const out = []
      for (const model of authored(schema))
        for (const f of model.fields ?? []) {
          if (scalarOf(f) !== 'String') continue
          const hit = BY_NAME.find(b => b.re.test(f.name))
          if (!hit || has(f, hit.attr)) continue
          out.push({ model: model.name, field: f.name, word: hit.word,
            message: `${model.name}.${f.name} is an unvalidated String. @${hit.attr} refuses a bad ` +
              `value at the write and gives the generated form the right control.` })
        }
      return out
    },
  },

  {
    id:         'enum-column-with-no-state-machine',
    confidence: 'possible',
    word:       '@@transitions',
    title:      'a lifecycle column any write can set to anything',
    blurb:      'An enum named for a state is usually a lifecycle, and without @@transitions every ' +
                'value is reachable from every other: a cancelled order goes back to draft, a ' +
                'refunded one to paid. The attribute is also where a per-move @gate lives, which ' +
                'is the only way to say *an admin may cancel and a customer may not*.',
    run(schema) {
      const NAMES = /^(status|state|stage|phase|lifecycle)$/i
      const out = []
      for (const model of authored(schema)) {
        const declared = new Set((model.attributes ?? [])
          .filter(a => a.kind === 'transitions').map(a => a.field))
        for (const f of model.fields ?? []) {
          if (!NAMES.test(f.name) || declared.has(f.name)) continue
          if (!(schema.enums ?? []).some(e => e.name === f.type?.name)) continue
          out.push({ model: model.name, field: f.name,
            message: `${model.name}.${f.name} is an enum lifecycle with no @@transitions, so any ` +
              `write may set any value from any other.` })
        }
      }
      return out
    },
  },

  {
    id:         'json-column-with-no-shape',
    confidence: 'possible',
    word:       '@type',
    title:      'a Json column nothing describes',
    blurb:      'A Json column with no @type is the one place the schema stops. Nothing validates ' +
                'a write, the JSON Schema emits `{}`, and a generated form falls to a raw document ' +
                'editor. A `type T { … }` costs a few lines and gives all three back. Genuinely ' +
                'free-form documents exist — this is the shape worth a second look, not a defect.',
    run(schema) {
      const out = []
      for (const model of authored(schema))
        for (const f of model.fields ?? []) {
          if (scalarOf(f) !== 'Json' || has(f, 'type')) continue
          out.push({ model: model.name, field: f.name,
            message: `${model.name}.${f.name} is an undescribed Json column. \`type\` names its ` +
              `shape and @type(Name) binds it, which validates the write and generates a form.` })
        }
      return out
    },
  },

  {
    id:         'field-group-repeated-across-models',
    confidence: 'possible',
    word:       'trait',
    title:      'the same columns written out in model after model',
    blurb:      'A trait is spliced at parse and erased, so nothing downstream knows it existed — ' +
                'which means adopting one changes no DDL, no client and no generated type. What it ' +
                'buys is that the next change to those columns happens once.',
    run(schema) {
      // A @@trait use is spliced and ERASED at parse — `nothing downstream knows
      // it existed` is the feature — so a model that already uses one is
      // indistinguishable here from one that wrote the columns out. What DOES
      // survive is the declaration, so a cohort covered by a declared trait is
      // a trait already doing its job.
      const models = authored(schema)
      if (models.length < 3) return []
      const declared = (schema.traits ?? []).map(t => new Set((t.fields ?? []).map(f => f.name)))

      // A column is its NAME and its type. Two models holding `createdAt
      // DateTime` are the same column; one holding `createdAt String` is not,
      // and a trait could not cover both.
      const key = f => `${f.name}:${f.type?.name}${f.type?.optional ? '?' : ''}`
      const where = new Map()
      for (const m of models)
        for (const f of m.fields ?? []) {
          if (isRelation(f, schema) || has(f, 'id')) continue
          ;(where.get(key(f)) ?? where.set(key(f), []).get(key(f))).push(m.name)
        }

      // Group the columns that appear in exactly the same set of models: a
      // trait is a GROUP, and reporting `createdAt` and `updatedAt` separately
      // says the same thing twice and names neither shape.
      const byCohort = new Map()
      for (const [col, owners] of where) {
        if (owners.length < 3) continue
        const cohort = [...owners].sort().join(',')
        ;(byCohort.get(cohort) ?? byCohort.set(cohort, []).get(cohort)).push(col)
      }

      const out = []
      for (const [cohort, cols] of byCohort) {
        if (cols.length < 2) continue
        const names = cols.map(c => c.split(':')[0])
        if (declared.some(t => names.every(n => t.has(n)))) continue
        const owners = cohort.split(',')
        out.push({ model: owners[0], field: null,
          message: `${names.join(', ')} appear together in ` +
            `${owners.length} models (${owners.slice(0, 4).join(', ')}` +
            `${owners.length > 4 ? ', …' : ''}). A trait declares them once.` })
      }
      return out
    },
  },

  {
    id:         'text-model-with-no-search',
    confidence: 'possible',
    word:       '@@fts',
    title:      'a model people will want to search, with no index for it',
    blurb:      'Two or more prose columns and no @@fts means search is a LIKE over the table, ' +
                'which is what an application writes when the schema offers nothing. FTS5 is one ' +
                'attribute and brings search(), ranking, highlight() and snippet() with it.',
    run(schema) {
      const PROSE = /^(title|name|description|body|content|summary|notes?|excerpt|subtitle|headline)$/i
      const out = []
      for (const model of authored(schema)) {
        if (modelAttr(model, 'fts')) continue
        const cols = (model.fields ?? []).filter(f =>
          scalarOf(f) === 'String' && PROSE.test(f.name) &&
          !has(f, 'encrypted') && !has(f, 'hashed') && !has(f, 'guarded'))
        if (cols.length < 2) continue
        out.push({ model: model.name, field: null,
          message: `${model.name} carries ${cols.map(f => f.name).join(' and ')} and no @@fts. ` +
            `search() is a 400 naming the attribute until one is declared.` })
      }
      return out
    },
  },

  {
    id:         'an-open-window-with-nothing-holding-it-open-once',
    confidence: 'likely',
    word:       '@@unique',
    title:      'effective dating with two open windows',
    blurb:      'A from/to pair whose `to` is nullable is a validity window, and the row with a ' +
                'null `to` is the one in force. Nothing says there may be only ONE of those per ' +
                'parent, so a second open window is accepted by the table and the as-at read then ' +
                'has two answers and picks one. `@@unique([parentId], where: <to> == null)` is the ' +
                'constraint — a predicate cannot ride a table constraint, so it emits a standalone ' +
                'partial unique index and does not make the relation one-to-one.',
    run(schema) {
      // The STEM is the vocabulary and not any from/to pair. `periodStart` and
      // `periodEnd` on an invoice line are a service period — two lines with a
      // null end are ordinary, and a rule that reported them would fire on
      // every billing schema. A window is what `effective`/`valid`/`active`
      // name, which is the spelling the language's own docs use.
      const OPEN  = /^(effective|valid|active)(To|End|Until|Through)$/i
      const CLOSE = /^(effective|valid|active)(From|Start|Since)$/i
      const out = []
      for (const model of authored(schema)) {
        const fields = model.fields ?? []
        // The pair has to share a stem, or `startsAt` and `deletedAt` read as a
        // window. Both halves stored, and the `to` optional — a required one is
        // a closed period rather than a window with a row in force.
        const pairs = []
        for (const f of fields) {
          const m = OPEN.exec(f.name)
          if (!m || !isOptional(f) || !isStored(f)) continue
          if (!fields.some(g => CLOSE.exec(g.name)?.[1]?.toLowerCase() === m[1].toLowerCase() && isStored(g))) continue
          pairs.push(f)
        }
        if (!pairs.length) continue

        // A window is per PARENT, so a model with no relation is a single
        // timeline and needs no constraint to hold one row open.
        const parents = fields.filter(f => isRelation(f, schema))
        if (!parents.length) continue

        for (const to of pairs) {
          const guarded = (model.attributes ?? []).some(a =>
            a.kind === 'partialUnique' && a.whereSql?.includes(`"${fieldColumn(model, to.name)}"`))
          if (guarded) continue
          out.push({ model: model.name, field: to.name,
            message: `${model.name}.${to.name} is nullable beside its own start column, so the row ` +
              `with no ${to.name} is the one in force — and nothing stops there being two. ` +
              `@@unique([${parents[0].name}Id], where: ${to.name} == null) is what holds one open.` })
        }
      }
      return out
    },
  },

  {
    id:         'a-document-priced-through-a-relation',
    confidence: 'possible',
    word:       '@immutable',
    title:      'a document that reads its price out of the catalogue',
    blurb:      'A price, a rate or a fee on a document is a value AT AN INSTANT. Reached through ' +
                'a relation it is the value NOW, so moving the catalogue price silently reprices ' +
                'every historical receipt — the one bug in this class that nothing raises and ' +
                'nobody reports, because both readings look correct. The fix is a column on the ' +
                'document holding what was charged, @immutable once the document is issued.',
    run(schema) {
      const priced = new Set(authored(schema)
        .filter(m => (m.fields ?? []).some(f => has(f, 'money') || has(f, 'scale')))
        .map(m => m.name))
      if (!priced.size) return []

      const out = []
      for (const model of authored(schema)) {
        const fields = model.fields ?? []
        if (fields.some(f => has(f, 'money') || has(f, 'scale'))) continue

        // Document-shaped: something about this row is meant to stand. A basket
        // line legitimately reads the live price, and it declares none of these.
        const isDocument = (model.attributes ?? []).some(a => a.kind === 'transitions' || a.kind === 'log')
          || fields.some(f => has(f, 'immutable') || has(f, 'sealed'))
        if (!isDocument) continue

        // belongsTo ONLY. A hasMany is the other direction — `Customer.orders`
        // does not read a price through anything — and matching it reported
        // seven findings on `example`, every one of them backwards.
        // A header whose LINES hold the amounts holds them. `JournalEntry` has
        // no money column and is not underpriced — `JournalLine` is where the
        // debits are, one level down, which is the ordinary document shape.
        const pricedChild = authored(schema).some(child =>
          (child.fields ?? []).some(f => f.type?.name === model.name
            && f.attributes?.some(a => a.kind === 'relation' && a.fields?.length))
          && (child.fields ?? []).some(f => has(f, 'money') || has(f, 'scale')))
        if (pricedChild) continue

        const via = fields.find(f =>
          priced.has(f.type?.name) && f.attributes?.some(a => a.kind === 'relation' && a.fields?.length))
        if (!via) continue

        // A price that cannot move cannot reprice anything. An @immutable amount,
        // or a target that is itself a dated version, is the correct shape here —
        // `example`'s Subscription reads PlanVersion for exactly that reason.
        const target = authored(schema).find(m => m.name === via.type.name)
        const amounts = (target.fields ?? []).filter(f => has(f, 'money') || has(f, 'scale'))
        const frozen  = amounts.every(f => has(f, 'immutable'))
          || (target.fields ?? []).some(f => /^(effective|valid|active)(From|To)$/i.test(f.name))
        if (frozen) continue

        out.push({ model: model.name, field: via.name,
          message: `${model.name} reads its price through ${via.name} (${via.type.name}) and holds ` +
            `no amount of its own, so a change to ${via.type.name} reprices every ${model.name} ` +
            `already written.` })
      }
      return out
    },
  },

  {
    id:         'a-standing-spelled-on-the-global-row',
    confidence: 'possible',
    word:       '@@tenant',
    title:      'a role column that means one thing in every tenant',
    blurb:      'Under `tenancy { strategy row }` the @@auth model spans tenants, so a role or ' +
                'standing column on it is one answer everywhere — the person who administers one ' +
                'workspace administers all of them. A standing that varies per tenant belongs on ' +
                'the membership row, which is the model already carrying both the person and the ' +
                'tenant. Genuinely global standings exist and this is the shape worth a second ' +
                'look, not a defect.',
    run(schema) {
      if (schema.tenancy?.strategy !== 'row') return []
      const authModel = authored(schema).find(m => modelAttr(m, 'auth'))
      if (!authModel) return []

      // The lifecycle stages the framework itself reads are not roles: absent
      // means the app does not model that stage, and they are per PERSON by
      // construction. A rule that reported them would fire on every app.
      const LIFECYCLE = /^(emailVerified|verifiedAt|activatedAt|deletedAt)$/
      const ROLE      = /^(role|isAdmin|isOwner|isStaff|isManager|isEditor|permissions|capabilities)$/i

      // The model carrying both the person and the tenant, if there is one.
      const membership = authored(schema).find(m =>
        m !== authModel
        && (m.fields ?? []).some(f => f.type?.name === authModel.name)
        && (m.fields ?? []).some(f => f.name === schema.tenancy.column))

      const out = []
      for (const f of authModel.fields ?? []) {
        if (LIFECYCLE.test(f.name) || !ROLE.test(f.name) || !isStored(f)) continue
        const alsoThere = membership && (membership.fields ?? []).some(g => g.name === f.name)
        out.push({ model: authModel.name, field: f.name,
          confidence: alsoThere ? 'likely' : 'possible',
          message: alsoThere
            ? `${authModel.name}.${f.name} and ${membership.name}.${f.name} are two spellings of one ` +
              `standing, and only the second can differ per tenant. Whichever the policies read, ` +
              `the other is answering as well.`
            : `${authModel.name}.${f.name} is on a model that spans tenants, so it is one answer in ` +
              `every one of them. A standing that varies per tenant belongs on the membership row.` })
      }
      return out
    },
  },
]

/**
 * Every opportunity, over one schema.
 *
 * A finding may name its own `word` where one check covers several — the inert
 * column is `@@softDelete` or `@@hasTemplates` depending which column it found —
 * and the check's own word is the default.
 */
export function checkOpportunities(schema) {
  const out = []
  for (const o of OPPORTUNITIES)
    for (const finding of o.run(schema) ?? [])
      out.push({
        id: o.id, confidence: finding.confidence ?? o.confidence, title: o.title,
        ...finding,
        word: finding.word ?? o.word,
      })
  return out
}

/**
 * The catalog row an opportunity points at — what `explain` would print.
 *
 * `word` is the word AS TYPED, prefix included, because nine words exist at two
 * levels and a route has to land on one: `@type` binds a shape to a column and
 * `type` declares the shape, and printing `litestone explain type` for the
 * first one sends the reader to the wrong card by luck rather than by design.
 */
export function wordFor(finding) {
  return lookup(finding.word) ?? null
}
