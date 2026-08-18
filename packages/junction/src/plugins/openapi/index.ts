// openapi/index.ts
// Auto-generates an OpenAPI 3.1 spec from the service registry and schemas.
//
// Two modes:
//   1. Plugin — mounts GET {apiPrefix}/openapi.json automatically
//   2. Standalone — call generateOpenAPI(app) to get the spec object
//
// Schema registration:
//   Service methods can advertise their schemas so the generator picks them up.
//   Without registration the generator still produces valid (but less detailed) docs.
//
// Usage:
//   import { openapi } from '@frontierjs/junction/openapi'
//
//   // Option A: plugin (mounts the endpoint)
//   app.configure(openapi({
//     title:   'My API',
//     version: '1.0.0',
//     schemas: {
//       users: {
//         create: { body: UserCreateSchema, response: UserSchema },
//         find:   { response: UserListSchema },
//       },
//     },
//   }))
//
//   // Option B: generate the spec object directly
//   const spec = generateOpenAPI(app, { title: 'My API', version: '1.0.0' })

import type { App, Plugin }      from '../../core/app.ts'
import type { CompiledSchema, Schema, FieldDef } from '../../core/schema.ts'
import { customMethodNames, isMethodAllowed } from '../../core/service.ts'

// ─── Options ──────────────────────────────────────────────────────────────

export interface ScalarOptions {
  theme?:             string
  darkMode?:          boolean
  layout?:            'modern' | 'classic'
  defaultHttpClient?: { targetKey: string; clientKey: string }
  hiddenClients?:     true | Record<string, true | string[]>
  customCss?:         string
  authentication?:    Record<string, unknown>
  metaData?:          Record<string, string>
  [key: string]:      unknown
}

// Defaults: Node/fetch as primary, JS/fetch as secondary, Shell/curl as fallback.
// All other language clients hidden.
const SCALAR_DEFAULTS: ScalarOptions = {
  defaultHttpClient: { targetKey: 'node', clientKey: 'fetch' },
  hiddenClients: {
    c:          true,
    clojure:    true,
    csharp:     true,
    dart:       true,
    fsharp:     true,
    go:         true,
    http:       true,
    java:       true,
    js:         ['axios', 'jquery', 'ofetch', 'xhr'],   // keep fetch
    kotlin:     true,
    node:       ['axios', 'ofetch', 'undici'],           // keep fetch
    objc:       true,
    ocaml:      true,
    php:        true,
    powershell: true,
    python:     true,
    r:          true,
    ruby:       true,
    rust:       true,
    shell:      ['httpie', 'wget'],                      // keep curl
    swift:      true,
  },
}

export interface OpenAPIOptions {
  title:       string
  version:     string
  description?: string
  servers?:    Array<{ url: string; description?: string }>

  // Schema hints per service — optional but improves generated docs
  schemas?: Record<string, ServiceSchemas>

  // Path to mount the OpenAPI JSON endpoint (default: /openapi.json)
  path?: string

  // Mount a Scalar API reference UI at this path (default: /docs)
  ui?: string | false

  // Scalar UI configuration — merged over defaults, user values win
  scalar?: ScalarOptions

  // Additional raw OpenAPI path objects injected by plugins (e.g. auth routes).
  // Merged after service paths — plugins call openapi.addPaths() in their register().
  // Key: path string (e.g. '/auth/login'). Value: OAPathItem.
  extraPaths?: Record<string, Record<string, unknown>>
}

export interface ServiceSchemas {
  find?:   { response?: CompiledSchema | Schema }
  get?:    { response?: CompiledSchema | Schema }
  create?: { body?: CompiledSchema | Schema; response?: CompiledSchema | Schema }
  patch?:  { body?: CompiledSchema | Schema; response?: CompiledSchema | Schema }
  remove?: { response?: CompiledSchema | Schema }
  [method: string]: { body?: CompiledSchema | Schema; response?: CompiledSchema | Schema } | undefined
}

// ─── OpenAPI 3.1 types (minimal) ─────────────────────────────────────────

interface OASpec {
  openapi: string
  info:    { title: string; version: string; description?: string }
  servers?: Array<{ url: string; description?: string }>
  paths:   Record<string, OAPathItem>
  components: { schemas: Record<string, OASchema> }
}

interface OAPathItem {
  // OpenAPI allows parameters at the PATH level, shared by every operation
  // under it, and this generator emits one there for `{id}`. The index
  // signature alone typed that as an operation, so the assignment was an error
  // and the `in: 'header'` parameter the custom-method dispatch depends on
  // could not be expressed at all.
  parameters?: OAParameter[]
  // The five verbs this generator emits, named. They are a closed set in
  // OpenAPI, and reaching one through the index signature alone answered
  // `OAOperation | OAParameter[]` — so every read of `paths['/x'].post` had to
  // narrow past a parameter list that cannot be there.
  get?:    OAOperation
  post?:   OAOperation
  put?:    OAOperation
  patch?:  OAOperation
  delete?: OAOperation
  [method: string]: OAOperation | OAParameter[] | undefined
}

