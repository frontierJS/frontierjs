// ─── replicate.js ─────────────────────────────────────────────────────────────
// Drives the litestream binary. Litestream owns the WAL bytes; litestone owns
// which databases and from where — see DECISIONS.md FJS-D31, which is also why
// nothing here is vendored, forked or bundled.
//
// The CALLER resolves the targets. cli.js owns loadSchema/createClient and is
// the one place that knows what a schema declares, so this file never opens a
// schema and never decides what is replicable. It takes a list and runs it.

import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { resolve, dirname } from 'path'
import { openDatabase } from '../core/engine.js'

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

/** The floor, for a caller grading a binary on another machine. */
export const LITESTREAM_MIN = { major: MIN_MAJOR, minor: MIN_MINOR }

// ─── The pinned build ─────────────────────────────────────────────────────────
// What `fli deploy:setup` and Basecamp's fleet install put on a machine, both
// at /usr/local/bin, so one pin is one build. FJS controls the version, never
// the artifact (FJS-D31): the bytes are upstream's release, refused unless they
// match the digests upstream's own checksums.txt published for it. Raising the
// pin means copying both lines from that file, and the pin must clear the floor.

export const LITESTREAM_PIN = {
  version: '0.5.17',
  sha256: {
    x86_64: 'cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d',
    arm64:  'f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5',
  },
}

// One line of shell with no single quote in it: deploy:setup runs it inside
// sudo sh -c '...'. An architecture without a pinned digest refuses rather than
// fetching something unchecked.
export const litestreamInstall = (dir = '/usr/local/bin') => {
  const { version: v, sha256 } = LITESTREAM_PIN
  return [
    'set -e',
    `case "$(uname -m)" in x86_64) a=x86_64; s=${sha256.x86_64};; aarch64|arm64) a=arm64; s=${sha256.arm64};; *) echo "litestream: no pinned build for $(uname -m)" >&2; exit 1;; esac`,
    't=$(mktemp -d)',
    `curl -fsSL -o "$t/l.tgz" "https://github.com/benbjohnson/litestream/releases/download/v${v}/litestream-${v}-linux-$a.tar.gz"`,
    'echo "$s  $t/l.tgz" | sha256sum -c - >/dev/null || { echo "litestream: checksum mismatch, refusing" >&2; rm -rf "$t"; exit 1; }',
    'tar -xzf "$t/l.tgz" -C "$t" litestream',
    `install -m 0755 "$t/litestream" "${dir}/litestream"`,
    'rm -rf "$t"',
  ].join('; ')
}

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

// ─── The layout manifest ──────────────────────────────────────────────────────
// What `backup` and `replicate` copy from beside the schema, named by the COPY
// (`FJS-D1103`). A restore runs into a tree that is empty exactly when it is
// needed, so it cannot name a `jobs.db` it has never seen, and a hyphenated
// name (`db-a-b`) cannot say whether it was `a/b.db` or `a-b.db`.
//
//   { sqlite: [{ name: 'db-jobs', rel: 'jobs.db' }], files: ['public/x.png'] }
//
// `rel` is a path under the schema's directory; a restore refuses one that
// leaves it, since the manifest is read from a bucket or a directory someone
// else can write to.

export const LAYOUT_FILE = 'db-layout.json'

export const layoutManifest = (layout) => ({
  sqlite: layout.sqlite.map(({ name, rel }) => ({ name, rel })),
  files:  layout.files.map(f => f.rel).sort(),
})

export function parseLayoutManifest(text, where) {
  let m
  try { m = JSON.parse(text) } catch (e) { throw new Error(`${where} is not JSON: ${e.message}`) }
  const okRel = rel => typeof rel === 'string' && rel !== '' && !rel.startsWith('/') && !rel.split('/').includes('..')
  for (const e of m?.sqlite ?? [])
    if (typeof e?.name !== 'string' || !/^db-/.test(e.name) || !okRel(e.rel)) throw new Error(`${where} names a SQLite file it cannot place: ${JSON.stringify(e)}`)
  for (const rel of m?.files ?? [])
    if (!okRel(rel)) throw new Error(`${where} names a file outside db/: ${JSON.stringify(rel)}`)
  return { sqlite: m?.sqlite ?? [], files: m?.files ?? [] }
}

// ─── Reading and writing a file beside a replica ──────────────────────────────
// Litestream stores databases and nothing else, so the manifest is put there by
// us. `file://` and `s3://` are the replicas this can reach; anything else is
// refused by scheme, and `replicate` says so rather than leave a replica that
// restores without its layout.

async function s3Store(url) {
  const { S3Provider } = await import('../storage/providers/s3.js')
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url)
  const env = process.env
  const provider = new S3Provider({
    provider: 's3', bucket: m[1],
    endpoint: env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  })
  return { provider, key: m[2].replace(/\/+$/, '') }
}

export const canStoreBesideReplica = url => /^(file|s3):\/\//.test(url)

