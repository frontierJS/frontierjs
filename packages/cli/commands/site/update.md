---
title: site:update
description: Pull the latest ksite canonical (KSITE_DIR) and copy framework files into the current site
alias: site-update
examples:
  - fli site:update
  - fli site:update --dry
  - fli site-update --force        # bypass version + dirty-checkout guards
  - fli site:update --no-install   # skip the final npm install
flags:
  force:
    type: boolean
    char: f
    description: Bypass version-gate and dirty-checkout guards
    defaultValue: false
  install:
    type: boolean
    description: Run npm install after copying (use --no-install to skip)
    defaultValue: true
  yes:
    type: boolean
    char: y
    description: Skip per-action prompts and accept all
    defaultValue: false
---

<script>
import { existsSync, readFileSync } from 'fs'
import { resolve, basename } from 'path'

// Confirm helper — y/Y/yes/<empty> accepts; --yes auto-accepts everything.
const confirm = async (msg, log, ask) => {
  if (ask === false) {
    log.info(msg + ' (auto-yes)')
    return true
  }
  const answer = (await question(msg + ' (y/n) › ')).trim().toLowerCase()
  return answer === 'y' || answer === 'yes' || answer === ''
}

// Read a JSON file, return null on any error (missing, malformed, etc).
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { return null }
}

// Major version of a semver-ish string ('0.5.3' → '0', '1.2.0' → '1').
const major = (v) => String(v).split('.')[0]

// Is `cmd` available on PATH? Cheap shellout via `which`.
const haveCmd = async (cmd) => {
  try {
    const { execSync } = await import('child_process')
    execSync(`which ${cmd}`, { stdio: 'pipe' })
    return true
  } catch { return false }
}
</script>

Update a ksite-based project to the latest canonical version. Pulls
`KSITE_DIR` from env (your local clone of the ksite canonical), runs
`git pull` there, then copies framework files into the current site —
overwriting `src/`, `config/`, `functions/`, `public/theme/`, `patches/`
with `rsync --delete`, and copying `package.json`, `package-lock.json`,
and `CHANGELOG.md` directly. Each action prompts before running.

The version gate enforces that the canonical and the local site share a
major version — pass `--force` to override. Pass `--no-install` to skip
the final `npm install`.

```js
const ksiteDir = context.env.KSITE_DIR
console.log(context.env)
if (!ksiteDir || !existsSync(ksiteDir)) {
  log.error(`KSITE_DIR is not set or does not exist`)
  log.info(`Set KSITE_DIR in your env (try \`fli env\`) to the local clone of the ksite canonical`)
  return
}

// ── Pre-flight: required tools ─────────────────────────────────────────────
if (!(await haveCmd('rsync'))) {
  log.error('rsync is not installed')
  log.info('site:update relies on rsync --delete to mirror framework directories.')
  log.info('Install rsync (apt/brew/choco) and re-run.')
  return
}

// ── Pre-flight: this is a ksite project ────────────────────────────────────
const sitePath = context.paths.site
const sitePkgPath = `${sitePath}/package.json`
const sitePkg     = readJson(sitePkgPath)
if (!sitePkg) {
  log.error(`No package.json found at ${sitePkgPath}`)
  log.info('site:update needs to read the local ksite version from site/package.json')
  return
}

// ── Pre-flight: version compatibility ──────────────────────────────────────
const ksiteSiteRoot = `${ksiteDir}/site`
const canonPkgPath  = `${ksiteSiteRoot}/package.json`
const canonPkg      = readJson(canonPkgPath)
if (!canonPkg) {
  log.error(`Could not read canonical package.json at ${canonPkgPath}`)
  log.info('Make sure KSITE_DIR points at a clone with a site/package.json file')
  return
}

const localVer = sitePkg.version
const canonVer = canonPkg.version

log.info(`Local site:    ${context.paths.root}`)
log.info(`Local version: ${localVer}`)
log.info(`Canonical:     ${ksiteDir}`)
log.info(`Canon version: ${canonVer}`)

if (major(localVer) !== major(canonVer) && !flag.force) {
  log.error(`Major version mismatch — local ${localVer}, canonical ${canonVer}`)
  log.info(`Cross-major upgrades aren't supported by this command.`)
  log.info(`Pass --force to bypass this check (you'll likely need to migrate manually).`)
  return
}

