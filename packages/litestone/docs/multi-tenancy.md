# Multi-Tenancy

The tenant registry manages one SQLite database per tenant — isolated files, shared schema, per-tenant encryption keys. Designed for SaaS applications where each customer gets their own database.

## Setup

```js
import { createTenantRegistry } from '@frontierjs/litestone'

const tenants = await createTenantRegistry({
  dir:           './tenants/',         // directory for tenant database files
  schema:        './schema.lite',
  maxOpen:       100,                  // max open connections (LRU eviction)
  encryptionKey: async (id) => getKeyForTenant(id),  // per-tenant key
  migrationsDir: './migrations',
})
```

## Getting a tenant client

```js
const db = await tenants.get('acme')
// → full Litestone client for acme's database, created if it doesn't exist
// → migrations auto-applied on first access

const result = await db.user.findMany({ where: { active: true } })
```

## Running across tenants

```js
// Query all tenants
const results = await tenants.query(async (db) => {
  return db.user.count()
})
// → { acme: 42, beta: 17, ... }

// Migrate all tenants
await tenants.migrate()
await tenants.migrate({ only: ['acme', 'beta'] })  // subset

// List tenants
const list = await tenants.list()
// → [{ id: 'acme', path: './tenants/acme.db', ... }]
```

## CLI

```bash
litestone tenant list
litestone tenant create <id>
litestone tenant delete <id>
litestone tenant migrate                    # migrate all tenants
litestone tenant migrate --only=acme,beta  # subset
```

## JSONL / logger databases

JSONL and logger databases are schema-global, not per-tenant. If you need per-tenant audit logs, create separate logger databases per tenant:

```js
const db = await tenants.get('acme')
// Logger database is shared across all tenants unless configured otherwise
```

## Connection pooling

The registry maintains an LRU pool of open connections (`maxOpen`). Least-recently-used tenants are closed when the pool is full. Database files are never deleted — just closed.

## Encryption

`encryptionKey` accepts either a string (same key for all tenants) or an async function:

```js
// Same key for all
encryptionKey: process.env.ENC_KEY

// Per-tenant key — fetched from KMS, vault, or database
encryptionKey: async (tenantId) => {
  return await kms.getTenantKey(tenantId)
}
```

Per-tenant keys are fetched once per connection open and cached for the lifetime of the connection.
