---
title: utils:pack
description: Zip a project as a clone would hold it — no deps, builds, secrets or local data
alias: pack
examples:
  - fli pack
  - fli pack ./my-project
  - fli pack --out ~/Desktop/handoff.zip
  - fli pack --with-data
  - fli pack --exclude "discovery/**" --exclude "*.log"
  - fli pack --dry
args:
  -
    name: target
    kind: dir
    description: Folder to zip (defaults to current directory)
    defaultValue: '.'
flags:
  out:
    char: o
    type: string
    description: Output zip path (defaults to <folder>-<date>.zip inside the folder)
    defaultValue: ''
  with-data:
    type: boolean
    description: Add a clean snapshot of each db/*.db (VACUUM INTO) — real rows leave with the zip
    defaultValue: false
  with-env:
    type: boolean
    description: Include .env files — the secrets leave with the zip
    defaultValue: false
  exclude:
    char: e
    type: string
    multiple: true
    description: Additional glob to exclude, relative to the folder (can repeat)
    defaultValue: ''
---

<script>
import { resolve, basename, dirname, join, relative } from 'path'
import { existsSync, statSync, readdirSync, mkdtempSync, rmSync, mkdirSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'

// Without git there is no .gitignore to ask, so these stand in for one.
const FALLBACK_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'target', '.cache',
  '.next', '.turbo', '.svelte-kit', '.fli-tmp', '.wrangler', 'coverage',
])
const NOISE = /(^|\/)(\.DS_Store|Thumbs\.db)$|\.(tmp|swp)$/

// Refused even when git tracks them — a tracked secret is a bug to report,
// not a file to ship. Each guard names the flag that lets it through.
const GUARDS = [
  { what: 'env file', flag: 'with-env',  test: p => /(^|\/)\.env(\.|$)/.test(p) && !/\.(example|sample|template)$/.test(p) },
  { what: 'database', flag: 'with-data', test: p => /\.(db|sqlite3?)(-shm|-wal|-journal)?$/.test(p) },
  { what: 'key',      flag: null,        test: p => /\.(pem|key|p12|pfx)$/.test(p) || /(^|\/)id_(rsa|ed25519)$/.test(p) },
]

function walk(root, dir = '', out = []) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name
    if (e.isDirectory()) { if (!FALLBACK_DIRS.has(e.name)) walk(root, rel, out) }
    else if (e.isFile()) out.push(rel)
  }
  return out
}

// What git ignores, biggest first — so the summary says where the weight went.
function ignoredBySize(root) {
  const run = spawnSync('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { cwd: root, encoding: 'utf8' })
  if (run.status !== 0) return []
  const paths = run.stdout.split('\0').filter(Boolean)
  if (!paths.length) return []
  const du = spawnSync('du', ['-sk', ...paths], { cwd: root, encoding: 'utf8' })
  return (du.stdout ?? '').trim().split('\n').filter(Boolean)
    .map(l => { const [kb, ...p] = l.split('\t'); return { path: p.join('\t'), bytes: Number(kb) * 1024 } })
    .sort((a, b) => b.bytes - a.bytes)
}

function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++ }
  return `${bytes < 10 && i ? bytes.toFixed(1) : Math.round(bytes)} ${u[i]}`
}
</script>

Zips a project the way a fresh clone would hold it, for handing a copy to
someone who is not pulling the repo. **When the folder is a git repository,
`.gitignore` decides** — tracked files plus untracked ones git does not ignore —
so a Rust `target/`, a surface's `dist/` or a folder of raw client pulls stay
out without this command knowing their names. Without git, a fixed list stands
in (`node_modules`, `.git`, `dist`, `build`, `target`, `.cache` …).

## Always refused

On top of that list, some files are refused **even when git tracks them**,
and the run names each one, because a tracked secret is a bug in the repo:

- **`.env*`**: `.env.example`, `.sample` and `.template` pass. `--with-env` lets the rest through.
- **Databases** (`*.db`, `*.sqlite` and their `-shm`/`-wal` files): `--with-data` adds a
  consistent snapshot of each `db/*.db` instead of the live file, which can be
  mid-write.
- **Keys** (`*.pem`, `*.key`, `id_rsa` …): no flag lets these through.

The zip is written **inside** the folder by default, where the person who ran
it is looking. A run never packs its own output or an earlier run's — any
`<folder>-<date>.zip` at the root is skipped. `--dry` lists what would go in
and writes nothing.

```js
const { treePaths } = await import(resolve(global.fliRoot, 'core/tree.js'))
const { plural }    = await import(resolve(global.fliRoot, 'core/text.js'))

const targetDir = resolve(arg.target.replace(/^~/, process.env.HOME || ''))
if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
  log.error(`Not a folder: ${targetDir}`)
  return
}
if (!flag.dry && spawnSync('zip', ['-v']).error) {
  log.error('zip is not installed — apt install zip, or brew install zip')
  return
}

const name    = basename(targetDir)
const stamp   = new Date().toLocaleDateString('sv')   // YYYY-MM-DD, local — not UTC's tomorrow
const outPath = flag.out
  ? resolve(flag.out.replace(/^~/, process.env.HOME || ''))
  : join(targetDir, `${name}-${stamp}.zip`)
const outRel  = relative(targetDir, outPath)
const earlier = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}-\\d{2}\\.zip$`)

// ── the file list ──────────────────────────────────────────────────────────
const tree   = treePaths(targetDir)
const source = tree ? 'git' : 'disk'
let files    = tree ? [...tree.files] : walk(targetDir)

// `git ls-files` still names a tracked file that was deleted and not committed.
files = files.filter(p => p !== outRel && !earlier.test(p) && !NOISE.test(p) && existsSync(join(targetDir, p)))

const extra = (Array.isArray(flag.exclude) ? flag.exclude : [flag.exclude]).filter(Boolean)
if (extra.length) {
  const globs = extra.map(g => new Bun.Glob(g))
  files = files.filter(p => !globs.some(g => g.match(p)))
}

const refused = []
files = files.filter(p => {
  const guard = GUARDS.find(g => g.test(p))
  if (!guard) return true
  if (guard.flag === 'with-env' && flag['with-env']) return true
  refused.push({ path: p, ...guard })
  return false
})

// Two names that differ only by case are two files here and one on macOS or
// Windows — whoever unzips gets whichever landed last.
const byLower = new Map()
for (const p of files) byLower.set(p.toLowerCase(), [...(byLower.get(p.toLowerCase()) ?? []), p])
const clashes = [...byLower.values()].filter(v => v.length > 1)

const bytes = files.reduce((n, p) => n + statSync(join(targetDir, p)).size, 0)
const dbs   = flag['with-data'] && existsSync(join(targetDir, 'db'))
  ? readdirSync(join(targetDir, 'db')).filter(f => f.endsWith('.db'))
  : []

// ── the summary ────────────────────────────────────────────────────────────
echo(chalk`\n  {bold ${name}} {dim ·} ${plural(files.length, 'file')}, ${human(bytes)} {dim (from ${source})}`)
if (dbs.length) echo(chalk`  {yellow +} ${plural(dbs.length, 'database snapshot')}: ${dbs.join(', ')}`)
if (flag['with-env']) echo(chalk`  {yellow +} .env files included {dim — the zip now carries secrets}`)

if (tree) {
  const heavy = ignoredBySize(targetDir).slice(0, 6)
  if (heavy.length) {
    echo(chalk`\n  {dim left out by .gitignore}`)
    for (const h of heavy) echo(chalk`    {dim ${human(h.bytes).padStart(7)}}  ${h.path}`)
  }
}
if (refused.length) {
  echo(tree
    ? chalk`\n  {yellow refused} {dim — git tracks these; consider} {cyan git rm --cached}`
    : chalk`\n  {yellow refused}`)
  for (const r of refused) echo(chalk`    {dim ${r.what.padEnd(8)}}  ${r.path}`)
}
if (clashes.length) {
  echo(chalk`\n  {yellow case clash} {dim — one file on macOS and Windows}`)
  for (const c of clashes) echo(`    ${c.join('  ·  ')}`)
}
echo('')

if (flag.dry) {
  if (flag.verbose) echo.lines(files, { indent: 4 })
  log.dry(`zip ${outPath}  (--verbose lists every file)`)
  return
}

// ── the archive ────────────────────────────────────────────────────────────
// Run from the parent so every entry sits under <name>/, as an unzip expects.
rmSync(outPath, { force: true })
const zip = spawnSync('zip', ['-q', '-@', outPath], {
  cwd: dirname(targetDir),
  input: files.map(p => `${name}/${p}`).join('\n'),
  encoding: 'utf8',
})
if (zip.status !== 0) {
  log.error(`zip failed: ${zip.stderr || zip.error?.message}`)
  return
}

if (dbs.length) {
  // VACUUM INTO writes a consistent copy from a read-only handle — the live
  // file and its -wal are never read as bytes, so a running dev server is safe.
  const { Database } = await import('bun:sqlite')
  const stage = mkdtempSync(join(tmpdir(), 'fli-pack-'))
  try {
    mkdirSync(join(stage, name, 'db'), { recursive: true })
    for (const f of dbs) {
      const db = new Database(join(targetDir, 'db', f), { readonly: true })
      db.run('VACUUM INTO ?', [join(stage, name, 'db', f)])
      db.close()
    }
    spawnSync('zip', ['-q', '-r', outPath, name], { cwd: stage })
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

log.success(`Created ${outPath}  (${human(statSync(outPath).size)})`)
```
