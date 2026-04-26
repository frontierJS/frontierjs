// @frontierjs/litestone — public API

export { createClient, ValidationError,
         TransitionViolationError, TransitionConflictError,
         TransitionNotFoundError,
         LockNotAcquiredError, LockReleasedByOtherError,
         LockExpiredError }                          from './core/client.js'
export { sql, buildWindowCols, isNamedAgg, buildNamedAggExpr, extractNamedAggs } from './core/query.js'
export { Plugin, PluginRunner, AccessDeniedError } from './core/plugin.js'
export { GatePlugin, LEVELS, parseGateString,
         FrontierGateGetLevel }                        from './plugins/gate.js'
export { parse, parseFile }                      from './core/parser.js'
export { generateDDL, generateDDLForDatabase,
         generateTableDDL, generateViewDDL,
         generateIndexDDL,
         detectM2MPairs, generateJoinTableDDL }  from './core/ddl.js'
export { introspect, buildPristine, buildPristineForDatabase, diffSchemas,
         generateMigrationSQL, summariseDiff,
         splitStatements, checksum }             from './core/migrate.js'
export { create, apply, status, verify,
         listMigrationFiles, slugify,
         autoMigrate }                           from './core/migrations.js'

export { generateJsonSchema }                     from './jsonschema.js'
export { generateTypeScript }                     from './tools/typegen.js'
export { createTenantRegistry }                  from './tenant.js'
export { parseDuration, parseSize,
         runSqliteRetention, compactJsonl }       from './tools/retention.js'
export { Factory, Seeder, runSeeder }           from './seeder.js'
export { generateLiteSchema }                    from './tools/introspect.js'
export { replicate }                             from './tools/replicate.js'
export { ExternalRefPlugin }                       from './plugins/external-ref.js'
export { FileStorage }                             from './plugins/file.js'
export { fileUrl, fileUrls, useStorage, createProvider } from './storage/index.js'

// ─── Transform pipeline (DSL) ─────────────────────────────────────────────────
// Declarative SQLite transformation — separate from the ORM.
// Used via: import { $, params, preview, execute } from '@frontierjs/litestone'
export { $, params, preview, execute,
         introspectSQL, buildFKGraph,
         parseLimit, resolveRowCount }           from './transform/framework.js'
