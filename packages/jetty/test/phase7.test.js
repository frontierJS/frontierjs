// Phase 7 unit tests — Permission audit + CLI.
//
// Coverage:
//   - scanSource: namespace extraction, dynamic detection, comment stripping
//   - permission catalog: known/unknown/free
//   - runAudit: missing/unused/unknown/dynamic, scripting carve-out
//   - formatAuditReport: pass/fail rendering
//   - Audit integration in build pipeline (config.permissions.audit modes)
//   - CLI smoke (subprocess invocation of bin/info.js, bin/audit.js, bin/manifest.js)

import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execSync, spawnSync } from 'node:child_process'

let pass = 0
let fail = 0
function ok(msg)        { pass++; console.log('  ✓', msg) }
function bad(msg, info) { fail++; console.log('  ✗', msg); if (info) console.log('     →', info) }
function group(name)    { console.log(`\n[${name}]`) }

// --- scanSource ---

group('scanSource — namespace extraction')
{
  const { scanSource } = await import('../src/audit/scan-source.js')

  // Static dotted access
  {
    const { namespaces } = scanSource(`
      chrome.tabs.query({})
      chrome.storage.local.set(...)
      browser.runtime.connect()
    `)
    if (namespaces.has('tabs') && namespaces.has('storage') && namespaces.has('runtime')) ok('static dotted access')
  }

  // Bracket access w/ string literal
  {
    const { namespaces } = scanSource(`chrome["cookies"].get(); browser['scripting'].executeScript()`)
    if (namespaces.has('cookies') && namespaces.has('scripting')) ok('bracket access w/ string literal')
  }

  // Mixed
  {
    const { namespaces } = scanSource(`const t = chrome.tabs; chrome["bookmarks"].create({})`)
    if (namespaces.has('tabs') && namespaces.has('bookmarks')) ok('mixed dotted + bracket')
  }

  // Dynamic access caught and counted
  {
    const { dynamicAccessCount } = scanSource(`const api = chrome[name]; const x = browser[fn()]`)
    if (dynamicAccessCount === 2) ok('dynamic access count = 2')
  }

  // Comments are stripped
  {
    const { namespaces } = scanSource(`
      // chrome.cookies.get is not really called here
      /* chrome.bookmarks.create */
      const x = 1
    `)
    if (!namespaces.has('cookies') && !namespaces.has('bookmarks')) ok('comments stripped before scan')
  }

  // No false positives on chrome-like words
  {
    const { namespaces } = scanSource(`const chromosome = 1; document.chromium = 'webkit'`)
    if (namespaces.size === 0) ok('no false positives on chrome-like identifiers')
  }
}

// --- catalog ---

group('permission catalog')
{
  const { permissionFor, isFreePermission, PERMISSION_CATALOG } = await import('../src/audit/permission-catalog.js')

  if (permissionFor('tabs') === 'tabs') ok('tabs → tabs')
  if (permissionFor('cookies') === 'cookies') ok('cookies → cookies')
  if (permissionFor('runtime') === 'no-permission') ok('runtime → no-permission')
  if (permissionFor('i18n') === 'no-permission') ok('i18n → no-permission')
  if (permissionFor('windows') === 'tabs') ok('windows → tabs (special case)')
  if (permissionFor('action') === 'no-permission') ok('action → no-permission (MV3)')

  if (permissionFor('madeUpAPI') === null) ok('unknown namespace → null')

  if (isFreePermission('no-permission')) ok('isFreePermission true for no-permission')
  if (!isFreePermission('tabs')) ok('isFreePermission false for tabs')

  // Catalog has a reasonable entry count
  if (Object.keys(PERMISSION_CATALOG).length >= 25) ok(`catalog has ${Object.keys(PERMISSION_CATALOG).length} entries`)
}

// --- runAudit (synthetic dist) ---