interface OAOperation {
  operationId: string
  summary:     string
  // Emitted for every custom method and declared nowhere, so the one line
  // telling a reader HOW to call one was an excess property.
  description?: string
  tags:        string[]
  parameters?: OAParameter[]
  requestBody?: { required: boolean; content: { 'application/json': { schema: OASchema } } }
  responses:   Record<string, { description: string; content?: { 'application/json': { schema: OASchema } } }>
  security?:   Array<{ bearerAuth: [] }>
}

interface OAParameter {
  name:        string
  // All four OpenAPI 3 locations. `header` is not optional here in practice:
  // a custom method is `POST /{service}/{id}` plus `X-Service-Method`, so the
  // generated spec is wrong about how to call one without it.
  in:          'path' | 'query' | 'header' | 'cookie'
  required?:   boolean
  schema:      OASchema
  description?: string
}

interface OASchema {
  type?:       string
  format?:     string
  properties?: Record<string, OASchema>
  required?:   string[]
  items?:      OASchema
  enum?:       unknown[]
  default?:    unknown
  minimum?:    number
  maximum?:    number
  minLength?:  number
  maxLength?:  number
  pattern?:    string
  nullable?:   boolean
  description?: string
  '$ref'?:     string
  allOf?:      OASchema[]
}

// ─── FieldDef → JSON Schema ────────────────────────────────────────────────

function fieldToSchema(field: FieldDef, schemaName?: string): OASchema {
  const base: OASchema = {}

  if (field.nullable) base.nullable = true
  if (field.default !== undefined && typeof field.default !== 'function') {
    base.default = field.default
  }

  switch (field.type) {
    case 'string':
    case 'email':
    case 'url':
    case 'uuid':
      base.type = 'string'
      if (field.type === 'email')   base.format = 'email'
      if (field.type === 'url')     base.format = 'uri'
      if (field.type === 'uuid')    base.format = 'uuid'
      if (field.minLength !== undefined) base.minLength = field.minLength
      if (field.maxLength !== undefined) base.maxLength = field.maxLength
      if (field.pattern) {
        base.pattern = typeof field.pattern === 'string'
          ? field.pattern
          : field.pattern.source
      }
      if (field.enum) base.enum = field.enum
      break

    case 'number':
      base.type = field.integer ? 'integer' : 'number'
      if (field.min !== undefined) base.minimum = field.min
      if (field.max !== undefined) base.maximum = field.max
      if (field.enum) base.enum = field.enum
      break

    case 'boolean':
      base.type = 'boolean'
      break

    case 'date':
      base.type   = 'string'
      base.format = 'date-time'
      break

    case 'array':
      base.type = 'array'
      if (field.items) base.items = fieldToSchema(field.items)
      break

    case 'object':
      base.type = 'object'
      if (field.schema) {
        const { props, required } = schemaToOA(field.schema)
        if (Object.keys(props).length) base.properties = props
        if (required.length) base.required = required
      }
      break

    case 'any':
    default:
      break   // no type constraint
  }

  return base
}

function schemaToOA(schema: Schema): { props: Record<string, OASchema>; required: string[] } {
  const props:    Record<string, OASchema> = {}
  const required: string[] = []

  for (const [key, field] of Object.entries(schema)) {
    props[key] = fieldToSchema(field)
    if (field.required) required.push(key)
  }

  return { props, required }
}

function compiledToOA(s: CompiledSchema | Schema): OASchema {
  // CompiledSchema has a validate method; Schema is a plain record.
  // If the CompiledSchema exposes _schema (set by buildCompiledSchema),
  // we can generate full property docs instead of a generic object.
  if (typeof (s as CompiledSchema).validate === 'function') {
    const raw = (s as CompiledSchema & { _schema?: Schema })._schema
    if (raw) {
      const { props, required } = schemaToOA(raw)
      const result: OASchema = { type: 'object', properties: props }
      if (required.length) result.required = required
      return result
    }
    // No _schema exposed — fall back to generic object
    return { type: 'object', description: 'See API source for schema details' }
  }
  const { props, required } = schemaToOA(s as Schema)
  const result: OASchema = { type: 'object', properties: props }
  if (required.length) result.required = required
  return result
}

// ─── Route → operation builder ────────────────────────────────────────────

const METHOD_SUMMARIES: Record<string, string> = {
  find:   'List',
  get:    'Get by ID',
  create: 'Create',
  patch:  'Update',
  remove: 'Delete',
}

