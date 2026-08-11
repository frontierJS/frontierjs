---
title: workspace:npm
description: Compare each package's local version against what is on the npm registry
alias: ws:npm
examples:
  - fli ws:npm
  - fli ws:npm --tag beta
  - fli ws:npm --filter mesa
  - fli ws:npm --json
flags:
  tag:
    char: t
    type: string
    description: Which npm dist-tag to compare against
    defaultValue: latest
  filter:
    char: f
    type: string
    description: Only show packages matching this name
    defaultValue: ''
  private:
    type: boolean
    description: Include packages marked private in package.json
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

<script>
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// ─── registryState ────────────────────────────────────────────────────────────
// One `npm view` per package, all in flight at once — sixteen sequential
// lookups is about fifteen seconds of waiting for a table.
//
// An unpublished package exits non-zero with E404. That is an answer, not an
// error: `published: false`. A network failure looks the same from here, hence
// the separate `error` field rather than reporting every miss as unpublished.
//
// Every failure is retried once. A 404 out of the registry is not always the
// truth — a published package answered 404 on one run of this command and
// resolved on the next, and "never published" is the one wrong answer that
// would send someone to publish over a version that already exists.
const registryState = async ({ pkg }, attempt = 0) => {
  try {
    const { stdout } = await execAsync(`npm view ${pkg.name} --json`, { maxBuffer: 8 * 1024 * 1024 })
    const meta = JSON.parse(stdout)
    return { published: true, distTags: meta['dist-tags'] || {}, latest: meta.version }
  } catch (err) {
    if (attempt === 0) {
      await new Promise(r => setTimeout(r, 400))
      return registryState({ pkg }, 1)
    }
    const text = `${err.stderr || ''}${err.stdout || ''}`
    if (/E404|is not in this registry|404 Not Found/.test(text)) return { published: false }
    return { published: false, error: (err.stderr || err.message).trim().split('\n')[0] }
  }
}

// Numeric compare of the release part only — a prerelease suffix is ignored,
// which is enough to answer "is local ahead, behind, or level".
const compare = (a, b) => {
  const nums = (v) => String(v).split('-')[0].split('.').map(n => parseInt(n) || 0)
  const [x, y] = [nums(a), nums(b)]
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1
  }
  return 0
}
</script>

The state `ws:list` cannot answer: what is actually on npm. One `npm view` per
package, run concurrently, compared against the version in the working tree.

`ahead` is the normal state for a package with unreleased work — run
`fli ws:changed` to see what is in it, then `fli ws:pub`.

```js
const { wsRoot, packages: all } = await context.wsPackages()
if (!wsRoot) { log.error('No workspace path provided'); return }

let packages = all
if (flag.filter) {
  const filters = Array.isArray(flag.filter) ? flag.filter : [flag.filter]
  packages = packages.filter(({ pkg, folder }) =>
    filters.some(f => pkg.name.includes(f) || folder.includes(f))
  )
}
if (!flag.private) packages = packages.filter(({ pkg }) => !pkg.private)

if (!packages.length) {
  log.warn(`No packages found in ${wsRoot}/packages/`)
  return
}

const states = await Promise.all(packages.map(async (p) => {
  const reg    = await registryState(p)
  const remote = reg.published ? (reg.distTags[flag.tag] || null) : null
  const status = reg.error            ? 'error'
    : !reg.published                  ? 'unpublished'
    : !remote                         ? 'no-such-tag'
    : compare(p.pkg.version, remote) > 0 ? 'ahead'
    : compare(p.pkg.version, remote) < 0 ? 'behind'
    : 'level'
  return {
    name:     p.pkg.name,
    local:    p.pkg.version,
    remote,
    tag:      flag.tag,
    distTags: reg.distTags || {},
    status,
    error:    reg.error || null,
  }
}))

if (flag.json) {
  echo(JSON.stringify(states, null, 2))
  return
}

const mark = {
  level:       '✓ level',
  ahead:       '↑ unreleased',
  behind:      '↓ behind registry',
  unpublished: '· never published',
  'no-such-tag': `· no ${flag.tag} tag`,
  error:       '! lookup failed',
}

const width = Math.max(...states.map(s => s.name.length))

echo('')
echo(`  Workspace: ${wsRoot}`)
echo(`  dist-tag:  ${flag.tag}\n`)

for (const s of states) {
  const local  = s.local.padEnd(10)
  const remote = (s.remote || '—').padEnd(10)
  echo(`  ${s.name.padEnd(width)}  local ${local}  npm ${remote}  ${mark[s.status]}`)
  if (s.error) echo(`  ${' '.repeat(width)}  ${s.error}`)
}
echo('')

const count = (k) => states.filter(s => s.status === k).length
log.info(`${count('level')} level · ${count('ahead')} unreleased · ${count('behind')} behind · ${count('unpublished')} never published`)
if (count('error')) log.warn(`${count('error')} lookup(s) failed — registry unreachable?`)
```
