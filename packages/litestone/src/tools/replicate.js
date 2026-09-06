// ─── replicate.js ─────────────────────────────────────────────────────────────
// Drives the litestream binary. Litestream owns the WAL bytes; litestone owns
// which databases and from where — see DECISIONS.md FJS-D31, which is also why
// nothing here is vendored, forked or bundled.
//
// The CALLER resolves the targets. cli.js owns loadSchema/createClient and is
// the one place that knows what a schema declares, so this file never opens a
// schema and never decides what is replicable. It takes a list and runs it.

import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
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

// ─── Litestream version ───────────────────────────────────────────────────────
// The v0.5 line or newer, and this is a refusal rather than a warning because
// the failure it prevents is invisible from outside.
//
// Litestone emits STRICT tables (strict is the default). Litestream 0.3.x
// bundles a SQLite too old to parse that, so it starts, reports itself
// replicating, and then loops forever on
//
//   sync error: malformed database schema (user) - near "STRICT": syntax error
//
// It never exits. The process is up, so `pgrep -x litestream` says healthy and
// every deploy check in this repo agrees — while the replica stays empty. The
// config written below also uses l0-retention, which older builds ignore, so
// time-travel silently is not there either.

const MIN_MAJOR = 0
const MIN_MINOR = 5

export function litestreamVersion(binary) {
  const r = spawnSync(binary, ['version'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const m = `${r.stdout ?? ''}`.trim().match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return { raw: m[0], major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

const tooOld = (v) =>
  v.major < MIN_MAJOR || (v.major === MIN_MAJOR && v.minor < MIN_MINOR)

// ─── Litestream binary detection ──────────────────────────────────────────────

export function findLitestream() {
  if (process.env.LITESTREAM_BIN) {
    const named = resolve(process.env.LITESTREAM_BIN)
    return existsSync(named) ? named : null
  }
  const cmd    = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(cmd, ['litestream'], { encoding: 'utf8' })
  if (result.status === 0) return result.stdout.trim().split('\n')[0].trim()
  return null
}

// ─── Replica URL ──────────────────────────────────────────────────────────────
// Every database gets its own path under the configured base, named for the
// database. Two databases sharing one replica url would overwrite each other's
// generations, so the suffix is not cosmetic. It is also what a restore names:
//
//   litestream restore -o ./app.db  s3://bucket/myapp/main
//   litestream restore -o ./log.db  s3://bucket/myapp/audit

export const replicaUrl = (base, name) => `${base.replace(/\/+$/, '')}/${name}`

// ─── YAML generation ──────────────────────────────────────────────────────────
// Litestream's config is simple enough that a string template is cleaner than
// pulling in a YAML library. No nested unknowns here.

function buildYaml(targets, opts) {
  const lines = ['dbs:']

  for (const t of targets) {
    lines.push(`  - path: ${t.path}`)
    lines.push(`    replicas:`)
    lines.push(`      - url: ${t.url}`)
    if (opts.syncInterval)    lines.push(`        sync-interval: ${opts.syncInterval}`)
    if (opts.retentionPeriod) lines.push(`        retention: ${opts.retentionPeriod}`)

    // l0-retention enables time-travel queries via the VFS extension.
    // Default to 24h unless the caller opts out explicitly.
    const l0 = opts.l0Retention ?? '24h'
    if (l0) lines.push(`        l0-retention: ${l0}`)
  }

  return lines.join('\n') + '\n'
}

// ─── WAL mode check ───────────────────────────────────────────────────────────
// Litestream enables WAL itself, but a database that is not in WAL yet grows a
// -wal and a -shm companion the moment it starts, and an operator who has not
// seen that before reads it as corruption.

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
// targets: [{ name, path }] — SQLite only, already filtered by the caller
// options: { url, syncInterval, retentionPeriod, l0Retention }
// dir:     where .litestone/litestream.yml is written (the schema's directory)

export async function replicate({ targets, options, dir, verbose = true }) {
  if (!targets?.length) {
    console.error(`${c.red}❌ No databases to replicate${c.reset}`)
    process.exit(1)
  }

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
   https://litestream.io/install

   Or point at one directly:  LITESTREAM_BIN=/path/to/litestream${c.reset}

   ${c.dim}Litestone needs v${MIN_MAJOR}.${MIN_MINOR} or newer.${c.reset}
`)
    process.exit(1)
  }

  // ── Guard: litestream version ────────────────────────────────────────────

  const version = litestreamVersion(binary)

  if (!version) {
    console.warn(`${c.yellow}⚠️  Could not read a version from ${binary} — proceeding.${c.reset}`)
    console.warn(`   ${c.dim}Litestone needs v${MIN_MAJOR}.${MIN_MINOR} or newer. Check with: ${binary} version${c.reset}\n`)
  } else if (tooOld(version)) {
    console.error(`${c.red}❌ litestream ${version.raw} is too old — v${MIN_MAJOR}.${MIN_MINOR} or newer is required${c.reset}`)
    console.error(`
   ${c.dim}${binary}${c.reset}

   Litestone writes STRICT tables. ${version.raw} bundles a SQLite that cannot
   parse them, so litestream would start, report itself replicating, and loop
   on ${c.dim}'malformed database schema … near "STRICT": syntax error'${c.reset} forever
   without exiting — a live process replicating nothing.

   ${c.dim}Upgrade:  https://litestream.io/install
   Or point at another build:  LITESTREAM_BIN=/path/to/litestream${c.reset}
`)
    process.exit(1)
  }

  const resolved = targets.map(t => ({
    ...t,
    path: resolve(t.path),
    url:  replicaUrl(options.url, t.name),
  }))

  // ── Guard: every database file must exist ────────────────────────────────
  // Litestream would create the replica and stream nothing. Named per database,
  // because with several of them "database not found" does not say which.
  const missing = resolved.filter(t => !existsSync(t.path))
  if (missing.length) {
    console.error(`${c.red}❌ Database file not found:${c.reset}`)
    for (const t of missing) console.error(`   ${c.cyan}${t.name}${c.reset}  ${t.path}`)
    console.error(`\n   ${c.dim}Paths resolve against the current directory. Run migrations first, or cd into the project.${c.reset}\n`)
    process.exit(1)
  }

  // ── WAL mode advisory ────────────────────────────────────────────────────
  if (verbose) {
    for (const t of resolved) {
      if (checkWalMode(t.path) === false) {
        console.warn(`${c.yellow}⚠️  ${t.name} is not in WAL mode — litestream will enable it automatically.${c.reset}`)
        console.warn(`   ${c.dim}This will create ${t.path}-wal and ${t.path}-shm.${c.reset}`)
      }
    }
  }

  // ── Write litestream config ──────────────────────────────────────────────
  // Generated, so it lives in .litestone/ beside the schema rather than in the
  // project root, and it is removed on exit.

  const litestoneDir = resolve(dir, '.litestone')
  const ymlPath      = resolve(litestoneDir, 'litestream.yml')

  mkdirSync(litestoneDir, { recursive: true })
  writeFileSync(ymlPath, buildYaml(resolved, options))

  // ── Print header ─────────────────────────────────────────────────────────

  if (verbose) {
    console.log(`\n${c.bold}🔁 Litestone Replication${c.reset}`)
    for (const t of resolved) {
      console.log(`   ${c.cyan}${t.name}${c.reset}`)
      console.log(`     ${c.dim}database:${c.reset} ${t.path}`)
      console.log(`     ${c.dim}replica:${c.reset}  ${t.url}`)
    }
    if (options.syncInterval)    console.log(`   ${c.dim}interval:${c.reset}     ${options.syncInterval}`)
    if (options.retentionPeriod) console.log(`   ${c.dim}retention:${c.reset}    ${options.retentionPeriod}`)
    console.log(`   ${c.dim}l0-retention:${c.reset} ${options.l0Retention ?? '24h'}`)
    console.log(`   ${c.dim}config:${c.reset}       ${ymlPath}`)
    console.log(`   ${c.dim}binary:${c.reset}       ${binary}`)
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
