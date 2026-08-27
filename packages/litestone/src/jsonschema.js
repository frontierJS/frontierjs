// jsonschema.js — Generate JSON Schema (draft-07) from a Litestone schema.
//
// Usage:
//   import { generateJsonSchema } from '@frontierjs/litestone'
//   const schema = generateJsonSchema(parseResult.schema, options)
//
// Or via CLI:
//   litestone jsonschema                        → ./schema.json, beside the .lite
//   litestone jsonschema --out=./schemas/
//   litestone jsonschema --format=flat          → every definition at the root
//   litestone jsonschema --format=definitions   → $defs with $ref (default)
//
// docs/jsonschema.md is the full key reference — every key this file can emit,
// which mode and audience produces it, and who reads it.
//
// ─── Output shape (format=definitions) ───────────────────────────────────────
//
// $defs is keyed by MODEL name (PascalCase) and holds everything a $ref can
// point at — models, enums, `type T` declarations, and FileRef when any model
// has a File field. It travels whole or the refs dangle.
//
// {
//   "$schema": "https://json-schema.org/draft-07/schema",
//   "$defs": {
//     "User": {
//       "type": "object",
//       "title": "User",
//       "properties": { "plan": { "$ref": "#/$defs/Plan" } },
//       "required": [...],
//       "additionalProperties": false
//     },
//     "Plan": { "type": "string", "enum": ["starter", "pro", "enterprise"], "title": "Plan" }
//   }
// }
//
// ─── Output shape (format=flat) ───────────────────────────────────────────────
//
// The same entries, at the document root instead of under $defs. $refs still
// read "#/$defs/Plan" — consumers here resolve them by name, not by pointer.
//
// {
//   "$schema": "...",
//   "User": { "type": "object", ... },
//   "Plan": { "type": "string", "enum": [...] }
// }
//
// ─── Type mappings ────────────────────────────────────────────────────────────
//
//  Litestone   JSON Schema type
//  ─────────── ──────────────────────────────────────────────────────────────
//  String      string
//  Int         integer
//  Float       number
//  Boolean     boolean
//  DateTime    string  + format: date-time  + @datetime validator implicit
//  Json        {}  (any — JSON Schema has no opaque JSON type)
//  Bytes       string  + contentEncoding: base64
//  EnumName    $ref to enum definition (or inline enum array)
//
// ─── Validator mappings ───────────────────────────────────────────────────────
//
//  @email                → format: "email"
//  @url                  → format: "uri"
//  @datetime             → format: "date-time"
//  @time                 → pattern (NOT format: "time" — see applyValidators)
//  @regex(pattern)       → pattern: "pattern"
//  @length(min, max)     → minLength / maxLength
//  @gt(n)                → exclusiveMinimum: n
//  @gte(n)               → minimum: n
//  @lt(n)                → exclusiveMaximum: n
//  @lte(n)               → maximum: n
//  @startsWith(s)        → pattern: "^s"
//  @endsWith(s)          → pattern: "s$"
//  @contains(s)          → pattern: "s" (as substring)
//
// ─── What is intentionally excluded ─────────────────────────────────────────
//
//  - Relation fields (@relation) — FK integers are included but the relation
//    field itself (e.g. `account accounts`) is omitted, it has no JSON meaning
//  - @computed / @generated fields — read-only, no write validation needed
//    (computed and generated fields are emitted as readOnly in full mode)
//  - Internal fields: deletedAt — opt-in via options.includeDeletedAt
//  - @id fields — included by default (needed for update payloads)
//
// ─── Write vs Full schemas ───────────────────────────────────────────────────
//
//  By default generateJsonSchema() produces schemas for CREATE payloads:
//   - @id fields are excluded (auto-generated)
//   - required[] only lists non-optional fields that have no @default
//
//  Pass { mode: 'full' } for complete schemas including IDs and all fields.
//  Pass { mode: 'update' } for PATCH schemas (all fields optional).

/**
 * Which JSON Schema keyword each message-carrying validator compiles to.
 *
 * Mirrors the attribute→keyword mapping documented at the top of this file, and
 * exists so `x-messages` can be keyed by the keyword a consumer actually checks
 * rather than by the rule name it would then have to translate. Verified against
 * emitted output, not assumed — @gt is `exclusiveMinimum`, not `minimum`.
 *
 * A validator absent from here still publishes its message under its rule name;
 * it simply has no keyword alias. `required` is its own key either way — it is
 * not a keyword on the field at all, it lives in the model's `required` array.
 */
