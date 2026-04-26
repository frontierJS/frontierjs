import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { resolve, dirname } from 'path'
import { Database } from 'bun:sqlite'

// ─── Colors ───────────────────────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
}

// ─── Config resolution ────────────────────────────────────────────────────────
// Mirrors resolveConfig() in framework.js — kept local to avoid coupling

function resolveConfig(mod) {
  const base = mod.config ? { ...mod.config, pipeline: mod.pipeline ?? mod.config.pipeline } : mod
  const { splitBy: _s, postSplit: _p, ...rest } = base
  return rest
}

// ─── Litestream binary detection ──────────────────────────────────────────────

function findLitestream() {
  const cmd    = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(cmd, ['litestream'], { encoding: 'utf8' })
  if (result.status === 0) return result.stdout.trim().split('\n')[0].trim()
  return null
}

// ─── YAML generation ──────────────────────────────────────────────────────────
// Litestream's config is simple enough that a string template is cleaner
// than pulling in a YAML library. No nested unknowns here.

function buildYaml(dbPath, opts) {
  const lines = [
    `dbs:`,
    `  - path: ${dbPath}`,
    `    replicas:`,
    `      - url: ${opts.url}`,
  ]

  if (opts.syncInterval)    lines.push(`        sync-interval: ${opts.syncInterval}`)
  if (opts.retentionPeriod) lines.push(`        retention: ${opts.retentionPeriod}`)

  // l0-retention enables time-travel queries via the VFS extension
  // Default to 24h unless the user opts out explicitly
  const l0 = opts.l0Retention ?? '24h'
  if (l0) lines.push(`        l0-retention: ${l0}`)

  return lines.join('\n') + '\n'
}

// ─── WAL mode check ───────────────────────────────────────────────────────────
// Litestream enables WAL automatically, but warns the user so they know
// why their db file just grew a -wal companion.

function checkWalMode(dbPath) {
  try {
    const db = new Database(dbPath, { readonly: true })
    const { journal_mode } = db.query('PRAGMA journal_mode').get()
    db.close()
    return journal_mode === 'wal'
  } catch {
    return null  // can't check — not a blocker
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function replicate(configPath, { verbose = true } = {}) {
  const abs = resolve(configPath)

  if (!existsSync(abs)) {
    console.error(`${c.red}❌ Config not found: ${abs}${c.reset}`)
    process.exit(1)
  }

  const mod    = await import(`file://${abs}`)
  const config = resolveConfig(mod)
  const { db: dbPath, replicate: replicateConfig } = config

  // ── Guard: replicate block required ─────────────────────────────────────

  if (!replicateConfig?.url) {
    console.error(`${c.red}❌ No replicate.url found in ${configPath}${c.reset}`)
    console.error(`
   Add a ${c.bold}replicate${c.reset} key to your config:

   ${c.dim}export let config = {
     db: './production.db',
     pipeline,
     replicate: {
       url: 's3://mybucket/myapp',       ${c.reset}${c.dim}// required
       syncInterval: '10s',              // optional, default: 1s
       retentionPeriod: '720h',          // optional, default: 24h
       l0Retention: '24h',               // optional, enables time-travel via VFS
     }
   }${c.reset}
`)
    process.exit(1)
  }

  // ── Guard: db file must exist ────────────────────────────────────────────

  const resolvedDbPath = resolve(dbPath)

  if (!existsSync(resolvedDbPath)) {
    console.error(`${c.red}❌ Database not found: ${resolvedDbPath}${c.reset}`)
    process.exit(1)
  }

  // ── Guard: litestream binary ─────────────────────────────────────────────

  const binary = findLitestream()

  if (!binary) {
    console.error(`${c.red}❌ litestream not found on PATH${c.reset}`)
    console.error(`
   Install litestream and make sure it's on your PATH:

   ${c.dim}# macOS
   brew install litestream

   # Debian / Ubuntu
   apt install litestream

   # Other platforms
   https://litestream.io/install${c.reset}
`)
    process.exit(1)
  }

  // ── WAL mode advisory ────────────────────────────────────────────────────
  // Litestream will enable WAL itself, but this avoids surprises for users
  // who haven't seen the -wal/-shm files appear before.

  const isWal = checkWalMode(resolvedDbPath)
  if (isWal === false && verbose) {
    console.warn(`${c.yellow}⚠️  Database is not in WAL mode — litestream will enable it automatically.${c.reset}`)
    console.warn(`   ${c.dim}This will create ${resolvedDbPath}-wal and ${resolvedDbPath}-shm files.${c.reset}\n`)
  }

  // ── Write litestream config ──────────────────────────────────────────────
  // Stored in .litestone/ next to the litestone config file.
  // Committed to .gitignore by convention (generated, contains paths).

  const litestoneDir = resolve(dirname(abs), '.litestone')
  const ymlPath      = resolve(litestoneDir, 'litestream.yml')

  mkdirSync(litestoneDir, { recursive: true })
  writeFileSync(ymlPath, buildYaml(resolvedDbPath, replicateConfig))

  // ── Print header ─────────────────────────────────────────────────────────

  if (verbose) {
    console.log(`\n${c.bold}🔁 Litestone Replication${c.reset}`)
    console.log(`   ${c.dim}database:${c.reset}    ${resolvedDbPath}`)
    console.log(`   ${c.dim}replica:${c.reset}     ${replicateConfig.url}`)
    if (replicateConfig.syncInterval)
      console.log(`   ${c.dim}interval:${c.reset}    ${replicateConfig.syncInterval}`)
    if (replicateConfig.retentionPeriod)
      console.log(`   ${c.dim}retention:${c.reset}   ${replicateConfig.retentionPeriod}`)
    console.log(`   ${c.dim}l0-retention:${c.reset} ${replicateConfig.l0Retention ?? '24h'}`)
    console.log(`   ${c.dim}config:${c.reset}      ${ymlPath}`)
    console.log(`   ${c.dim}binary:${c.reset}      ${binary}`)
    console.log(`\n${c.dim}   Streaming WAL to replica. Press Ctrl+C to stop.${c.reset}\n`)
  }

  // ── Spawn litestream ─────────────────────────────────────────────────────

  const child = spawn(binary, ['replicate', '-config', ymlPath], {
    stdio: 'inherit',
  })

  // ── Signal forwarding ────────────────────────────────────────────────────
  // On Ctrl+C or SIGTERM, forward to litestream so it can flush and exit
  // cleanly before we remove the generated config.

  const forward = sig => () => {
    child.kill(sig)
  }

  process.on('SIGINT',  forward('SIGINT'))
  process.on('SIGTERM', forward('SIGTERM'))

  // ── Exit handling ────────────────────────────────────────────────────────

  child.on('exit', (code, signal) => {
    try { unlinkSync(ymlPath) } catch {}

    if (verbose && (code !== 0 || signal)) {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`
      console.log(`\n${c.dim}litestream exited (${reason})${c.reset}`)
    }

    process.exit(code ?? (signal ? 1 : 0))
  })

  child.on('error', err => {
    try { unlinkSync(ymlPath) } catch {}
    console.error(`${c.red}❌ Failed to start litestream: ${err.message}${c.reset}`)
    process.exit(1)
  })
}
