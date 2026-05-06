// audit.js — run the permission audit pass.
//
// Inputs:
//   - distDir: path to built dist/<browser>/ output
//   - manifest: the emitted manifest object (post-buildManifest)
//   - config: the loaded jetty.config.js (for context)
//
// Output:
//   {
//     missing:    Array<{ permission, namespaces, files }>   — declared in manifest but used in code (these need adding)
//     unused:     Array<string>                               — declared in manifest but never used (candidates for removal)
//     unknown:    Array<{ namespace, files }>                 — chrome.<x>.* where x isn't in the catalog
//     dynamic:    Array<{ file, count }>                      — files using chrome[expr] dynamic access
//     namespaces: Map<string, Set<string>>                    — namespace → files that use it
//     ok:         boolean                                     — true if no missing/unknown
//   }
//
// The audit emits findings; severity (warn vs error) is the caller's call.
// In practice:
//   - missing → warn (auto-add at manifest time later, or block prod build)
//   - unused → info (just a heads up)
//   - unknown → warn (catalog gap or typo)
//   - dynamic → info (possible blind spot)

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { permissionFor, isFreePermission } from './permission-catalog.js'
import { scanSource }                       from './scan-source.js'

/**
 * @param {Object} opts
 * @param {string} opts.distDir
 * @param {object} opts.manifest
 * @returns audit report (see above)
 */
export function runAudit({ distDir, manifest }) {
  const namespaces       = new Map()  // ns → Set<file>
  const dynamicByFile    = new Map()
  const declaredPerms    = new Set(manifest.permissions ?? [])

  // Collect all .js files under distDir (recursive, skipping source maps).
  const jsFiles = collectJsFiles(distDir)

  for (const filePath of jsFiles) {
    const source = readFileSync(filePath, 'utf8')
    const { namespaces: foundNs, dynamicAccessCount } = scanSource(source)
    const relFile = relative(distDir, filePath)

    for (const ns of foundNs) {
      let set = namespaces.get(ns)
      if (!set) { set = new Set(); namespaces.set(ns, set) }
      set.add(relFile)
    }
    if (dynamicAccessCount > 0) {
      dynamicByFile.set(relFile, dynamicAccessCount)
    }
  }

  // Map namespaces to required permissions, partition into known/unknown/free.
  const requiredByPerm = new Map() // perm → Set<namespace>
  const unknownNs      = []

  for (const [ns, files] of namespaces) {
    const perm = permissionFor(ns)
    if (perm === null) {
      unknownNs.push({ namespace: ns, files: [...files] })
      continue
    }
    if (isFreePermission(perm)) continue

    const perms = Array.isArray(perm) ? perm : [perm]
    // For arrays (any-of-these), require any one to be declared. We track
    // them all and fail only if none is present.
    for (const p of perms) {
      let set = requiredByPerm.get(p)
      if (!set) { set = new Set(); requiredByPerm.set(p, set) }
      set.add(ns)
    }
    // If it's an array, store the alternatives so we can interpret correctly.
    // For now, jetty's catalog has no real alternatives — leave for future.
  }

  // Determine missing: requiredByPerm keys not in declaredPerms
  const missing = []
  for (const [perm, nsSet] of requiredByPerm) {
    if (!declaredPerms.has(perm)) {
      const files = new Set()
      for (const ns of nsSet) {
        for (const f of namespaces.get(ns) ?? []) files.add(f)
      }
      missing.push({
        permission: perm,
        namespaces: [...nsSet],
        files:      [...files],
      })
    }
  }

  // Determine unused: declared but not required by any namespace usage
  const requiredPermSet = new Set(requiredByPerm.keys())
  // 'scripting' is auto-added when islands exist — exclude from unused even
  // if no chrome.scripting.* call is in code (Harbor uses it via the framework's
  // own indirection, not via direct chrome.scripting calls in user code).
  const unused = [...declaredPerms].filter((p) => {
    if (requiredPermSet.has(p)) return false
    if (p === 'scripting' && (manifest.web_accessible_resources?.some((r) => r.resources?.some((res) => res.startsWith('islands/'))))) return false
    return true
  })

  // Dynamic accesses
  const dynamic = [...dynamicByFile].map(([file, count]) => ({ file, count }))

  return {
    missing,
    unused,
    unknown: unknownNs,
    dynamic,
    namespaces,
    ok: missing.length === 0 && unknownNs.length === 0,
  }
}

/**
 * Collect all .js files under distDir recursively. Skips:
 *   - .map files (source maps)
 *   - islands/chunks/ (these are dependencies, but bundling means usages
 *     show up in the parent entry too; double-counting them inflates the
 *     report. Audit operates at the entry-file level.)
 *
 * Actually that last bit is wrong — we WANT chunks scanned because the
 * bundler may split things. Keep them.
 */
function collectJsFiles(dir) {
  const out = []
  function walk(d) {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) }
    catch { return }
    for (const ent of entries) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() && ent.name.endsWith('.js')) out.push(p)
    }
  }
  walk(dir)
  return out
}

// --- pretty-printer ---

/**
 * Render an audit report as a human-readable string. Used by CLI commands
 * and the build pipeline when permissions.audit: true is set.
 *
 * @param {ReturnType<typeof runAudit>} report
 * @returns {string}
 */
export function formatAuditReport(report) {
  const lines = []

  if (report.ok) {
    lines.push('✓ Permission audit passed.')
  } else {
    lines.push('✗ Permission audit found issues.')
  }
  lines.push('')

  if (report.missing.length > 0) {
    lines.push(`Missing permissions (${report.missing.length}):`)
    for (const m of report.missing) {
      lines.push(`  - "${m.permission}" — used by namespace: ${m.namespaces.join(', ')}`)
      lines.push(`    files: ${m.files.slice(0, 3).join(', ')}${m.files.length > 3 ? ` (+${m.files.length - 3} more)` : ''}`)
    }
    lines.push('')
  }

  if (report.unknown.length > 0) {
    lines.push(`Unknown namespaces (${report.unknown.length}):`)
    for (const u of report.unknown) {
      lines.push(`  - chrome.${u.namespace} / browser.${u.namespace}`)
      lines.push(`    files: ${u.files.slice(0, 3).join(', ')}${u.files.length > 3 ? ` (+${u.files.length - 3} more)` : ''}`)
    }
    lines.push('  (Catalog gap — file an issue against jetty if these are real Chrome/Firefox APIs.)')
    lines.push('')
  }

  if (report.unused.length > 0) {
    lines.push(`Unused permissions (${report.unused.length}):`)
    for (const p of report.unused) {
      lines.push(`  - "${p}" — declared in manifest but no chrome.* call detected`)
    }
    lines.push('  (Safe to remove unless used dynamically or required for future code.)')
    lines.push('')
  }

  if (report.dynamic.length > 0) {
    lines.push(`Dynamic access points (${report.dynamic.length}):`)
    for (const d of report.dynamic) {
      lines.push(`  - ${d.file}: ${d.count} chrome[expr] / browser[expr] usage(s)`)
    }
    lines.push('  (These may use APIs the audit cannot detect statically.)')
    lines.push('')
  }

  return lines.join('\n')
}