export async function putReplicaFile(base, name, body) {
  const url = replicaUrl(base, name)
  if (url.startsWith('file://')) {
    const path = url.slice('file://'.length)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  } else if (url.startsWith('s3://')) {
    const { provider, key } = await s3Store(url)
    await provider.put(key, Buffer.from(body), { contentType: 'application/json' })
  } else {
    throw new Error(`a ${url.split(':')[0]}:// replica cannot hold ${name} — only file:// and s3:// can`)
  }
}

// Null when the replica holds none; a replica written before there was a layout
// to name, or a bare project's, is not an error.
export async function getReplicaFile(base, name) {
  const url = replicaUrl(base, name)
  if (url.startsWith('file://')) return existsSync(url.slice('file://'.length)) ? readFileSync(url.slice('file://'.length), 'utf8') : null
  if (url.startsWith('s3://')) {
    const { provider, key } = await s3Store(url)
    try { return (await provider.get(key)).toString('utf8') }
    catch (e) { if (/\(404\)/.test(e.message)) return null; throw e }
  }
  return null
}

// ─── YAML generation ──────────────────────────────────────────────────────────
// Litestream's config is simple enough that a string template is cleaner than
// pulling in a YAML library. No nested unknowns here.

// A JSON string is a YAML double-quoted scalar, so a key holding `:`, `#` or a
// leading `*` reads back as the bytes it was.
const q = v => JSON.stringify(String(v))

export function buildYaml(targets, opts) {
  // l0-retention is the STORE's setting in v0.5: read at the top of the file
  // and ignored, without a word, on a replica — where it was written, which
  // left every replica on the 5m default while this said 24h. A replica has no
  // `retention` either (FJS-1396): how long snapshots live is `snapshot.retention`
  // at the top, and the YAML is not parsed strictly, so a misplaced key is
  // dropped and the 24h default stays.
  const l0    = opts.l0Retention ?? '24h'
  const lines = [
    ...(l0 ? [`l0-retention: ${l0}`] : []),
    ...(opts.retentionPeriod ? ['snapshot:', `  retention: ${opts.retentionPeriod}`] : []),
    // The control socket's `/list` is the one reading of how far each
    // database's REPLICA is: `last_sync_at` stops when the bucket stops
    // answering. The `addr` metrics count local WAL syncs, which carry on.
    ...(opts.socket ? ['socket:', '  enabled: true', `  path: ${q(opts.socket)}`] : []),
    targets.length ? 'dbs:' : 'dbs: []',
  ]

  for (const t of targets) {
    // A directory target is every file matching the pattern, and `watch`
    // covers one created after litestream started — a tenant signing up
    // mid-run. Each file replicates to `<url>/<filename>`. `meta-dir` moves
    // each file's `.<db>-litestream` out of the directory, which is otherwise
    // carried by anything that copies the directory whole.
    if (t.dir) {
      lines.push(`  - dir: ${t.dir}`)
      lines.push(`    pattern: "${t.pattern}"`)
      lines.push(`    watch: true`)
      if (t.metaDir) lines.push(`    meta-dir: ${q(t.metaDir)}`)
    } else {
      lines.push(`  - path: ${t.path}`)
    }
    lines.push(`    replicas:`)
    // A target carrying its own `replica` holds its own key: one machine
    // replicates several apps, and the environment holds one key.
    if (t.replica) {
      const r = t.replica
      lines.push(`      - type: s3`)
      lines.push(`        bucket: ${q(r.bucket)}`)
      lines.push(`        path: ${q(r.path)}`)
      lines.push(`        endpoint: ${q(r.endpoint)}`)
      lines.push(`        region: ${q(r.region)}`)
      lines.push(`        access-key-id: ${q(r.accessKeyId)}`)
      lines.push(`        secret-access-key: ${q(r.secretAccessKey)}`)
      lines.push(`        force-path-style: true`)
    } else {
      lines.push(`      - url: ${t.url}`)
    }
    if (opts.syncInterval)    lines.push(`        sync-interval: ${opts.syncInterval}`)
  }

  return lines.join('\n') + '\n'
}

// ─── WAL mode check ───────────────────────────────────────────────────────────
// Litestream enables WAL itself, but a database that is not in WAL yet grows a
// -wal and a -shm companion the moment it starts, and an operator who has not
// seen that before reads it as corruption.

function checkWalMode(dbPath) {
  try {
    const db = openDatabase(dbPath, { readonly: true })
    const { journal_mode } = db.query('PRAGMA journal_mode').get()
    db.close()
    return journal_mode === 'wal'
  } catch {
    return null  // can't check — not a blocker
  }
}

// ─── The binary, or a refusal ─────────────────────────────────────────────────
// Every command that drives litestream asks this first, so the version floor
// is enforced in one place for the way out and the way back alike.

export function requireLitestream() {
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

  return binary
}