const MESSAGE_KEYWORDS = {
  email:      ['format'],
  url:        ['format'],
  date:       ['format'],
  datetime:   ['format'],
  // `pattern`, not `format` — see the emitter. This row said `format` for as
  // long as the emitter produced nothing at all, so an author's `@time` message
  // was keyed to a keyword no consumer could ever have checked.
  time:       ['pattern'],
  regex:      ['pattern'],
  startsWith: ['pattern'],
  endsWith:   ['pattern'],
  contains:   ['pattern'],
  length:     ['minLength', 'maxLength'],
  gte:        ['minimum'],
  gt:         ['exclusiveMinimum'],
  lte:        ['maximum'],
  lt:         ['exclusiveMaximum'],
  minItems:   ['minItems'],
  maxItems:   ['maxItems'],
  uniqueItems: ['uniqueItems'],
}

/**
 * Generate JSON Schema from a Litestone parse result schema.
 *
 * @param {object} schema        — parseResult.schema
 * @param {object} [options]
 * @param {'definitions'|'flat'}   [options.format='definitions']
 * @param {'create'|'update'|'full'} [options.mode='create']
 * @param {boolean} [options.includeDeletedAt=false]
 * @param {boolean} [options.includeTimestamps=false]   — createdAt, updatedAt
 * @param {'client'|'system'} [options.audience='client'] — 'client' omits @guarded/@secret fields;
 *                                                           'system' includes everything
 * @param {string}  [options.title]                       — top-level $schema title
 * @returns {object}  JSON Schema object (not stringified)
 */
import { parseGateString } from './plugins/gate.js'
import { TIME_PATTERNS } from './core/validate.js'
import { dependsOnClock } from './core/policy.js'
import { capabilitiesForModel } from './core/capabilities.js'

export function generateJsonSchema(schema, options = {}) {
  const {
    format            = 'definitions',
    mode              = 'create',
    includeDeletedAt  = false,
    includeTimestamps = false,
    inlineEnums       = false,   // true → emit enum values inline on each field instead of $ref
    audience          = 'client', // 'client' strips @guarded/@secret; 'system' includes them
    title,
  } = options

  // Build enum definitions first — referenced by $ref in model fields
  const enumDefs = {}
  for (const en of schema.enums) {
    // Transitions are NOT emitted here. An `enum { transitions { ... } }` block
    // is desugared onto every model that uses the enum, and the model is where a
    // per-transition @gate can exist — so x-transitions on the model def is the
    // resolved truth and the only thing a client should read. Emitting both
    // would give the UI two sources that drift the moment one model narrows.
    // `x-labels` rather than switching `enum` to `oneOf: [{const, title}]`,
    // which is the spec-compliant spelling of the same idea. The `enum` array
    // is what three readers validate against — junction's validator, sierra's
    // field-rules, the form generator — and changing its SHAPE to carry a
    // label is three chances to break validation for a presentation win.
    // Additive keeps a schema that labels nothing byte-identical to before.
    //
    // Only stated labels are emitted. A member with none is absent from the
    // map rather than present with its own name, so a reader can tell "the
    // schema says call it this" from "nobody said", and keep whatever
    // fallback it already had.
    const labels = {}
    for (const v of en.values) if (v.label !== undefined) labels[v.name] = v.label

    enumDefs[en.name] = {
      type:  'string',
      enum:  en.values.map(v => v.name),
      title: en.name,
      ...(Object.keys(labels).length ? { 'x-labels': labels } : {}),
    }
  }

  // Build type definitions for `type T { ... }` declarations. Referenced by
  // $ref from any `Json @type(T)` field. Each gets a proper object schema
  // with required keys, validators, and nested $ref for nested types.
  const typeDefs = {}
  for (const t of (schema.types ?? [])) {
    const props = {}
    const required = []
    for (const f of t.fields) {
      // Reuse fieldToJsonSchema so validators/transforms/nested @type work
      // identically inside types as on columns.
      const fs = applyPresentation(
        fieldToJsonSchema(f, schema, enumDefs, inlineEnums, audience, typeDefs), f)
      props[f.name] = fs
      if (!f.type.optional) required.push(f.name)
    }
    const def = {
      type:                 'object',
      title:                t.name,
      properties:           props,
      additionalProperties: false,    // reflects strict-by-default at the type
    }
    if (required.length) def.required = required
    typeDefs[t.name] = def
  }

  // Build model schemas
  const modelDefs = {}
  for (const model of schema.models) {
    modelDefs[model.name] = modelToJsonSchema(model, schema, enumDefs, typeDefs, { mode, includeDeletedAt, includeTimestamps, inlineEnums, audience })
  }

  // Add FileRef definition if any model has a File field
  const hasFileFields = schema.models.some(m => m.fields.some(f => f.type.name === 'File'))
  const fileRefDef = hasFileFields ? {
    FileRef: {
      type:  'object',
      title: 'FileRef',
      description: 'Litestone file reference — stored as JSON in SQLite, bytes in object storage.',
      'x-litestone-file': true,
      properties: {
        key:        { type: 'string',              description: 'Object storage key' },
        bucket:     { type: 'string',              description: 'Bucket name' },
        provider:   { type: 'string', enum: ['r2', 's3', 'b2', 'minio', 'local'], description: 'Storage provider' },
        endpoint:   { type: ['string', 'null'],    description: 'S3-compatible endpoint URL' },
        publicBase: { type: ['string', 'null'],    description: 'CDN or public URL base' },
        size:       { type: 'integer', minimum: 0, description: 'File size in bytes' },
        mime:       { type: 'string',              description: 'MIME type' },
        uploadedAt: { type: 'string', format: 'date-time', description: 'Upload timestamp' },
      },
      required: ['key', 'bucket', 'provider', 'size', 'mime', 'uploadedAt'],
      additionalProperties: false,
    }
  } : {}

  // Assemble top-level schema
  const root = {
    '$schema': 'https://json-schema.org/draft-07/schema',
  }
  if (title) root.title = title

  if (format === 'definitions') {
    root['$defs'] = { ...modelDefs, ...enumDefs, ...typeDefs, ...fileRefDef }
  } else {
    // flat — everything at root
    Object.assign(root, modelDefs, enumDefs, typeDefs, fileRefDef)
  }

  return root
}

