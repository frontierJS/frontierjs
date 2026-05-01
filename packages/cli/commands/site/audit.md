---
title: site:audit
description: Walk through ksite cleanup actions for a freshly cloned site (rm boilerplate, set domain, init stage branch)
alias: audit
examples:
  - fli site:audit
  - fli site:audit --dry
  - fli audit --force
  - fli site:audit --skip git
flags:
  force:
    type: boolean
    description: Run even if config_ranSetup is already true
    defaultValue: false
  skip:
    description: Skip a category of actions (cleanup | sed | git)
  yes:
    type: boolean
    char: y
    description: Skip per-action prompts and accept all
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve, basename } from 'path'

// Replace a single line in a file in place. Cross-platform — no sed -i hacks.
const replaceInFile = (path, find, replace) => {
  if (!existsSync(path)) return false
  const content = readFileSync(path, 'utf8')
  if (!content.includes(find)) return false
  writeFileSync(path, content.replace(find, replace), 'utf8')
  return true
}
</script>

Walks through the standard ksite cleanup steps for a freshly cloned site —
removing boilerplate pages, setting `site_url` and sitemap URLs to the project's
domain (inferred from the project root folder name), and creating a `stage`
branch. Each action is shown and confirmed individually so you can skip any
that don't apply.

The audit is a one-shot operation: it sets `config_ranSetup: true` in
`system.md` when complete, and won't re-run unless `--force` is passed.

