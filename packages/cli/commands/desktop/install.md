---
title: desktop:install
description: Add the desktop app to this machine's app launcher, so searching for it opens it
examples:
  - fli desktop:install
  - fli desktop:install --release
  - fli desktop:install --remove
flags:
  release:
    type: boolean
    description: Open the release shell from the launcher instead of the debug one
    defaultValue: false
  remove:
    char: r
    type: boolean
    description: Remove the launcher entry this command wrote instead of writing it
    defaultValue: false
---

<script>
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import { homedir } from 'os'
import { spawnSync } from 'child_process'
</script>

**Linux only.** It writes one XDG desktop entry under
`~/.local/share/applications/`, named for `identifier` in `shell/tauri.conf.json`.
Nothing in the app is written.

**The entry runs `fli desktop:run --no-build`**, so a click starts the API when
nothing answers, as the terminal command does, and opens the build already
there. A change under the screens is seen after the next `fli desktop:run`.
With `--release` the entry opens the release shell, and the rebuild that
reaches it is `fli desktop:run --release`.

**The entry carries this shell's PATH and this checkout's path.** A launcher
starts the process without the shell's rc files, so bun would not be found
otherwise. After a bun upgrade or moving the checkout the entry opens nothing,
and running this command again rewrites it.

```js
const { desktopLauncher, desktopBinary } =
  await import(resolve(global.fliRoot, 'core/desktop-surface.js'))

if (process.platform !== 'linux') {
  log.error('desktop:install writes an XDG desktop entry, which is Linux only.')
  log.error('On macOS, a release build with bundle.active in shell/tauri.conf.json is an .app to drag into Applications.')
  process.exit(1)
}

const root    = $.paths.root
const surface = $.paths.desktop
const entry   = desktopLauncher({
  root, surface,
  bun:      process.execPath,
  fli:      resolve(global.fliRoot, 'bin', 'fli.js'),
  path:     process.env.PATH ?? '',
  dataHome: process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
  release:  flag.release,
})

if (!entry) {
  log.error(`There is no ${relative(root, join(surface, 'shell', 'Cargo.toml'))}. fli make:desktop --wraps web creates the surface.`)
  process.exit(1)
}

if (flag.remove) {
  if (!existsSync(entry.file)) {
    log.info(`No launcher entry at ${entry.file} — nothing to remove.`)
    return
  }
  if (flag.dry) return log.dry(`rm ${entry.file}`)
  rmSync(entry.file)
  log.success(`Removed ${entry.file}`)
  return
}

const binary = desktopBinary(surface, { release: flag.release })
if (!existsSync(binary)) {
  log.error(`No shell at ${relative(root, binary)}, and the entry opens the build already there.`)
  log.error(`Run fli desktop:run${flag.release ? ' --release' : ''} once to build it.`)
  process.exit(1)
}

if (flag.dry) {
  log.dry(`write ${entry.file}`)
  echo(entry.body)
  return
}

const replaced = existsSync(entry.file)
mkdirSync(join(entry.file, '..'), { recursive: true })
writeFileSync(entry.file, entry.body)

// A malformed entry is skipped by the launcher in silence, so it is refused here.
const check = spawnSync('desktop-file-validate', [entry.file], { encoding: 'utf8' })
if (!check.error && check.status !== 0) {
  rmSync(entry.file)
  log.error(`desktop-file-validate refused the entry, so it was not kept:\n${check.stdout}${check.stderr}`)
  process.exit(1)
}
spawnSync('update-desktop-database', [join(entry.file, '..')])

log.success(`${replaced ? 'Replaced' : 'Wrote'} ${entry.file}`)
log.info('Search for it in the app launcher. fli desktop:install --remove takes it out.')
```
