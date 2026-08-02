// example/config/default.ts
// Base config — values here are overridden by development.ts / production.ts

export default {
  name:    'Junction Demo',
  version: '1.0.0',
  port:    3000,
  debug:   true,

  // Service routes mount under /api — every documented URL in app.ts
  // (curl examples, docs links) assumes this prefix.
  apiPrefix: '/api',

  auth: {
    secret:        process.env.AUTH_SECRET ?? 'demo-secret-change-in-prod',
    sessionExpiry: '7d',
  },

  mail: {
    from:   'noreply@demo.local',
    apiKey: process.env.RESEND_API_KEY ?? '',
  },

  database: {
    url: process.env.DATABASE_URL ?? 'file:./demo.db',
    log: false,
  },

  http: {
    maxBodySize: 256 * 1024,
    compress:    true,
    cors: {
      origins: ['*'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      headers: ['Content-Type', 'Authorization', 'X-API-Key'],
    },
    ddos: {
      enabled: false,
      limit:   100,
      window:  60_000,
    },
    powered: 'Junction',
  },

  cache: {
    defaultTtl: '5 minutes',
    maxSize:    10_000,
  },

  workers: {
    dir: './workers',
  },
}
