// Bun worker — handles one split file
// Receives: { srcPath, outPath, splitPipeline, configPath }
// Replies:  { ok, outPath, elapsed, warnings } | { ok: false, error }

import { Database } from 'bun:sqlite'
import { copyFileSync, statSync } from 'fs'
import { introspectSQL, plan, parseLimit } from './framework.js'
import { run } from './runner.js'

function applyPragmas(db) {
  db.run(`PRAGMA journal_mode = OFF`)
  db.run(`PRAGMA synchronous = OFF`)
  db.run(`PRAGMA cache_size = -65536`)
  db.run(`PRAGMA temp_store = MEMORY`)
  db.run(`PRAGMA mmap_size = 268435456`)
}

self.onmessage = ({ data }) => {
  const { srcPath, outPath, splitPipeline } = data
  const warnings = []

  try {
    copyFileSync(srcPath, outPath)
    const db = new Database(outPath)
    applyPragmas(db)

    const schema = introspectSQL(db)
    const { valid, errors, warnings: planWarnings } = plan(splitPipeline, schema)
    warnings.push(...planWarnings)

    if (!valid) {
      db.close()
      self.postMessage({ ok: false, outPath, error: errors.join('; ') })
      return
    }

    const t0 = performance.now()
    db.run('BEGIN')
    const { lines } = run(db, splitPipeline, { verbose: false, collectLogs: true })
    db.run('COMMIT')
    db.run('PRAGMA journal_mode = DELETE')
    db.run('VACUUM')
    const elapsed   = (performance.now() - t0).toFixed(0)
    db.close()

    const sizeBytes = statSync(outPath).size
    self.postMessage({ ok: true, outPath, elapsed, sizeBytes, warnings, lines })
  } catch (err) {
    self.postMessage({ ok: false, outPath, error: err.message })
  }
}