// ─── Per-model schema ─────────────────────────────────────────────────────────

function modelToJsonSchema(model, schema, enumDefs, typeDefs, opts) {
  const { mode, includeDeletedAt, includeTimestamps, inlineEnums, audience } = opts
  const properties = {}
  const required   = []

  // Detect row-level policies on this model
  const hasPolicies = model.attributes.some(a => a.kind === 'allow' || a.kind === 'deny')

  for (const field of model.fields) {
    // Skip relation fields — they have no JSON representation.
    //
    // implicitM2M belongs here too. It is set by the parser's second pass for
    // `tags Category[]`, and it used to fall through to typeToJsonSchema, where
    // `type.array` made it `{type:'array', items:{type:'string'}}` — a wire
    // shape the relation does not have. Worse, being non-optional with no
    // @default put it in `required[]`, so every consumer of this schema
    // demanded a relation array on create: Junction's autoValidate rejected
    // payloads without it, and Sierra's make() seeded a meaningless `[]`.
    // The relation is still described, structurally, in x-relations below.
    if (field.type.kind === 'relation' || field.type.kind === 'implicitM2M') continue

    // ── Virtual / derived fields — emit as readOnly with x-litestone-kind ──
    // These are real fields in query results but have no DB column and cannot
    // be written. Emit them so consumers know they exist.
    const fromAttr = field.attributes.find(a => a.kind === 'from')
    if (fromAttr) {
      if (mode !== 'create' && mode !== 'update') {
        const fs = fieldToJsonSchema(field, schema, enumDefs, inlineEnums, audience, typeDefs)
        properties[field.name] = { ...fs, readOnly: true, 'x-litestone-kind': 'from',
          'x-litestone-from': { target: fromAttr.target, op: fromAttr.op } }
      }
      continue
    }

    // ── @derived — readOnly, and it says whether it goes stale on its own ───
    //
    // A flag, deliberately, not the expression. A consumer needs to know two
    // things and only two: this value is not something you write, and — when
    // `x-litestone-volatile` is set — it depends on the clock, so the copy you
    // are holding can become wrong with no write, no event and nothing to
    // announce it. Shipping the expression instead would invite a third
    // implementation of the language in the browser; the server's answer is the
    // only one, and this says how long to trust it.
    const derivedAttr = field.attributes.find(a => a.kind === 'derived')
    if (derivedAttr) {
      if (mode !== 'create' && mode !== 'update') {
        const fs = fieldToJsonSchema(field, schema, enumDefs, inlineEnums, audience, typeDefs)
        properties[field.name] = { ...fs, readOnly: true, 'x-litestone-kind': 'derived' }
        if (dependsOnClock(derivedAttr.expr)) properties[field.name]['x-litestone-volatile'] = 'clock'
      }
      continue
    }

    // ── @version — readOnly everywhere, present in update ───────────────────
    // A caller never chooses the value: create writes 1, every write bumps it.
    // But an update must CARRY the one it read, so unlike a computed field it
    // stays in the update schema — readOnly so a generated form round-trips it
    // instead of rendering a number input, and never required on create.
    if (field.attributes.some(a => a.kind === 'version')) {
      if (mode !== 'create') {
        const fs = fieldToJsonSchema(field, schema, enumDefs, inlineEnums, audience, typeDefs)
        properties[field.name] = { ...fs, readOnly: true, 'x-litestone-kind': 'version' }
      }
      continue
    }

    // ── @transient — the mirror of @computed, so the mode test is mirrored ──
    // A computed field is emitted in the READ modes and absent from the write
    // ones; a transient field is emitted in the WRITE modes and absent from the
    // read ones, because it is never in a result.
    //
    // It falls through rather than being emitted here: the label, the
    // per-rule messages and the required list are what a caller sending this
    // field most needs, and they are added below. `writeOnly` goes on beside
    // `readOnly`, which is the keyword pair this is one half of.
    const isTransient = field.attributes.some(a => a.kind === 'transient')
    if (isTransient && mode !== 'create' && mode !== 'update') continue

    const isComputed  = field.attributes.find(a => a.kind === 'computed')
    const isGenerated = field.attributes.find(a => a.kind === 'generated' || a.kind === 'funcCall')
    if (isComputed || isGenerated) {
      if (mode !== 'create' && mode !== 'update') {
        const fs = fieldToJsonSchema(field, schema, enumDefs, inlineEnums, audience, typeDefs)
        const kind = isComputed ? 'computed' : 'generated'
        properties[field.name] = { ...fs, readOnly: true, 'x-litestone-kind': kind }
      }
      continue
    }

    // Skip deletedAt unless opted in
    if (field.name === 'deletedAt' && !includeDeletedAt) continue

    // Skip timestamp fields unless opted in
    if ((field.name === 'createdAt' || field.name === 'updatedAt') && !includeTimestamps) continue

    // Skip @id in create mode (server-assigned)
    const isId = field.attributes.find(a => a.kind === 'id')
    if (isId && mode === 'create') continue

    // @guarded(all) / @secret fields — excluded for client audience entirely
    const isGuardedAll = field.attributes.some(a => a.kind === 'guarded' && a.level === 'all')
                      || field.attributes.some(a => a.kind === 'secret')
    if (isGuardedAll && audience === 'client') continue

    // @guarded (level: 'select') — excluded from write schemas for client audience
    // These fields are readable via explicit select but not writable by clients
    const isGuarded = field.attributes.some(a => a.kind === 'guarded' && a.level === 'select')
    if (isGuarded && audience === 'client' && (mode === 'create' || mode === 'update')) continue

    const fieldSchema = fieldToJsonSchema(field, schema, enumDefs, inlineEnums, audience, typeDefs)

    // @hashed — writable, never readable. `writeOnly` is the standard keyword for
    // exactly this, and it is the one protection where the read side cannot be
    // unlocked by anything, so a form generator can render an input and must never
    // render a value. NOT excluded from the client audience like @guarded: a
    // password is submitted by the person it belongs to.
    if (field.attributes.some(a => a.kind === 'hashed')) fieldSchema.writeOnly = true

    // Inject doc comment as "description"
    if (field.comments?.length) {
      fieldSchema.description = field.comments.join(' ')
    }

    applyPresentation(fieldSchema, field)

    // @allow('read', expr) — field is conditionally visible; mark as optional + annotate
    const readAllows = field.attributes.filter(a => a.kind === 'fieldAllow' && a.operations.includes('read'))
    if (readAllows.length && audience === 'client') {
      fieldSchema['x-litestone-read-policy'] = true
      // Always treat as optional in the schema — value may be absent depending on auth
      if (!field.type.optional) {
        const adjusted = Object.assign({}, fieldSchema)
        delete adjusted['x-litestone-read-policy']
        properties[field.name] = { anyOf: [adjusted, { type: 'null' }], 'x-litestone-read-policy': true }
        continue
      }
    }

    // @system — readable by anyone, written by the application rather than by
    // its caller. `readOnly` is the standard keyword and the one Sierra's
    // control table already skips, so a generated form stops offering a text
    // box whose value a worker overwrites a second later.
    // A column the TENANCY declaration stamps is the same case wearing a
    // different annotation: `tenancy { strategy row }` desugars a
    // `@default(auth().<claim>)`, the Data boundary fills it from the
    // principal, and a client naming its own tenant is a client choosing its
    // own tenant — refused by the generated rule. Leaving it writable was not
    // just untidy: `make()` seeds every writable column, blank-strip turns the
    // seed into an explicit `null`, and a stated null is a VALUE, so the
    // default never applied and the write came back 400 `must be a string`.
    // Being out of `required` was not enough to save it (`FJS-387`).
    //
    // `@@tenant(none)` carries no generated default, so a model where the
    // column IS a caller-supplied value is untouched.
    const tenancyStamped = field.attributes.some(
      a => a.kind === 'default' && a.generated === 'tenancy')

    const isSystemWritten = field.attributes.some(a => a.kind === 'system') || tenancyStamped
    if (isSystemWritten) {
      fieldSchema.readOnly = true
      fieldSchema['x-litestone-kind'] = tenancyStamped ? 'tenancy' : 'system'
    }

    // @transient — accepted on the wire, stored nowhere. The write-mode-only
    // half is decided above; this is what says so to a consumer, which is how a
    // generated form knows to offer a control for a value no read answers.
    if (isTransient) {
      fieldSchema.writeOnly = true
      fieldSchema['x-litestone-kind'] = 'transient'
    }

    // ── x-values ─────────────────────────────────────────────────────────
    // The binding: which named list this column draws from, and how legal a
    // value outside it is. Resolved here rather than on the client, so the
    // browser is handed the model and the two columns and never has to read a
    // `valueset` declaration it does not have. `strength` travels because it
    // decides the control — `open` gets one that can add, `suggested` one that
    // takes free text — but it is an affordance there and the check is at the
    // Data boundary, like `x-gate` (Invariant 6).
    const bind = field.attributes.find(a => a.kind === 'values')
    if (bind) {
      const vs = (schema.valuesets ?? []).find(v => v.name === bind.set)
      if (vs) fieldSchema['x-values'] = {
        set:      vs.name,
        strength: bind.strength,
        model:    vs.source,
        value:    vs.valueField,
        label:    vs.labelField ?? vs.valueField,
        // Every narrowing the set applies, as NAMES. A declared `@@scope` is
        // one; a declared `where` is SQL and mints a scope named after the set,
        // so both cross the same way and a picker asks for the same rows the
        // Data boundary will accept. The predicates themselves never travel —
        // a browser may not send SQL and does not need to (Invariant 8).
        ...(vs.scopes?.length ? { scopes: vs.scopes } : {}),
      }
    }

    properties[field.name] = fieldSchema

    // Required: non-optional, no @default, not in update mode
    if (mode !== 'update') {
      const hasDefault = field.attributes.find(a => a.kind === 'default')
      // @default(auth().field) is auto-stamped — not required in API payloads
      const isAuthDefault = hasDefault?.value?.kind === 'call' && hasDefault?.value?.fn === 'auth'
      // A @system column is never required OF THE CALLER. It is still NOT NULL
      // in SQLite, so a service that forgets to fill it fails at the write —
      // loud, at the layer that owns the value. Listing it here instead made
      // the browser refuse before the request, naming fields the caller was
      // never meant to send: basecamp's ApiKey has three of them, and every
      // create was refused with "the button does nothing" (FJS-095).
      if (isSystemWritten) {
        // nothing — the application fills it
      } else if (!field.type.optional && !hasDefault && !isId) {
        // A required @transient field lands here like any other, and this is
        // the only layer that can hold the rule: there is no column, so no
        // NOT NULL catches a caller who omitted it.
        required.push(field.name)
      } else if (hasDefault && isAuthDefault && !field.type.optional) {
        // auth() default: field not required in create payload but not optional either
        // Don't add to required[] — Junction will stamp it from auth context
      }
    }
  }

  const result = {
    type:       'object',
    title:      model.name,
    ...(model.comments?.length ? { description: model.comments.join(' ') } : {}),
    properties,
    additionalProperties: false,
  }

  if (required.length) result.required = required

  // Annotate models with row-level policies so Junction knows to enforce them
  if (hasPolicies) result['x-litestone-policies'] = true

  // ── x-version ──────────────────────────────────────────────────────────────
  // Names the column an update must carry back. One string, so a client knows
  // which field to round-trip without scanning properties for a readOnly Int.
  const versionField = model.fields.find(f => f.attributes.some(a => a.kind === 'version'))
  if (versionField) result['x-version'] = versionField.name

  // ── x-label-field ──────────────────────────────────────────────────────────
  // Which column a picker SHOWS for a row of this model — FHIR's `display`.
  // A field NAME, not a caption: `x-labels` on an enum def maps value → label,
  // and this is the other question. Emitted on every mode, because which column
  // identifies a row does not depend on whether you are writing one.
  const labelAttr = model.attributes.find(a => a.kind === 'labelField')
  if (labelAttr) result['x-label-field'] = labelAttr.field

  // ── x-gate ─────────────────────────────────────────────────────────────────
  // Emitted when the model has @@gate — structural metadata, emitted on all modes.
  // Consumers (FJSChain DB panel, gap analysis) read gate levels without raw schema.
  const gateAttr = model.attributes.find(a => a.kind === 'gate')
  if (gateAttr) {
    const gate = parseGateString(gateAttr.value)
    result['x-gate'] = {
      read:   gate.read,
      create: gate.create,
      update: gate.update,
      delete: gate.delete,
    }
  }

  // ── x-capabilities ─────────────────────────────────────────────────────────
  // Which of this model's actions need a grant, so a screen can render exactly
  // the buttons this caller could actually press. An AFFORDANCE and never a
  // boundary, like `x-gate` beside it (Invariant 6): what a browser believes
  // changes nothing about what the Data boundary does.
  //
  // Names rather than a verdict — the CALLER's set is on the principal, not in
  // the schema, so this says which capability each action requires and the
  // client compares. `read` is absent unless the model wrote `@@capabilities(all)`,
  // which is exactly the shape of the declaration: absent means nothing is
  // required, not that reading is refused.
  //
  // A move already appears in `x-transitions` and a column in the field's own
  // schema; carrying the capability NAME here, in one place, is what stops a
  // client from rebuilding `Model.action` by string concatenation — the one
  // spelling that must never be guessed, since a wrong guess is an affordance
  // that silently never matches.
  // Derived, never rebuilt. This file used to re-expand the three kinds itself
  // and got the machine-move filter wrong — it read the gate and not `@system`,
  // so a browser was offered five grants the boundary never consults. That is
  // the third author one rule collected (Invariant 4); `capabilitiesForModel`
  // is the only one now.
  const derived = capabilitiesForModel(model)
  if (derived.length) {
    const operations = {}, moves = {}, columns = {}
    for (const c of derived) {
      if (c.kind === 'operation') operations[c.target] = c.name
      if (c.kind === 'move')      moves[c.target]      = c.name
      if (c.kind === 'column')    columns[c.target]    = c.name
    }
    result['x-capabilities'] = { operations, moves, columns }
  }

  // ── x-transitions ──────────────────────────────────────────────────────────
  // The model's state machines, keyed by field (a model can have more than one
  // status column). This is what lets the UI render exactly the legal buttons
  // for a record without hand-written logic — see sierra's
  // resource.transitions(row, level). `gate` and `system` are UI affordances
  // only: the move is enforced at the Data boundary regardless of what the
  // client believes. `system` says the APPLICATION makes this move, so no
  // caller's level changes the answer and a screen renders no button rather
  // than a disabled one — always present rather than only when true, so a
  // reader tests a boolean instead of distinguishing false from absent.
  const transitionAttrs = model.attributes.filter(a => a.kind === 'transitions')
  if (transitionAttrs.length) {
    result['x-transitions'] = Object.fromEntries(
      transitionAttrs.map(a => [
        a.field,
        Object.fromEntries(
          Object.entries(a.transitions).map(([name, { from, to, gate, system }]) =>
            [name, { from, to, gate: gate ?? null, system: Boolean(system) }])
        ),
      ])
    )
  }

  // ── x-relations ─────────────────────────────────────────────────────────────
  // Relation fields are excluded from properties (no wire representation) but
  // their structural meaning is useful for relation panels + useProjectMap.
  // Correction from spec: implicitM2M is a real type.kind in this AST,
  // set by the parser's second-pass validation (field.type.kind = 'implicitM2M').
  const relations = []
  for (const field of model.fields) {
    const kind = field.type.kind
    if (kind !== 'relation' && kind !== 'implicitM2M') continue

    if (kind === 'implicitM2M') {
      relations.push({
        field: field.name,
        model: field.type.name,
        type:  'm2m',
      })
      continue
    }

    // Explicit @relation — belongsTo (has FK fields) or hasMany (no FK fields)
    const relAttr = field.attributes.find(a => a.kind === 'relation')
    const fields     = relAttr?.fields     ? (Array.isArray(relAttr.fields)     ? relAttr.fields     : [relAttr.fields])     : []
    const references = relAttr?.references ? (Array.isArray(relAttr.references) ? relAttr.references : [relAttr.references]) : []
    relations.push({
      field:      field.name,
      model:      field.type.name,
      type:       fields.length ? 'belongsTo' : 'hasMany',
      fields,
      references,
      onDelete:   relAttr?.onDelete ?? null,
      optional:   field.type.optional,
    })
  }
  if (relations.length) result['x-relations'] = relations

  return result
}