const METHOD_HTTP: Record<string, string> = {
  find:   'get',
  get:    'get',
  create: 'post',
  patch:  'patch',
  remove: 'delete',
}

const COMMON_PARAMS: OAParameter[] = [
  { name: '$limit', in: 'query', schema: { type: 'integer', default: 20 } },
  { name: '$offset', in: 'query', schema: { type: 'integer', default: 0 } },
  { name: '$orderBy', in: 'query', schema: { type: 'string' } },
]

function buildOperation(
  serviceName: string,
  method:      string,
  schema?:     { body?: CompiledSchema | Schema; response?: CompiledSchema | Schema }
): OAOperation {

  const summary     = `${METHOD_SUMMARIES[method] ?? method} ${serviceName}`
  const operationId = `${method}${serviceName.charAt(0).toUpperCase()}${serviceName.slice(1)}`
  const tag         = serviceName

  const op: OAOperation = {
    operationId,
    summary,
    tags:      [tag],
    security:  [{ bearerAuth: [] }],
    responses: {
      '200': { description: 'Success' },
      '401': { description: 'Unauthorized' },
      '404': { description: 'Not found' },
      '422': { description: 'Validation error' },
    },
  }

  if (schema?.response) {
    op.responses['200'] = {
      description: 'Success',
      content: { 'application/json': { schema: compiledToOA(schema.response) } }
    }
  }

  if (method === 'find') {
    op.parameters = COMMON_PARAMS
    op.responses['200'] = {
      description: 'Paginated list',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              limit: { type: 'integer' },
              skip:  { type: 'integer' },
              data:  schema?.response ? compiledToOA(schema.response) : { type: 'array', items: { type: 'object' } },
            },
          }
        }
      }
    }
  }

  if ((method === 'create' || method === 'patch') && schema?.body) {
    op.requestBody = {
      required: true,
      content:  { 'application/json': { schema: compiledToOA(schema.body) } }
    }
  }

  return op
}

// ─── generateOpenAPI ──────────────────────────────────────────────────────

export function generateOpenAPI(app: App, opts: OpenAPIOptions): OASpec {

  // Respect apiPrefix from config (e.g. '/v1') — defaults to empty string (no prefix)
  const prefix = (app.config as Record<string, unknown>).apiPrefix as string ?? ''

  const spec: OASpec = {
    openapi: '3.1.0',
    info: {
      title:       opts.title,
      version:     opts.version,
      description: opts.description,
    },
    servers: opts.servers ?? [{ url: `http://localhost:${app.config.port}` }],
    paths:   {},
    components: {
      schemas: {},
    },
  }

  // Add security scheme
  ;(spec.components as Record<string, unknown>).securitySchemes = {
    bearerAuth: { type: 'http', scheme: 'bearer' }
  }

  const serviceNames = app.services.list()
  const schemas = opts.schemas ?? {}

  for (const serviceName of serviceNames) {
    const service    = app.services.get(serviceName)!
    const tag        = serviceName

    // Auto-schemas from a service's explicit `schema` option — manual
    // opts.schemas take precedence
    const autoSchemas = service.describe().schemas as
      { create?: import('../../core/schema.ts').CompiledSchema; patch?: import('../../core/schema.ts').CompiledSchema } | undefined

    const svcSchemas: ServiceSchemas = {
      ...schemas[serviceName],
      create: schemas[serviceName]?.create ?? (autoSchemas?.create ? { body: autoSchemas.create } : undefined),
      patch:  schemas[serviceName]?.patch  ?? (autoSchemas?.patch  ? { body: autoSchemas.patch  } : undefined),
    }

    // ── Collection routes ──────────────────────────────────────────
    const collectionPath = `${prefix}/${serviceName}`
    spec.paths[collectionPath] = {}
    spec.paths[collectionPath].get  = buildOperation(serviceName, 'find',   svcSchemas.find)
    spec.paths[collectionPath].post = buildOperation(serviceName, 'create', svcSchemas.create)

    // ── Resource routes ────────────────────────────────────────────
    const resourcePath = `${prefix}/${serviceName}/{id}`
    spec.paths[resourcePath] = {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
    }
    spec.paths[resourcePath].get    = buildOperation(serviceName, 'get',    svcSchemas.get)
    spec.paths[resourcePath].patch  = buildOperation(serviceName, 'patch',  svcSchemas.patch)
    spec.paths[resourcePath].delete = buildOperation(serviceName, 'remove', svcSchemas.remove)

    // ── Custom-method routes ───────────────────────────────────────
    // Custom methods live directly on the service object, so "is this one?" is
    // decided by core/service.ts — this was a local copy of the reserved-key
    // set that had drifted (it omitted `update` and `_update`, so both were
    // documented as custom methods on every service).
    // Policy-filtered: a documented endpoint that answers 405 is worse than an
    // undocumented one, because a generated client will call it.
    const customMethods = service.describe().customMethods.filter(m => isMethodAllowed(service, m))
    // Dispatched via the X-Service-Method header on POST /{id}. Each method
    // gets its own path entry for Swagger UI discoverability.
    // The path slug is documentation-only; the wire format uses the header.
    for (const methodName of customMethods) {
      const methodPath = `${prefix}/${serviceName}/{id}/${methodName}`

      spec.paths[methodPath] = {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
      }

      const methodSchema = svcSchemas[methodName]
      spec.paths[methodPath]['post'] = {
        operationId: `${methodName}${serviceName.charAt(0).toUpperCase()}${serviceName.slice(1)}`,
        summary:     `${methodName} ${serviceName}`,
        description: `Custom method. Send as: POST /${serviceName}/{id} with header \`X-Service-Method: ${methodName}\``,
        tags:        [tag],
        security:    [{ bearerAuth: [] }],
        parameters: [
          {
            name:        'X-Service-Method',
            in:          'header',
            required:    true,
            schema:      { type: 'string', enum: [methodName] },
            description: 'Identifies the custom method to invoke.',
          }
        ],
        ...(methodSchema?.body ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: compiledToOA(methodSchema.body) } }
          }
        } : {}),
        responses: {
          '200': methodSchema?.response
            ? { description: 'Success', content: { 'application/json': { schema: compiledToOA(methodSchema.response) } } }
            : { description: 'Success' },
          '401': { description: 'Unauthorized' },
          '404': { description: 'Not found' },
        },
      }
    }
  }

  // ── Merge extra paths — from opts and from app._openapiExtraPaths ──
  const appExtraPaths = app._openapiExtraPaths as
    Record<string, unknown> | undefined

  const allExtra = { ...(appExtraPaths ?? {}), ...(opts.extraPaths ?? {}) }
  for (const [path, item] of Object.entries(allExtra)) {
    spec.paths[path] = item as OAPathItem
  }

  return spec
}

