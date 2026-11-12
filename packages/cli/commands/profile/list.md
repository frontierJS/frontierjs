---
title: profile:list
description: List this machine's fli profiles — each one's key names (never values), its file mode, and the projects whose .env names it
alias: profiles
examples:
  - fli profiles
  - fli profiles --in ~/work
flags:
  in:
    type: string
    description: The folder searched for project .env files that name a profile
    defaultValue: '~/code'
---

A profile is `~/.config/fli/profiles/<name>.env`, one client's account keys,
loaded by a project whose `.env` says `FLI_PROFILE=<name>`
(`docs/configuration.md` § Profiles). This answers what a person cannot see
from one directory: every profile, what each holds, and who spends it — read
off the projects' own `.env` files, because the project is what picks.

A project naming a profile with no file shows as one, since every command run
there refuses until the file exists. `●` marks the profile this directory
spends. Values are never printed; `fli profile:open <name>` opens the file.

<script>
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

// ~/code/<client>/<app>/.env and a workspace's example/ sit within four.
const DEPTH = 4
const SKIP  = new Set(['node_modules', 'dist', 'build', 'vendor', 'target'])

/** Every `.env` under `root` naming a profile, as [{ dir, name }]. */
function projectsNaming(root, profileNamedIn) {
  const out = []
  const walk = (dir, depth) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    if (entries.some(e => e.name === '.env' && e.isFile())) {
      let text = ''
      try { text = readFileSync(join(dir, '.env'), 'utf8') } catch {}
      const name = profileNamedIn(text)
      if (name) out.push({ dir, name })
    }
    if (depth === DEPTH) return
    for (const e of entries)
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) walk(join(dir, e.name), depth + 1)
  }
  walk(root, 0)
  return out
}

/** The mode bits a profile holding account keys should not have. */
const openMode = (file) => {
  const mode = statSync(file).mode & 0o777
  return mode & 0o077 ? mode.toString(8) : null
}
</script>

```js
const { profileNames, profilePath, profilesDir, listProfile, badProfileName } = await import(path.resolve(global.fliRoot, 'core/global-env.js'))
const { profileNamedIn } = await import(path.resolve(global.fliRoot, 'core/utils.js'))
const { plural } = await import(path.resolve(global.fliRoot, 'core/text.js'))

const home    = process.env.HOME ?? ''
const tilde   = (p) => home && p.startsWith(home) ? '~' + p.slice(home.length) : p
const root    = flag.in.replace(/^~(?=\/|$)/, home)
const here    = global.fliProfile?.name ?? null
const naming  = projectsNaming(root, profileNamedIn)
const names   = [...new Set([...profileNames(), ...naming.map(p => p.name)])].sort()

echo`{bold ${plural(profileNames().length, 'profile')}} {dim in ${tilde(profilesDir())}}`
if (!names.length) {
  echo`{dim none — make one with:} fli profile:create <name>`
  return
}
echo('')

for (const name of names) {
  const mark  = name === here ? chalk.green('●') : chalk.dim('○')
  const users = naming.filter(p => p.name === name).map(p => tilde(p.dir))
  const by    = users.length ? users.join(', ') : chalk.dim(`no project under ${flag.in}`)
  const bad   = badProfileName(name)
  const file  = bad ? null : profilePath(name)

  if (!file || !existsSync(file)) {
    echo`  {red ✗} {bold ${name}}  {red ${bad ?? 'no file'}}`
    echo`      {dim named by}  ${by}`
    if (!bad) echo`      {dim create it with} fli profile:create ${name}`
    continue
  }

  const keys = listProfile(name).map(k => k.key)
  const mode = openMode(file)
  echo`  ${mark} {bold ${name}}  {dim ${plural(keys.length, 'key')}}  ${keys.join(', ')}`
  echo`      {dim named by}  ${by}`
  if (mode) echo`      {yellow ⚠ mode ${mode}} {dim — other users can read it:} chmod 600 ${tilde(file)}`
}
```
