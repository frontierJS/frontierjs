// Junction integration — public exports for jetty internals + adapter authors.

export { validateAdapter, callOptional, safeFetchSchema,
         safeGetServerSchemaVersion, safeSubscribe, safeOn,
         safeSetToken }                                    from './adapter.js'
export { createDefaultJunctionAdapter }                    from './default-adapter.js'
export { makeSchemaCache }                                 from './schema-cache.js'
export { makeAuthFlow }                                    from './auth.js'