// ─── openapi() plugin ────────────────────────────────────────────────────
// Registers GET /openapi.json (and optionally a Scalar API reference page).

export function openapi(opts: OpenAPIOptions): Plugin {
  return {
    name: 'openapi',

    register(app: App): void {
      // Expose a helper so other plugins can inject paths before spec generation
      // Usage in a plugin's register(): app.addOpenApiPaths({ '/auth/login': { post: {...} } })
      app.addOpenApiPaths = (paths: Record<string, unknown>) => {
        const existing = app._openapiExtraPaths ?? {}
        ;app._openapiExtraPaths = { ...existing, ...paths }
      }
      // app.get applies apiPrefix — see the route shortcuts in core/app.ts.
      // The spec's own `paths` still carry the prefix, because they describe
      // URLs a client will call rather than routes this app registers.
      const endpoint = opts.path ?? '/openapi.json'

      // The registry is static after boot, so generate + stringify the spec
      // ONCE on first request instead of rebuilding the whole document
      // (service reflection included) per hit. addOpenApiPaths() and any
      // late service registration invalidate the cache.
      let specCache: string | null = null
      let specSvcCount = -1
      const prevAdd = app.addOpenApiPaths!
      app.addOpenApiPaths = (paths: Record<string, unknown>) => {
        prevAdd(paths)
        specCache = null
      }

      app.get(endpoint, () => {
        // Cheap invalidation probe: late-registered services change the
        // service count, which busts the cache.
        const svcCount = app.services.list().length
        if (!specCache || specSvcCount !== svcCount) {
          specSvcCount = svcCount
          specCache = JSON.stringify(generateOpenAPI(app, opts), null, 2)
        }
        return new Response(specCache, {
          headers: { 'content-type': 'application/json' }
        })
      })

      // Optional Scalar UI — inline HTML, no extra dependencies
      if (opts.ui) {
        const uiPath = typeof opts.ui === 'string' ? opts.ui : '/docs'
        app.get(uiPath, () => {
          const scalarConfig = JSON.stringify({
            ...SCALAR_DEFAULTS,
            ...opts.scalar,
            // Deep merge hiddenClients so user overrides per-language, not wholesale
            hiddenClients: {
              ...(SCALAR_DEFAULTS.hiddenClients as Record<string, unknown>),
              ...(opts.scalar?.hiddenClients !== true ? opts.scalar?.hiddenClients : {}),
            },
            url: endpoint,
          })
          const html = `<!DOCTYPE html>
<html>
<head>
  <title>${opts.title} — API Docs</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
  <div id="scalar-app"></div>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  <script>
    Scalar.createApiReference('#scalar-app', ${scalarConfig})
  </script>
</body>
</html>`
          return new Response(html, { headers: { 'content-type': 'text/html' } })
        })
      }
    }
  }
}