// ─── Per-field schema ─────────────────────────────────────────────────────────

/**
 * What a field is CALLED and what it says when it refuses — onto its schema.
 *
 * Split out because it has two callers and used to have one. A `type T { … }`
 * field went through fieldToJsonSchema for its structure and never through
 * this, so `@label` and an authored validator message were emitted for a model
 * column and silently dropped for the identical declaration inside a type —
 * every realm then wrote the default sentence over the author's, for a nested
 * `Json @type(T)` value and for a custom method's declared input alike.
 *
 * @label("Customer") → JSON Schema `title`, the standard slot for a
 * human-readable name. Every realm builds its generated messages from this
 * rather than the column, so an error stops reading `customerId` under a form
 * label that says "customer".
 *
 * Messages are keyed BOTH by the rule name ('length', 'gte', 'required') and by
 * the JSON Schema keyword it compiles to ('minLength', 'minimum', …). One
 * authored string, several lookup aliases — never two sources. Keying by
 * keyword is the point: a consumer checking `minLength` looks up `minLength`.
 * The alternative — publish the rule name and make each consumer map
 * keyword→rule — puts the same table in Junction AND Sierra, and this file
 * already owns that translation.
 */
function applyPresentation(fieldSchema, field) {
  const label = field.attributes.find(a => a.kind === 'label')
  if (label?.text) fieldSchema.title = label.text

  const messages = {}
  for (const attr of field.attributes) {
    if (typeof attr?.message !== 'string' || !attr.message) continue
    messages[attr.kind] = attr.message
    for (const kw of MESSAGE_KEYWORDS[attr.kind] ?? []) messages[kw] = attr.message
  }
  if (Object.keys(messages).length) fieldSchema['x-messages'] = messages

  return fieldSchema
}

