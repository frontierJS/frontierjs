// jsonschema.js — Generate JSON Schema (draft-07) from a Litestone schema.
//
// Usage:
//   import { generateJsonSchema } from '@frontierjs/litestone'
//   const schema = generateJsonSchema(parseResult.schema, options)
//
// Or via CLI:
//   litestone jsonschema                        → ./schema.jsonschema.json
//   litestone jsonschema --out=./schemas/
//   litestone jsonschema --format=flat          → one object per model at root
//   litestone jsonschema --format=definitions   → $defs with $ref (default)
//
// ─── Output shape (format=definitions) ───────────────────────────────────────
//
// {
//   "$schema": "https://json-schema.org/draft-07/schema",
//   "$defs": {
//     "users": {
//       "type": "object",
//       "properties": { ... },
//       "required": [...]
//     }
//   },
//   "Plan": { "enum": ["starter", "pro", "enterprise"] }
// }
//
// ─── Output shape (format=flat) ───────────────────────────────────────────────
//
// {
//   "$schema": "...",
//   "users": { "type": "object", ... },
//   "Plan":  { "enum": [...] }
// }
//
// ─── Type mappings ────────────────────────────────────────────────────────────
//
//  Litestone   JSON Schema type
//  ─────────── ──────────────────────────────────────────────────────────────
//  Text        string
//  Integer     integer
//  Real        number
//  Boolean     boolean
//  DateTime    string  + format: date-time  + @datetime validator implicit
//  Json        {}  (any — JSON Schema has no opaque JSON type)
//  Blob        string  + contentEncoding: base64
//  EnumName    $ref to enum definition (or inline enum array)
//
// ─── Validator mappings ───────────────────────────────────────────────────────
//
//  @email                → format: "email"
//  @url                  → format: "uri"
//  @datetime             → format: "date-time"
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
    const def = { type: 'string', enum: en.values.map(v => v.name), title: en.name }
    if (en.transitions) {
      def['x-litestone-transitions'] = Object.fromEntries(
        Object.entries(en.transitions).map(([name, { from, to }]) => [name, { from, to }])
      )
    }
    enumDefs[en.name] = def
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
      const fs = fieldToJsonSchema(f, schema, enumDefs, inlineEnums, audience, typeDefs)
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
    // Skip relation fields — they have no JSON representation
    if (field.type.kind === 'relation') continue

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

    // Inject doc comment as "description"
    if (field.comments?.length) {
      fieldSchema.description = field.comments.join(' ')
    }

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

    properties[field.name] = fieldSchema

    // Required: non-optional, no @default, not in update mode
    if (mode !== 'update') {
      const hasDefault = field.attributes.find(a => a.kind === 'default')
      // @default(auth().field) is auto-stamped — not required in API payloads
      const isAuthDefault = hasDefault?.value?.kind === 'call' && hasDefault?.value?.fn === 'auth'
      if (!field.type.optional && !hasDefault && !isId) {
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
    const dv = defaultValueToJson(defaultAttr.value)
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
    if (inlineEnums && enumDefs[type.name]) {
      return { type: 'string', enum: enumDefs[type.name].enum }
    }
    // Default: reference the enum definition
    return { '$ref': `#/$defs/${type.name}` }
  }

  // Array types — Text[] / Integer[]
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

function defaultValueToJson(value) {
  if (!value) return undefined
  if (value.kind === 'string')   return value.value
  if (value.kind === 'number')   return value.value
  if (value.kind === 'boolean')  return value.value
  if (value.kind === 'enum')     return value.value
  if (value.kind === 'call')     return undefined  // now(), uuid() etc — runtime only
  return undefined
}