// ─── Main export ──────────────────────────────────────────────────────────────
// targets: [{ name, path } | { name, dir, pattern }] — SQLite only, already filtered by the caller
// options: { url, syncInterval, retentionPeriod, l0Retention }
// dir:     where .litestone/litestream.yml is written (the schema's directory)

export async function replicate({ targets, options, dir, verbose = true }) {
  if (!targets?.length) {
    console.error(`${c.red}❌ No databases to replicate${c.reset}`)
    process.exit(1)
  }

  const binary = requireLitestream()

  const resolved = targets.map(t => ({
    ...t,
    ...(t.dir ? { dir: resolve(t.dir) } : { path: resolve(t.path) }),
    url:  replicaUrl(options.url, t.name),
  }))

  // ── Guard: every database file must exist ────────────────────────────────
  // Litestream would create the replica and stream nothing. Named per database,
  // because with several of them "database not found" does not say which.
  // A directory target may be empty — no tenant yet — but it has to be there
  // to be watched, and it is created only where its parent already is, so an
  // unmounted volume is still reported rather than papered over.
  for (const t of resolved)
    if (t.dir && !existsSync(t.dir) && existsSync(dirname(t.dir))) mkdirSync(t.dir, { recursive: true })
  const missing = resolved.filter(t => !existsSync(t.dir ?? t.path))
  if (missing.length) {
    console.error(`${c.red}❌ Database file not found:${c.reset}`)
    for (const t of missing) console.error(`   ${c.cyan}${t.name}${c.reset}  ${t.dir ?? t.path}`)
    console.error(`\n   ${c.dim}Paths resolve against the current directory. Run migrations first, or cd into the project.${c.reset}\n`)
    process.exit(1)
  }

  // ── WAL mode advisory ────────────────────────────────────────────────────
  if (verbose) {
    for (const t of resolved) {
      if (t.path && checkWalMode(t.path) === false) {
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
      if (t.dir) console.log(`     ${c.dim}files:${c.reset}    ${t.dir}/${t.pattern} ${c.dim}(watched)${c.reset}`)
      else       console.log(`     ${c.dim}database:${c.reset} ${t.path}`)
      console.log(`     ${c.dim}replica:${c.reset}  ${t.url}`)
    }
    if (options.syncInterval)    console.log(`   ${c.dim}interval:${c.reset}     ${options.syncInterval}`)
    if (options.retentionPeriod) console.log(`   ${c.dim}snapshot-retention:${c.reset} ${options.retentionPeriod}`)
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

// ─── Restore ──────────────────────────────────────────────────────────────────
// One replica to one file. `dryRun` asks whether the replica can be reached
// without writing; litestream exits 1 on a replica with no backup in it, and on
// a timestamp before its first one.

// `at` is one instant for every file of a restore, and litestream refuses a
// timestamp later than a replica's last write — which a registry that has not
// changed since morning always is. Past the last write, the latest IS that
// instant's state, so the timestamp is dropped rather than refused.
export const lastWriteArgs = (url) => ['ltx', '-json', '-level', 'all', url]

/** The newest LTX file's time off `ltx -json`, or null when it lists none. */
export function parseLastWrite(stdout) {
  try {
    const times = JSON.parse(stdout).map(f => Date.parse(f.timestamp)).filter(Number.isFinite)
    return times.length ? Math.max(...times) : null
  } catch { return null }
}

export function lastWrite(binary, url) {
  const r = spawnSync(binary, lastWriteArgs(url), { encoding: 'utf8' })
  return r.status === 0 ? parseLastWrite(r.stdout) : null
}

/** `restore`'s argv for one file. `last` is `lastWrite`'s answer, asked only
 *  when `at` is set; `pinned` says whether `at` survived it. A caller that
 *  spawns its own way (Outpost, with a key in the environment) runs these. */
export function restoreArgs({ url, out, at = null, last = null, dryRun = false }) {
  const args   = ['restore', '-o', out]
  const pinned = Boolean(at) && !(last != null && Date.parse(at) >= last)
  if (pinned) args.push('-timestamp', at)
  if (dryRun) args.push('-dry-run')
  else        args.push('-integrity-check', 'quick')
  args.push(url)
  return { args, pinned }
}

/** Litestream's own reason off a failed run, its `Error:` prefix dropped. */
export function restoreError(status, stderr, stdout) {
  const said = `${stderr ?? ''}${stdout ?? ''}`.trim().split('\n').filter(l => /error/i.test(l)).pop()
  return (said ?? `litestream exited ${status}`).replace(/^Error:\s*/, '')
}

export function restoreFile(binary, { url, out, at = null, dryRun = false }) {
  const { args } = restoreArgs({ url, out, at, last: at ? lastWrite(binary, url) : null, dryRun })
  const r = spawnSync(binary, args, { encoding: 'utf8' })
  return { ok: r.status === 0, error: r.status === 0 ? null : restoreError(r.status, r.stderr, r.stdout) }
}