function fieldToJsonSchema(field, schema, enumDefs, inlineEnums = false, audience = 'client', typeDefs = null) {
  const { name, type, attributes } = field
  const result = {}

  // Handle optional — wrap in anyOf with null, or just mark nullable
  // JSON Schema draft-07 uses { type: [..., 'null'] } for nullable
  const nullable = type.optional

  // Json @type(T) — reference the named type's schema instead of the
  // permissive {} that an untyped Json column gets. Carries shape, required
  // keys, validators, the works. When typeDefs hasn't been built (callers
  // that haven't wired it through), falls back to {}.
  let typeSchema
  const typeAttr = attributes.find(a => a.kind === 'type')
  if (type.name === 'Json' && typeAttr && typeDefs && typeDefs[typeAttr.name]) {
    // strict: false → loose schema (allow extras); strict (default) → tight.
    typeSchema = { '$ref': `#/$defs/${typeAttr.name}` }
  } else {
    // Base type schema
    typeSchema = typeToJsonSchema(type, schema, enumDefs, inlineEnums)
  }

  // Apply validators from attributes
  applyValidators(typeSchema, attributes)

  // Apply @default as JSON Schema default (skip auth() — runtime-only)
  const defaultAttr = attributes.find(a => a.kind === 'default')
  if (defaultAttr) {
    const dv = defaultValueToJson(defaultAttr.value, type)
    if (dv !== undefined) typeSchema.default = dv
  }

  // Annotate @guarded / @secret fields in system audience schemas
  if (audience === 'system') {
    const isGuarded = attributes.some(a => a.kind === 'guarded')
    const isSecret  = attributes.some(a => a.kind === 'secret')
    if (isSecret)  typeSchema['x-litestone-secret']  = true
    else if (isGuarded) typeSchema['x-litestone-guarded'] = true
  }

  if (nullable) {
    // Nullable: allow the type OR null
    if (Object.keys(typeSchema).length === 1 && typeSchema.type) {
      // Simple case: just add null to the type array
      result.type = [typeSchema.type, 'null']
      // Copy over any other keys (format, pattern, etc.)
      Object.assign(result, { ...typeSchema, type: [typeSchema.type, 'null'] })
    } else if (typeSchema['$ref']) {
      // Nullable $ref — use anyOf
      Object.assign(result, { anyOf: [typeSchema, { type: 'null' }] })
    } else {
      Object.assign(result, { anyOf: [typeSchema, { type: 'null' }] })
    }
  } else {
    Object.assign(result, typeSchema)
  }

  return result
}

