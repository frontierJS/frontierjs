---
namespace: project
description: FJS project introspection — structural map of services, schema, migrations, and resources
---

<script>
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { resolve, basename } from 'path'
import { execSync } from 'child_process'

// ─── freshJsonSchema ──────────────────────────────────────────────────────────
// Regenerates schema.json from schema.lite and returns the parsed object.
// Same approach as fli:validate — shells out to litestone jsonschema silently.

const freshJsonSchema = (context) => {
  const root = context.paths.root
  execSync(`cd ${root} && bunx litestone jsonschema --schema db/schema.lite`, {
    stdio: 'pipe',
  })
  const schemaJson = resolve(context.paths.db, 'schema.json')
  return JSON.parse(readFileSync(schemaJson, 'utf8'))
}

// ─── scanFiles ────────────────────────────────────────────────────────────────
// Returns all files in a directory matching one or more extensions.

const scanFiles = (dir, ...exts) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && exts.some(x => e.name.endsWith(x)))
    .map(e => resolve(dir, e.name))
}

// ─── extractServiceMeta ───────────────────────────────────────────────────────
// Reads a .service.ts file and extracts name, model, hooks, custom methods.
// Covers createLitestoneService({ hooks: { before: { ... }, after: { ... } } })
// and the chained svc.hooks({ ... }) form.