```js
// Confirm prompt: y/Y/yes/<empty> accepts; anything else skips. --yes bypasses.
const confirm = async (msg) => {
  if (flag.yes) {
    log.info(msg + ' (auto-yes)')
    return true
  }
  const answer = (await question(msg + ' (y/n) › ')).trim().toLowerCase()
  return answer === 'y' || answer === 'yes' || answer === ''
}

// ─── Pre-flight: is this a ksite project? ────────────────────────────────────
const sitePath   = context.paths.site
const settings   = `${context.paths.siteContent}/settings`
const systemFile = `${settings}/system.md`
const siteFile   = `${settings}/site.md`
const robotsFile = `${settings}/robots.txt`

if (!existsSync(systemFile)) {
  log.error(`Not a ksite project — ${systemFile} not found`)
  log.info('site:audit only works on ksite-cloned sites with a content/settings/ folder')
  return
}

// ─── Idempotency guard ───────────────────────────────────────────────────────
const systemContent = readFileSync(systemFile, 'utf8')
const hasRanSetup   = systemContent.includes('config_ranSetup: true')
if (hasRanSetup && !flag.force) {
  log.info('Site audit has already been run (config_ranSetup: true in system.md)')
  log.info('Pass --force to run anyway, or edit system.md to reset')
  return
}

// ─── Derive domain from project root folder name ─────────────────────────────
const domain = basename(context.paths.root)
log.info(`Project: ${context.paths.root}`)
log.info(`Domain:  ${domain}`)
log.info('')

// ─── Build action list ───────────────────────────────────────────────────────
// Each action: { category, label, run: async () => {...} }
// run() should return true if it did something, false if it was a no-op.
const skip = (flag.skip || '').toLowerCase()
const skipCleanup = skip.includes('cleanup')
const skipSed     = skip.includes('sed')
const skipGit     = skip.includes('git')

const pagesDir = `${context.paths.siteContent}/pages`
const blogDir  = `${pagesDir}/blog`

const actions = []

if (!skipCleanup) {
  actions.push({
    category: 'cleanup',
    label: `Remove ${pagesDir}/internal/`,
    run: async () => {
      if (!existsSync(`${pagesDir}/internal`)) return false
      await context.exec({ command: `rm -rf ${pagesDir}/internal`, dry: flag.dry })
      return true
    },
  })
  actions.push({
    category: 'cleanup',
    label: `Remove ${pagesDir}/service-areas/`,
    run: async () => {
      if (!existsSync(`${pagesDir}/service-areas`)) return false
      await context.exec({ command: `rm -rf ${pagesDir}/service-areas`, dry: flag.dry })
      return true
    },
  })
  actions.push({
    category: 'cleanup',
    label: `Remove ${blogDir}/index.md (placeholder)`,
    run: async () => {
      if (!existsSync(`${blogDir}/index.md`)) return false
      await context.exec({ command: `rm ${blogDir}/index.md`, dry: flag.dry })
      return true
    },
  })
  actions.push({
    category: 'cleanup',
    label: `Remove ${blogDir}/*-blogpost.md (sample posts)`,
    run: async () => {
      if (!existsSync(blogDir)) return false
      // Use a glob shell so we don't have to walk JS-side
      await context.exec({ command: `rm -f ${blogDir}/*-blogpost.md`, dry: flag.dry })
      return true
    },
  })
}

if (!skipSed) {
  actions.push({
    category: 'sed',
    label: `Set site_url in site.md → https://${domain}`,
    run: async () => {
      if (flag.dry) {
        log.dry(`replace site_url placeholder in ${siteFile}`)
        return true
      }
      return replaceInFile(siteFile,
        'site_url: https://mycompany.com',
        `site_url: https://${domain}`)
    },
  })
  actions.push({
    category: 'sed',
    label: `Set Sitemap URL in robots.txt → https://${domain}/sitemap.xml`,
    run: async () => {
      if (flag.dry) {
        log.dry(`replace Sitemap URL in ${robotsFile}`)
        return true
      }
      return replaceInFile(robotsFile,
        'Sitemap: /sitemap.xml',
        `Sitemap: https://${domain}/sitemap.xml`)
    },
  })
}

if (!skipGit) {
  actions.push({
    category: 'git',
    label: 'Create + push stage branch (then return to main)',
    run: async () => {
      // Detect whether stage already exists — `git branch --list stage` prints
      // the matching branch line, or empty if absent.
      let existing = ''
      try {
        const { execSync } = await import('child_process')
        existing = execSync('git branch --list stage', {
          cwd: context.paths.root,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim()
      } catch {
        // Not in a git repo or git not available — let the create attempt fail loudly
      }
      if (existing) {
        log.info('  stage branch already exists — skipping')
        return false
      }
      await context.exec({
        command: 'git checkout -b stage && git push -u origin stage && git checkout main',
        dry: flag.dry,
      })
      return true
    },
  })
}

// Final action — flip the flag in system.md so we don't re-run
actions.push({
  category: 'finalize',
  label: `Set config_ranSetup: true in system.md`,
  run: async () => {
    if (flag.dry) {
      log.dry(`set config_ranSetup: true in ${systemFile}`)
      return true
    }
    return replaceInFile(systemFile,
      'config_ranSetup: false',
      'config_ranSetup: true')
  },
})

// ─── Per-action prompt + execute ─────────────────────────────────────────────
log.info(`${actions.length} action(s) queued`)
log.info('')

let ran = 0, skipped = 0, noop = 0, failed = 0
for (const action of actions) {
  const ok = await confirm(`[${action.category}] ${action.label}`)
  if (!ok) {
    skipped++
    log.info('  skipped')
    continue
  }
  try {
    const did = await action.run()
    if (did === false) {
      noop++
      log.info('  no-op')
    } else {
      ran++
      log.success('  done')
    }
  } catch (err) {
    failed++
    log.error(`  failed: ${err.message}`)
    const cont = await confirm('Continue with remaining actions?')
    if (!cont) break
  }
  log.info('')
}

// ─── Summary ─────────────────────────────────────────────────────────────────
log.info('───────────────────────────────────────')
log.info(`Audit complete: ${ran} ran, ${noop} no-op, ${skipped} skipped, ${failed} failed`)

if (flag.dry) {
  log.dry('(--dry: nothing was actually executed)')
} else if (failed === 0 && ran > 0) {
  log.success(`${domain} is ready`)
}
```