// ─── Type mapping ─────────────────────────────────────────────────────────────

function typeToJsonSchema(type, schema, enumDefs, inlineEnums = false) {
  if (type.kind === 'enum') {
    // inlineEnums: true → emit values directly so consumers don't need $ref resolution
    // Inlining exists so a consumer need not resolve a $ref, so it has to
    // carry everything the $def would have answered — a label map left behind
    // here is a picker that reads member names under one option and human text
    // under the other, decided by a flag it never sees.
    const item = inlineEnums && enumDefs[type.name]
      ? {
          type: 'string',
          enum: enumDefs[type.name].enum,
          ...(enumDefs[type.name]['x-labels'] ? { 'x-labels': enumDefs[type.name]['x-labels'] } : {}),
        }
      : { '$ref': `#/$defs/${type.name}` }
    // An enum ARRAY is a set of the declared values. The $ref belongs on the
    // items, not on the field — a picker reading the field's own schema would
    // otherwise offer one choice for a column that holds several.
    return type.array ? { type: 'array', items: item } : item
  }

  // Array types — String[] / Int[]
  if (type.array) {
    const itemType = type.name === 'Int' ? 'integer' : 'string'
    return { type: 'array', items: { type: itemType } }
  }

  switch (type.name) {
    case 'String':     return { type: 'string' }
    case 'Int':  return { type: 'integer' }
    case 'Float':     return { type: 'number' }
    case 'Boolean':  return { type: 'boolean' }
    case 'DateTime': return { type: 'string', format: 'date-time' }
    case 'Json':     return {}   // any JSON value — no type constraint
    case 'Bytes':     return { type: 'string', contentEncoding: 'base64' }
    case 'File':     return { '$ref': '#/$defs/FileRef' }  // shared ref — see FileRef definition below
    default:         return { type: 'string' }
  }
}