// ── Pre-flight: dirty-checkout warning ─────────────────────────────────────
const dirty = context.git.status(context.paths.root)
if (dirty.length > 0 && !flag.force) {
  log.warn(`Uncommitted changes in ${context.paths.root} (${dirty.length} file(s))`)
  log.warn(`This command overwrites files in src/, config/, functions/, public/theme/, patches/.`)
  log.warn(`Local edits to those will be lost without warning.`)
  const ok = (await question('Continue anyway? (y/N): ')).trim().toLowerCase()
  if (ok !== 'y') { log.info('Aborted'); return }
}

// ── Pre-flight: branch warning ─────────────────────────────────────────────
const branch = context.git.branch(context.paths.root)
if (branch && branch !== 'main' && !flag.yes) {
  log.warn(`You are on branch '${branch}', not 'main'`)
  const ok = (await question(`Update '${branch}' anyway? (y/N): `)).trim().toLowerCase()
  if (ok !== 'y') { log.info('Aborted'); return }
}

// ── Step 1: git pull in the canonical ──────────────────────────────────────
log.info('')
log.info(`Pulling latest in ${ksiteDir}...`)
await context.exec({
  command: `git --git-dir=${ksiteDir}/.git --work-tree=${ksiteDir} pull`,
  dry: flag.dry,
})

// ── Step 2: build the upgrade action list ─────────────────────────────────
// Each action: { label, command, default? }
// `default: false` means the prompt defaults to skipping (currently only used
// for actions we suggest but don't strongly recommend).
const ksiteSite = ksiteSiteRoot
const actions = []

// Add-if-missing: sitemap.md, llms.txt
const sitemap   = `${sitePath}/content/pages/sitemap.md`
const llms      = `${sitePath}/content/settings/llms.txt`
if (!existsSync(sitemap)) {
  actions.push({
    label: 'Add sitemap.md (missing in this site)',
    command: `cp "${ksiteSite}/content/pages/sitemap.md" "${sitemap}"`,
  })
}
if (!existsSync(llms)) {
  actions.push({
    label: 'Add llms.txt (missing in this site)',
    command: `cp "${ksiteSite}/content/settings/llms.txt" "${llms}"`,
  })
}

// rsync --delete framework directories
const rsyncDirs = ['src', 'config', 'functions', 'public/theme', 'patches']
for (const dir of rsyncDirs) {
  actions.push({
    label: `Mirror ${dir}/ (rsync --delete)`,
    command: `rsync -a --delete "${ksiteSite}/${dir}/" "${sitePath}/${dir}/"`,
  })
}

// Direct file copies (overwrite)
actions.push({
  label: 'Copy site/package.json',
  command: `cp "${ksiteSite}/package.json" "${sitePath}/package.json"`,
})
actions.push({
  label: 'Copy site/package-lock.json',
  command: `cp "${ksiteSite}/package-lock.json" "${sitePath}/package-lock.json"`,
})
actions.push({
  label: 'Copy root-level package.json',
  command: `cp "${ksiteSite}/../package.json" "${sitePath}/../package.json"`,
})
actions.push({
  label: 'Copy root-level package-lock.json',
  command: `cp "${ksiteSite}/../package-lock.json" "${sitePath}/../package-lock.json"`,
})
actions.push({
  label: 'Copy CHANGELOG.md',
  command: `cp "${ksiteDir}/CHANGELOG.md" "${context.paths.root}/CHANGELOG.md"`,
})

// Final action — npm install (defaults to yes since most updates need it)
if (flag.install !== false) {
  actions.push({
    label: 'Install npm dependencies (npm install)',
    command: `npm install --prefix="${context.paths.root}"`,
  })
}

// ── Step 3: per-action confirm + execute ──────────────────────────────────
log.info('')
log.info(`${actions.length} action(s) queued`)
log.info('')

let ran = 0, skipped = 0, failed = 0
for (const action of actions) {
  log.info(action.label)
  log.info(`  ${action.command}`)
  const ok = await confirm('  Run?', log, !flag.yes)
  if (!ok) {
    skipped++
    log.info('  skipped')
    log.info('')
    continue
  }
  try {
    await context.exec({ command: action.command, dry: flag.dry })
    ran++
    log.success('  done')
  } catch (err) {
    failed++
    log.error(`  failed: ${err.message}`)
    const cont = await confirm('Continue with remaining actions?', log, !flag.yes)
    if (!cont) break
  }
  log.info('')
}

// ── Summary ───────────────────────────────────────────────────────────────
log.info('───────────────────────────────────────')
log.info(`Update complete: ${ran} ran, ${skipped} skipped, ${failed} failed`)
if (flag.dry) {
  log.dry('(--dry: nothing was actually executed)')
} else if (failed === 0 && ran > 0) {
  log.success(`${basename(context.paths.root)} updated to ksite ${canonVer}`)
}
```
