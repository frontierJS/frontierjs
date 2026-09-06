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
import { appJsonSchema }                  from '../../core/litestone.ts'

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

// The docs page is a string this repo renders as HTML by HAND, which is the
// case `CLAUDE.md` § House style already names — and it interpolates two
// caller-supplied values.
//
// The CDN reference was UNPINNED (`@scalar/api-reference` with no version), so
// the page ran whatever that package published today, on the API's own origin,
// where an operator's session lives. Pinned, and `crossorigin` so a failure is
// a failure rather than an opaque one. It stays a CDN reference because the
// alternative is vendoring a UI bundle into this package; the UI is opt-in
// (`ui: true`), so an app that does not want a third-party script does not
// mount the route. The pin goes stale by design: a stale version still renders,
// where an unpinned one changes under a running deployment. `createApiReference`
// is the global this page calls, so a bump is checked against that name.
const SCALAR_VERSION = '1.67.0'
const SCALAR_SRC     = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}`

function escapeHtml(v: string): string {
  return String(v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/**
 * JSON going INSIDE a `<script>` element, where the parser looks for `</script`
 * before the JavaScript parser sees anything. `customCss` and `metaData` are
 * caller-supplied strings on that config, so a value containing `</script>`
 * closes the element and everything after it is markup. Escaping the two
 * characters that can start a tag is enough and leaves the JSON valid, since
 * `\u003c` is the same string to a JS parser.
 */
function escapeForScript(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, m =>
    m === '\u2028' ? '\\u2028' : '\\u2029')
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
  // `true` mounts the UI at /docs, a string sets the path, `false`/absent is
  // off. It was typed `string | false`, which had no spelling for *on, at the
  // default path* — the runtime accepted `true` and the type forbade it, so the
  // documented usage did not compile.
  ui?: boolean | string

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

interface OAResponse {
  description: string
  content?:    { 'application/json': { schema: OASchema } }
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
  responses:   Record<string, OAResponse>
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

// ─── The error a caller actually receives ─────────────────────────────────
// Every operation listed 401/404/422 with a `description` and no shape, so a
// generated client had no error type at all. The shape here is what
// `toFrameworkError` puts on the wire — the same three fields `errors.snapshot.md`
// records — plus the `errors` array a validation failure carries, which is what
// a form renders (`FJS-902`).
const ERROR_SCHEMA: OASchema = {
  type: 'object',
  required: ['name', 'message', 'code'],
  properties: {
    name:    { type: 'string',  description: 'The error class — see errors.snapshot.md' },
    message: { type: 'string' },
    code:    { type: 'integer', description: 'HTTP status' },
    errors:  {
      type: 'array',
      description: 'Field-level failures, present on a validation error',
      items: {
        type: 'object',
        properties: { field: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
}

const ERROR_REF = { $ref: '#/components/schemas/Error' } as unknown as OASchema

/** The error responses every operation shares, each carrying the shape. */
function errorResponses(...codes: string[]): Record<string, OAResponse> {
  const known: Record<string, string> = {
    '400': 'Bad request',
    '401': 'Unauthorized',
    '403': 'Forbidden',
    '404': 'Not found',
    '409': 'Conflict',
    '422': 'Validation error',
  }
  return Object.fromEntries(codes.map(c => [c, {
    description: known[c] ?? 'Error',
    content: { 'application/json': { schema: ERROR_REF } },
  }]))
}

const COMMON_PARAMS: OAParameter[] = [
  { name: '$limit', in: 'query', schema: { type: 'integer', default: 20 } },
  { name: '$offset', in: 'query', schema: { type: 'integer', default: 0 } },
  { name: '$orderBy', in: 'query', schema: { type: 'string' } },
]

function buildOperation(
  serviceName: string,
  method:      string,
  schema?:     { body?: CompiledSchema | Schema; response?: CompiledSchema | Schema },
  declaredInput?: { name: string; schema: OASchema },
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
      ...errorResponses('401', '403', '404', '422'),
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

  // A declared `input:` wins over the model-derived body, the same way it does
  // at the boundary.
  if (declaredInput) {
    op.requestBody = {
      required: true,
      content:  { 'application/json': { schema: declaredInput.schema } }
    }
  } else if ((method === 'create' || method === 'patch') && schema?.body) {
    op.requestBody = {
      required: true,
      content:  { 'application/json': { schema: compiledToOA(schema.body) } }
    }
  }

  return op
}

// ─── generateOpenAPI ──────────────────────────────────────────────────────

/**
 * `defs` is the seed's `$defs` — the object types a `methods: [{ input }]`
 * entry names. Optional and third rather than a second generator: a standalone
 * caller that has not derived them still gets a spec, and the operation still
 * NAMES the type it expects, so a declared input is never silently absent.
 */
export function generateOpenAPI(app: App, opts: OpenAPIOptions, defs?: Record<string, unknown>): OASpec {

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
      schemas: { Error: ERROR_SCHEMA },
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

    // What this service ANSWERS, asked rather than assumed. `describe().methods`
    // is the policy-applied list and its own comment says why — *advertising a
    // verb the service answers 405 to is worse than not advertising it, because
    // a generated client calls it* — which is exactly what this file did: a
    // service narrowed by `methods:` was documented with all five CRUD verbs,
    // and three of six documented operations answered 405 (`FJS-902`).
    const answers = new Set(service.describe().methods)
    const declaredInput: Record<string, { name: string; schema: OASchema }> = {}

    // A declared `input:` names a `type` in the seed and reached the spec
    // nowhere — the one part of a service's payload contract that is STATED
    // rather than derived from a model was the part that went undocumented.
    // On a CRUD name it REPLACES the model-derived body, which is what it does
    // at the boundary too.
    const inputs: Record<string, string> = service.describe().inputs ?? {}
    for (const [method, typeName] of Object.entries(inputs)) {
      const def = defs?.[typeName] as OASchema | undefined
      if (def) spec.components.schemas[typeName] = def
      declaredInput[method] = {
        name: typeName,
        // A `$ref` where the type is resolvable; otherwise the operation still
        // names it, so a caller who derived no defs is told what is expected
        // rather than handed a body with no shape and no explanation.
        schema: def
          ? { $ref: `#/components/schemas/${typeName}` } as unknown as OASchema
          : { type: 'object', description: `Declared input type \`${typeName}\` (not resolved — pass the seed's $defs to generateOpenAPI)` },
      }
    }

    // ── Collection routes ──────────────────────────────────────────
    const collectionPath = `${prefix}/${serviceName}`
    const collection: OAPathItem = {}
    if (answers.has('find'))   collection.get  = buildOperation(serviceName, 'find',   svcSchemas.find, declaredInput['find'])
    if (answers.has('create')) collection.post = buildOperation(serviceName, 'create', svcSchemas.create, declaredInput['create'])
    // A path item with no operations is a path that does not exist.
    if (collection.get || collection.post) spec.paths[collectionPath] = collection

    // ── Resource routes ────────────────────────────────────────────
    const resourcePath = `${prefix}/${serviceName}/{id}`
    const resource: OAPathItem = {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
    }
    if (answers.has('get'))    resource.get    = buildOperation(serviceName, 'get',    svcSchemas.get)
    if (answers.has('patch'))  resource.patch  = buildOperation(serviceName, 'patch',  svcSchemas.patch)
    if (answers.has('remove')) resource.delete = buildOperation(serviceName, 'remove', svcSchemas.remove, declaredInput['remove'])

    // ── Custom methods, at the address the wire actually serves ────
    //
    // They were documented at `/{service}/{id}/{method}`, one path each, with a
    // comment saying the slug was documentation-only — and measured, every one
    // of them answered **404**, because no such route is registered. The wire
    // address is `POST /{service}/{id}` with an `X-Service-Method` header.
    //
    // So they collapse into ONE operation, and that is the wire's shape
    // surfacing rather than a loss: OpenAPI dispatches on path and verb, and
    // has no way to say *a different operation depending on a header VALUE*.
    // The header enum is the allow-list, the body is a `oneOf` over whatever
    // each method declared, and the description names them. A per-method
    // operation would read better and would be the same lie in a new place.
    const customMethods = service.describe().customMethods.filter(m => isMethodAllowed(service, m))
    if (customMethods.length) {
      const bodies = customMethods
        .map(m => ({
          name:   m,
          schema: declaredInput[m]?.schema ?? (svcSchemas[m]?.body ? compiledToOA(svcSchemas[m]!.body!) : undefined),
        }))
        .filter((b): b is { name: string; schema: OASchema } => !!b.schema)

      resource.post = {
        operationId: `call${serviceName.charAt(0).toUpperCase()}${serviceName.slice(1)}Method`,
        summary:     `Custom methods on ${serviceName}`,
        description:
          `Addressed by header, not by path: POST \`${prefix}/${serviceName}/{id}\` with ` +
          `\`X-Service-Method\` naming one of ${customMethods.map(m => `\`${m}\``).join(', ')}.`,
        tags:      [tag],
        security:  [{ bearerAuth: [] }],
        parameters: [{
          name:        'X-Service-Method',
          in:          'header',
          required:    true,
          schema:      { type: 'string', enum: customMethods },
          description: 'Which custom method to invoke.',
        }],
        ...(bodies.length ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              oneOf: bodies.map(b => ({ title: b.name, ...b.schema })),
            } as unknown as OASchema } },
          },
        } : {}),
        responses: {
          '200': { description: 'Success' },
          ...errorResponses('400', '401', '403', '404', '422'),
        },
      }
    }

    if (resource.get || resource.patch || resource.delete || resource.post)
      spec.paths[resourcePath] = resource
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

      app.get(endpoint, async () => {
        // Cheap invalidation probe: late-registered services change the
        // service count, which busts the cache.
        const svcCount = app.services.list().length
        if (!specCache || specSvcCount !== svcCount) {
          specSvcCount = svcCount
          // The seed's object types, so a declared `input:` resolves to a shape
          // rather than to its name. Derived through the adapter that already
          // owns the derivation and its cache; an app with no Litestone client
          // answers null and the spec names the type instead.
          const schema = await appJsonSchema(app)
          specCache = JSON.stringify(generateOpenAPI(app, opts, schema?.$defs as Record<string, unknown> | undefined), null, 2)
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
  <title>${escapeHtml(opts.title)} — API Docs</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
  <div id="scalar-app"></div>
  <script src="${SCALAR_SRC}" crossorigin="anonymous"></script>
  <script>
    Scalar.createApiReference('#scalar-app', ${escapeForScript(scalarConfig)})
  </script>
</body>
</html>`
          return new Response(html, { headers: { 'content-type': 'text/html' } })
        })
      }
    }
  }
}
