// build — orchestrates discovery → auto-gen → manifest → Vite builds.
//
// Phase 0 scope: Chrome only, Harbor + Dock minimum. Options/Piers/Islands
// hooked up in pipeline so their files compile if present, but main.js
// auto-gen for Pages and registration for Islands are minimal stubs.

import { mkdirSync, writeFileSync, cpSync, existsSync, rmSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig }                      from './config-loader.js'
import { discover }                        from './discover.js'
import { buildManifest }                   from './manifest.js'
import { autoGenForPage, autoGenForIsland } from './auto-gen.js'
import { harborViteConfig, pagesViteConfig, islandsViteConfig, htmlEntriesFor } from './vite-config.js'
import { runAudit, formatAuditReport }    from '../audit/index.js'

const HERE         = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '../..')

export async function buildExtension({ root, browser = 'chrome', verbose = false, dev = null }) {
  if (browser !== 'chrome' && browser !== 'firefox') {
    throw new Error(`browser="${browser}" not supported. Use 'chrome' or 'firefox' (or call buildBoth for both).`)
  }

  const log = verbose ? (...args) => console.log('[jetty]', ...args) : () => {}

  const config = await loadConfig({ root, browser })
  log('config loaded:', config.name, 'v' + config.version)

  const found = discover({ root })
  log('discovered:',
      'harbor=' + (found.harbor ? '✓' : '✗'),
      'dock=' + (found.dock ? '✓' : '✗'),
      'options=' + (found.options ? '✓' : '✗'),
      'piers=' + found.piers.length,
      'islands=' + found.islands.length)
  for (const w of found.warnings) console.warn('[jetty] warn:', w)

  // Build island-matches map for harbor's dev client (so it can reload tabs
  // for an island when the WS broadcasts island:reload-tabs). Only relevant
  // when dev mode is active.
  const islandMatches = {}
  if (dev?.port) {
    const islandsConfig = config.islands ?? {}
    for (const island of found.islands) {
      islandMatches[island.id] = islandsConfig[island.id]?.matches ?? []
    }
  }

  const distDir   = resolve(root, 'dist', browser)
  const cacheDir  = resolve(root, '.jetty-cache', browser)

  // Clean cache + dist for a deterministic Phase 0 build.
  if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true })
  if (existsSync(distDir))  rmSync(distDir,  { recursive: true, force: true })
  mkdirSync(cacheDir, { recursive: true })
  mkdirSync(distDir,  { recursive: true })

  // --- 1. Auto-gen Page bootstraps (where App.mesa-only) ---
  const autoGenPaths = { piers: {}, islands: {} }
  if (found.dock?.autoGen) {
    autoGenPaths.dock = autoGenForPage({ page: found.dock, cacheDir, packageRoot: PACKAGE_ROOT, dev, extRoot: root })
    log('auto-gen dock:', relPath(root, autoGenPaths.dock.htmlPath))
  }
  if (found.options?.autoGen) {
    autoGenPaths.options = autoGenForPage({ page: found.options, cacheDir, packageRoot: PACKAGE_ROOT, dev, extRoot: root })
    log('auto-gen options:', relPath(root, autoGenPaths.options.htmlPath))
  }
  for (const pier of found.piers) {
    if (pier.autoGen) {
      autoGenPaths.piers[pier.id] = autoGenForPage({ page: pier, cacheDir, packageRoot: PACKAGE_ROOT, dev, extRoot: root })
      log(`auto-gen pier "${pier.id}":`, relPath(root, autoGenPaths.piers[pier.id].htmlPath))
    }
  }
  // Auto-gen content-script entries for each island
  for (const island of found.islands) {
    autoGenPaths.islands[island.id] = autoGenForIsland({ island, cacheDir, packageRoot: PACKAGE_ROOT, dev })
    log(`auto-gen island "${island.id}":`, relPath(root, autoGenPaths.islands[island.id].path))
  }

  // --- 2. Build Pages (Vite MPA) ---
  const htmlEntries = htmlEntriesFor(found, { autoGenPaths }, { cacheRoot: cacheDir })
  if (Object.keys(htmlEntries).length > 0) {
    log('building pages:', Object.keys(htmlEntries).join(', '))
    const { build } = await import('vite')
    await build(await pagesViteConfig({
      cacheRoot: cacheDir,
      htmlEntries,
      outDir: distDir,
      dev,
      extRoot: root,
    }))
  }

  // --- 3. Build Islands (Vite multi-entry, no HTML) ---
  if (found.islands.length > 0) {
    log('building islands:', found.islands.map((i) => i.id).join(', '))
    const { build } = await import('vite')
    // One Vite build per island. inlineDynamicImports requires a single
    // input — content scripts can't load chunks not in
    // web_accessible_resources, so each island bundles its full graph
    // (including dynamically-imported Mesa runtime) into one self-contained
    // file. Cost: per-island duplication of shared deps. Benefit: every
    // island is a single-file content script with no extra round trips.
    for (const island of found.islands) {
      const islandEntries = {
        [`islands/${island.id}`]: autoGenPaths.islands[island.id].path,
      }
      await build(islandsViteConfig({
        extRoot: root,
        islandEntries,
        outDir: distDir,
        dev,
      }))
    }
  }

  // --- 4. Build Harbor (Vite lib) ---
  if (found.harbor) {
    log('building harbor')
    const { build } = await import('vite')
    await build(harborViteConfig({
      extRoot: root,
      harborEntry: found.harbor.path,
      outDir: distDir,
      dev,
      islandMatches,
    }))
  }

  // --- 5. Emit manifest ---
  const manifest = buildManifest({ config, found, browser })
  writeFileSync(join(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  log('manifest emitted')

  // --- 6. Copy public/ assets (icons etc) ---
  const publicDir = resolve(root, 'public')
  if (existsSync(publicDir)) {
    cpSync(publicDir, distDir, { recursive: true })
    log('copied public/')
  }

  // --- 7. Permission audit (opt-in) ---
  let auditReport = null
  const auditMode = config.permissions?.audit
  if (auditMode) {
    auditReport = runAudit({ distDir, manifest })
    const missingCount = auditReport.missing.length
    const unknownCount = auditReport.unknown.length

    if (verbose || !auditReport.ok || auditReport.unused.length > 0) {
      // Print full report for visibility when there's anything to say
      log('permission audit:')
      for (const line of formatAuditReport(auditReport).split('\n')) {
        if (line.trim()) log('  ' + line)
      }
    } else {
      log(`permission audit: ✓ (${auditReport.namespaces.size} namespaces scanned)`)
    }

    // audit: 'strict' (or true) → fail build on missing/unknown
    // audit: 'warn' → log only
    if (auditMode === 'strict' || auditMode === true) {
      if (missingCount > 0 || unknownCount > 0) {
        throw new Error(
          `Permission audit failed: ${missingCount} missing, ${unknownCount} unknown. ` +
          `Set permissions.audit: 'warn' to log without failing.`
        )
      }
    }
  }

  return { distDir, manifest, found, auditReport }
}

/**
 * Build for both Chrome and Firefox in one call. Each browser gets its own
 * `dist/<browser>/` directory and its own manifest variant. Builds run
 * sequentially — running them in parallel can race on shared cache state.
 *
 * Returns { chrome, firefox } each shaped like buildExtension's return.
 */
export async function buildBoth({ root, verbose = false, dev = null } = {}) {
  const chromeResult  = await buildExtension({ root, browser: 'chrome',  verbose, dev })
  const firefoxResult = await buildExtension({ root, browser: 'firefox', verbose, dev })
  return { chrome: chromeResult, firefox: firefoxResult }
}

function relPath(root, abs) {
  return abs.replace(root, '').replace(/^[/\\]/, '')
}