const extractServiceMeta = (src, filename) => {
  const name  = src.match(/name\s*:\s*['"](\w+)['"]/)
  const model = src.match(/model\s*:\s*['"](\w+)['"]/)

  const serviceName  = name  ? name[1]  : basename(filename).replace(/\.service\.ts$/, '')
  const serviceModel = model ? model[1] : serviceName

  // Extract hook phase maps: before: { create: [authenticate], ... }
  const hooks = { before: {}, after: {}, around: {}, error: {} }
  const hookBlockRe = /(before|after|around|error)\s*:\s*\{([^}]+)\}/gs
  let hm
  while ((hm = hookBlockRe.exec(src)) !== null) {
    const phase = hm[1]
    const body  = hm[2]
    const methodRe = /(\w+)\s*:\s*\[([^\]]*)\]/g
    let mm
    while ((mm = methodRe.exec(body)) !== null) {
      const method = mm[1]
      const fns = mm[2]
        .split(',')
        .map(s => s.trim().replace(/['"]/g, '').split('(')[0].trim())
        .filter(Boolean)
      if (fns.length) hooks[phase][method] = fns
    }
  }

  // Custom methods: any function key not in the CRUD reserved set
  const RESERVED = new Set([
    'find','get','create','patch','remove','restore',
    'createLitestoneService','createService','hooks',
  ])
  const customRe = /(?:async\s+)?(\w+)\s*(?:\([^)]*ctx[^)]*\)|:\s*async\s*(?:\([^)]*ctx[^)]*\)))/g
  const customMethods = []
  let cm
  while ((cm = customRe.exec(src)) !== null) {
    if (!RESERVED.has(cm[1]) && cm[1] !== 'function' && /^[a-z]/.test(cm[1])) {
      customMethods.push(cm[1])
    }
  }

  return {
    name:          serviceName,
    model:         serviceModel,
    hooks,
    customMethods: [...new Set(customMethods)],
  }
}

// ─── extractResourceMeta ──────────────────────────────────────────────────────
// Reads a .mesa or .svelte resource file and extracts model, service, hook names.

const extractResourceMeta = (src, filename) => {
  const modelM   = src.match(/model\s*:\s*['"](\w+)['"]/)
  const serviceM = src.match(/service\s*:\s*['"](\w+)['"]/)
  const name     = basename(filename).replace(/\.(mesa|svelte)$/, '')

  // Collect function names referenced inside hooks: { ... } blocks
  const hookFns = []
  const hooksBlockM = src.match(/hooks\s*:\s*\{([\s\S]*?)\}\s*,?\s*\}/)
  if (hooksBlockM) {
    const fnRe = /\b([a-z][a-zA-Z0-9]+)\b/g
    const SKIP = new Set(['before','after','around','error','all','create','patch','remove','find','get'])
    let fm
    while ((fm = fnRe.exec(hooksBlockM[1])) !== null) {
      if (!SKIP.has(fm[1])) hookFns.push(fm[1])
    }
  }

  return {
    name,
    model:   modelM   ? modelM[1]   : null,
    service: serviceM ? serviceM[1] : null,
    hooks:   [...new Set(hookFns)],
  }
}

// ─── extractServerMeta ────────────────────────────────────────────────────────
// Reads server.ts (or server.js) and detects which tier-1 FJS packages are
// configured. Returns a structured packages array — one entry per known package,
// installed: true/false.
//
// Detection strategy: import presence + app.configure() call.
// Tier-1 packages: auth, conduit, caravan, notifications
// Tier-2 packages: litestream (config file), mailer (mailerPlugin call)

const TIER1_PACKAGES = [
  {
    id:    'auth',
    label: '@frontierjs/auth',
    short: 'auth',
    realm: 'junction',
    signals: ['createFjsAuth', 'createFjsAuthPlugin', 'frontierjs/auth'],
  },
  {
    id:    'conduit',
    label: '@frontierjs/conduit',
    short: 'conduit',
    realm: 'junction',
    signals: ['conduit(', 'frontierjs/conduit', 'app.conduit'],
  },
  {
    id:    'caravan',
    label: '@frontierjs/caravan',
    short: 'caravan',
    realm: 'junction',
    signals: ['caravan(', 'frontierjs/caravan', 'app.caravan'],
  },
  {
    id:    'notifications',
    label: '@frontierjs/notifications',
    short: 'notifications',
    realm: 'junction',
    signals: ['notificationsPlugin', 'frontierjs/notifications', 'app.notify('],
  },
  {
    id:    'litestream',
    label: 'litestream',
    short: 'litestream',
    realm: 'litestone',
    signals: ['litestream', 'LITESTREAM'],
  },
]

const extractServerMeta = (root) => {
  // Candidate server entry files — check most specific first
  const candidates = [
    resolve(root, 'api/src/server.ts'),
    resolve(root, 'api/server.ts'),
    resolve(root, 'api/src/server.js'),
    resolve(root, 'api/server.js'),
    resolve(root, 'server.ts'),
    resolve(root, 'server.js'),
  ]

  const serverFile = candidates.find(f => existsSync(f))
  if (!serverFile) return { serverFile: null, packages: [] }

  // Also scan auth.ts alongside server.ts — auth signals often live there
  const authFile = resolve(resolve(serverFile, '..'), 'auth.ts')
  const src = [
    readFileSync(serverFile, 'utf8'),
    existsSync(authFile) ? readFileSync(authFile, 'utf8') : '',
  ].join('\n')

  const packages = TIER1_PACKAGES.map(pkg => ({
    id:        pkg.id,
    label:     pkg.label,
    short:     pkg.short,
    realm:     pkg.realm,
    installed: pkg.signals.some(s => src.includes(s)),
  }))

  // Detect mailer separately (not in COR chips but useful metadata)
  const mailer =
    src.includes('createResendMailer') ? 'resend' :
    src.includes('createSmtpMailer')   ? 'smtp'   :
    src.includes('mailerPlugin')       ? 'unknown' :
    null

  return { serverFile, packages, mailer }
}
// Reads migration .sql files from db/migrations/ and returns structured rows.
// Does not query the database — file system only.

const parseMigrationFiles = (migrationsDir) => {
  if (!existsSync(migrationsDir)) return []
  return readdirSync(migrationsDir)
    .filter(f => /^\d{14}_[\w]+\.sql$/.test(f))
    .sort()
    .map(f => ({
      name: f,
      sql:  readFileSync(resolve(migrationsDir, f), 'utf8'),
    }))
}
</script>

## Project commands

```
fli project:map        — structural snapshot of the FJS project
fli project:map --json — output as JSON (for tooling / Basecamp)
```