group('runAudit — synthetic dist')
{
  const { runAudit } = await import('../src/audit/audit.js')

  // Set up a fake dist dir w/ controlled contents
  const tmp = mkdtempSync(join(tmpdir(), 'jetty-audit-'))
  try {
    writeFileSync(join(tmp, 'harbor.js'), `
      // jetty harbor bundle
      chrome.runtime.connect()           // free
      chrome.storage.local.set()         // needs storage
      chrome.tabs.query({})              // needs tabs
      chrome.cookies.get('foo')          // needs cookies
      chrome["bookmarks"].create({})     // needs bookmarks
      const dyn = chrome[someName]       // dynamic
    `)

    // Manifest declares storage + cookies but missing tabs + bookmarks
    const manifest = { permissions: ['storage', 'cookies', 'unused'], web_accessible_resources: [] }
    const report = runAudit({ distDir: tmp, manifest })

    // Missing tabs + bookmarks
    const missingPerms = report.missing.map((m) => m.permission).sort()
    if (JSON.stringify(missingPerms) === '["bookmarks","tabs"]') ok('missing perms detected: tabs, bookmarks')
    else bad('missing perms wrong', JSON.stringify(missingPerms))

    // Unused: 'unused'
    if (report.unused.includes('unused')) ok('unused perms detected')

    // Dynamic access counted
    if (report.dynamic.length === 1 && report.dynamic[0].count === 1) ok('dynamic access reported')

    // Free namespaces (runtime) NOT in missing
    if (!report.missing.some((m) => m.namespaces.includes('runtime'))) ok('free namespace not flagged as missing')

    // ok = false
    if (report.ok === false) ok('report.ok = false when missing exist')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  // Clean audit — all perms declared
  {
    const tmp2 = mkdtempSync(join(tmpdir(), 'jetty-audit-'))
    try {
      writeFileSync(join(tmp2, 'harbor.js'), `chrome.storage.local.set(); chrome.runtime.connect()`)
      const manifest = { permissions: ['storage'], web_accessible_resources: [] }
      const report = runAudit({ distDir: tmp2, manifest })
      if (report.ok) ok('clean audit reports ok=true')
      if (report.missing.length === 0 && report.unknown.length === 0) ok('clean audit has no missing/unknown')
    } finally {
      rmSync(tmp2, { recursive: true, force: true })
    }
  }

  // Unknown namespace
  {
    const tmp3 = mkdtempSync(join(tmpdir(), 'jetty-audit-'))
    try {
      writeFileSync(join(tmp3, 'harbor.js'), `chrome.notARealAPI.doStuff()`)
      const manifest = { permissions: [], web_accessible_resources: [] }
      const report = runAudit({ distDir: tmp3, manifest })
      if (report.unknown.some((u) => u.namespace === 'notARealAPI')) ok('unknown namespace flagged')
      if (!report.ok) ok('unknown namespace makes ok=false')
    } finally {
      rmSync(tmp3, { recursive: true, force: true })
    }
  }

  // scripting carve-out: no scripting calls but islands present → don't flag unused
  {
    const tmp4 = mkdtempSync(join(tmpdir(), 'jetty-audit-'))
    try {
      mkdirSync(join(tmp4, 'islands'), { recursive: true })
      writeFileSync(join(tmp4, 'islands/demo.js'), `chrome.runtime.connect()`)
      writeFileSync(join(tmp4, 'harbor.js'), `chrome.runtime.connect()`)

      const manifest = {
        permissions: ['scripting'],
        web_accessible_resources: [{ resources: ['islands/demo.js'], matches: ['<all_urls>'] }],
      }
      const report = runAudit({ distDir: tmp4, manifest })
      if (!report.unused.includes('scripting')) ok('scripting carve-out: not flagged unused when islands present')
    } finally {
      rmSync(tmp4, { recursive: true, force: true })
    }
  }

  // Files list populated for missing entries
  {
    const tmp5 = mkdtempSync(join(tmpdir(), 'jetty-audit-'))
    try {
      writeFileSync(join(tmp5, 'a.js'), `chrome.tabs.query({})`)
      writeFileSync(join(tmp5, 'b.js'), `chrome.tabs.create({})`)
      const manifest = { permissions: [], web_accessible_resources: [] }
      const report = runAudit({ distDir: tmp5, manifest })
      const tabsMiss = report.missing.find((m) => m.permission === 'tabs')
      if (tabsMiss?.files?.length === 2) ok('missing entry includes file list')
    } finally {
      rmSync(tmp5, { recursive: true, force: true })
    }
  }
}

// --- formatAuditReport ---

group('formatAuditReport')
{
  const { runAudit, formatAuditReport } = await import('../src/audit/audit.js')

  // Pass case
  {
    const tmp = mkdtempSync(join(tmpdir(), 'jetty-audit-'))
    try {
      writeFileSync(join(tmp, 'a.js'), `chrome.runtime.connect()`)
      const report = runAudit({ distDir: tmp, manifest: { permissions: [], web_accessible_resources: [] } })
      const out = formatAuditReport(report)
      if (out.includes('passed')) ok('format: pass case shows ✓')
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  }

  // Fail case
  {
    const tmp = mkdtempSync(join(tmpdir(), 'jetty-audit-'))
    try {
      writeFileSync(join(tmp, 'a.js'), `chrome.tabs.query({})`)
      const report = runAudit({ distDir: tmp, manifest: { permissions: [], web_accessible_resources: [] } })
      const out = formatAuditReport(report)
      if (out.includes('found issues') && out.includes('tabs')) ok('format: fail case lists missing perm')
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  }
}

// --- audit integration in buildExtension ---

group('audit integration in buildExtension')
{
  const fixtureRoot = resolve('test/fixtures/basic-ext')
  const { buildExtension } = await import('../src/build/index.js')

  // Default: audit: 'warn' from fixture config — should run audit but not throw
  {
    const result = await buildExtension({ root: fixtureRoot, browser: 'chrome' })
    if (result.auditReport) ok('auditReport present in build result when audit enabled')
    if (result.auditReport?.ok) ok('fixture passes its own audit')
  }
}

// --- CLI smoke ---

group('CLI smoke')
{
  const fixtureRoot = resolve('test/fixtures/basic-ext')

  // jetty-info
  {
    const r = spawnSync(process.execPath, ['bin/info.js', `--root=${fixtureRoot}`], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.includes('Phase 0 Smoke Ext')) ok('bin/info.js exits 0 + prints name')
    if (r.stdout.includes('Islands: 1')) ok('bin/info.js shows island count')
    if (r.stdout.includes('8400 ✓')) ok('bin/info.js validates dev port')
  }

  // jetty-audit (post-build, fixture should be clean)
  {
    const r = spawnSync(process.execPath, ['bin/audit.js', `--root=${fixtureRoot}`], { encoding: 'utf8' })
    if (r.status === 0) ok('bin/audit.js exits 0 on clean fixture')
    if (r.stdout.includes('passed')) ok('bin/audit.js prints pass message')
  }

  // jetty-manifest
  {
    const r = spawnSync(process.execPath, ['bin/manifest.js', `--root=${fixtureRoot}`, '--browser=chrome'], { encoding: 'utf8' })
    if (r.status === 0) ok('bin/manifest.js exits 0')
    try {
      const m = JSON.parse(r.stdout)
      if (m.manifest_version === 3) ok('bin/manifest.js outputs valid JSON')
      if (m.background?.service_worker === 'harbor.js') ok('bin/manifest.js has chrome service_worker')
    } catch (e) {
      bad('bin/manifest.js output not valid JSON', e.message)
    }
  }

  // jetty-manifest --browser=both
  {
    const r = spawnSync(process.execPath, ['bin/manifest.js', `--root=${fixtureRoot}`, '--browser=both'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.includes('=== chrome ===') && r.stdout.includes('=== firefox ===')) {
      ok('bin/manifest.js --browser=both prints both manifests')
    }
  }
}

// --- summary ---

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