// ─── Validator → JSON Schema keyword mappings ─────────────────────────────────

function applyValidators(schema, attributes) {
  for (const attr of attributes) {
    switch (attr.kind) {
      case 'email':
        schema.format = 'email'
        break
      case 'url':
        schema.format = 'uri'
        break
      case 'phone':
        schema.format = 'phone'
        break
      case 'markdown':
        schema.contentMediaType = 'text/markdown'
        break
      case 'accept':
        schema['x-litestone-accept'] = attr.types
        break
      case 'date':
        schema.format = 'date'
        break
      case 'datetime':
        schema.format = 'date-time'
        break
      // A wall-clock time, and it is a `pattern` rather than `format: 'time'`
      // on purpose: that format means RFC 3339 full-time, which requires
      // seconds AND an offset, where `@time` requires neither and admits no
      // offset at all — so a consumer honouring the format would refuse
      // `09:30`, which the Data boundary accepts. The pattern is the
      // validator's own regex, imported rather than restated, so the two
      // boundaries cannot come to disagree about what a time is.
      case 'time':
        schema.pattern  = attr.seconds === true ? TIME_PATTERNS.hms : TIME_PATTERNS.hm
        schema['x-time'] = { seconds: attr.seconds === true }
        break
      // Exact numbers. The JSON type stays `integer` — the value on the wire IS
      // the scaled integer — and the scale travels beside it so a client can
      // render 1299 as 12.99 without being told a second time.
      case 'scale':
        schema['x-scale'] = attr.places
        break
      case 'money':
        // Three shapes and a reader has to tell them apart: a stated currency,
        // one held per row in a sibling column, and the app's default. The
        // scale is NOT resolved here — for `field:` it is not knowable from the
        // schema, and a number that is right two thirds of the time is worse
        // than an absent one.
        schema['x-money'] = attr.currency
          ? { currency: attr.currency }
          : attr.field ? { field: attr.field } : {}
        break

      case 'regex':
        if (attr.pattern) schema.pattern = attr.pattern
        break
      case 'length':
        if (attr.min != null) schema.minLength = attr.min
        if (attr.max != null) schema.maxLength = attr.max
        break
      case 'gt':
        if (attr.value != null) schema.exclusiveMinimum = attr.value
        break
      case 'gte':
        if (attr.value != null) schema.minimum = attr.value
        break
      case 'lt':
        if (attr.value != null) schema.exclusiveMaximum = attr.value
        break
      case 'lte':
        if (attr.value != null) schema.maximum = attr.value
        break
      case 'startsWith':
        if (attr.text) schema.pattern = `^${escapeRegex(attr.text)}`
        break
      case 'endsWith':
        if (attr.text) schema.pattern = `${escapeRegex(attr.text)}$`
        break
      case 'contains':
        if (attr.text) schema.pattern = escapeRegex(attr.text)
        break
      // Array validators
      case 'minItems':
        if (attr.value != null) schema.minItems = attr.value
        break
      case 'maxItems':
        if (attr.value != null) schema.maxItems = attr.value
        break
      case 'uniqueItems':
        schema.uniqueItems = true
        break
    }
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Default value serialization ─────────────────────────────────────────────

/**
 * A `@default(…)` literal → the JSON value a consumer should fill in.
 *
 * `type` matters for exactly one case, and it is the one that broke: an ARRAY
 * or `Json` field spells its default as a STRING in the `.lite` source, because
 * that is how it is stored — `tags String[] @default("[]")`. Emitted verbatim
 * that becomes `{"type":"array", "default":"[]"}`, a JSON Schema whose own
 * default fails its own type check. Junction's `autoValidate` fills the default
 * in and then refuses it: **every create that omitted the field 400'd with
 * "tags must be an array"**, naming a field the caller never sent. Found
 * declaring basecamp's feature flags.
 *
 * Parsed rather than passed through, so the emitted default is the value the
 * column will actually hold. A literal that does not parse is dropped — a
 * default nobody can use is better absent than wrong.
 */
function defaultValueToJson(value, type) {
  if (!value) return undefined
  if (value.kind === 'call')     return undefined  // now(), uuid() etc — runtime only

  const wantsStructured = type?.array || type?.name === 'Json'
  if (wantsStructured && value.kind === 'string') {
    try { return JSON.parse(value.value) } catch { return undefined }
  }

  if (value.kind === 'string')   return value.value
  if (value.kind === 'number')   return value.value
  if (value.kind === 'boolean')  return value.value
  if (value.kind === 'enum')     return value.value
  return undefined
}
