// rotate-key.js — `$rotateKey`: re-encrypt every key-reversible column under a
// new key, then swap the client's key cell. Built once over the root ctx; the
// proxies hand the same function to every flavor, and the key lives in
// `ctx.enc` so one assignment reaches all of them.

import { encryptField, decryptField, encryptDeterministic, normalizeKey, makeKeyring } from './encryption.js'
import { modelToTableName } from './ddl.js'

export function makeRotateKey(/** @type {any} */ ctx, /** @type {any} */ deps) {
  const { schema, fieldPolicyMap, secretMap, dbRegistry, pluralizeTableNames } = deps

  // ── $rotateKey ─────────────────────────────────────────────────────────────
  // Re-encrypts every key-reversible column using the current key → newKey and
  // then swaps the client's key. One write transaction per affected database.
  //
  // Usage:
  //   const stats = await db.asSystem().$rotateKey(process.env.NEW_ENCRYPTION_KEY)
  //   // → { users: { rows: 42, fields: 1 }, payments: { rows: 7, fields: 2 } }
  //
  // ── What it carries, and what it refuses to leave behind ───────────────────
  //
  // The key swap at the end is GLOBAL — one client holds one key — so a column
  // this does not rewrite is not "left on the old key", it is UNREADABLE. That
  // was the shape of FJS-253: rotation visited `@secret(rotate: true)` only, and
  // a plain `@encrypted` column beside it read `null` afterwards with nothing
  // thrown at any layer. Every key-reversible column is rotated now.
  //
  // Two kinds cannot be carried, and rotation REFUSES while either is present
  // rather than destroying it:
  //
  //   @hashed                 one-way. There is no plaintext anywhere to re-key,
  //                           so every match silently becomes 0 and no later fix
  //                           can undo it.
  //   @secret(rotate: false)  excluded from re-encryption by declaration.
  //
  // `{ orphan: ['Model.field'] }` is the deliberate opt-in. It is a list of names
  // rather than a boolean so that acknowledging one column cannot silently
  // acknowledge a second one added later.

  // The one answer to "can a key rotation carry this column?", asked by the
  // refusal and by the rotation loop so the two cannot disagree about which
  // columns exist. Every encrypted column is in `fieldPolicyMap` — `@secret`
  // expands to `@encrypted` at parse time — and `secretMap` only says which of
  // them opted out.
  function classifyForRotation() {
    const carry    = {}
    const orphaned = []

    for (const [modelName, fields] of Object.entries(fieldPolicyMap)) {
      for (const [fieldName, policy] of Object.entries(fields)) {
        const key = `${modelName}.${fieldName}`

        if (policy.hashed) {
          orphaned.push({ key, reason: '@hashed — one-way, there is no plaintext to re-key, so every match becomes 0 permanently' })
          continue
        }
        if (!policy.encrypted) continue

        if (secretMap[modelName]?.[fieldName]?.rotate === false) {
          orphaned.push({ key, reason: '@secret(rotate: false) — declared excluded from re-encryption' })
          continue
        }

        ;(carry[modelName] ??= []).push(fieldName)
      }
    }

    return { carry, orphaned }
  }

  async function $rotateKey(rawNewKey, { orphan = [] } = {}) {
    const { carry, orphaned } = classifyForRotation()

    // Nothing encrypted anywhere — no rotation, and no key required to say so.
    if (!Object.keys(carry).length && !orphaned.length) return {}

    // Refuse BEFORE the first write. A rotation that has already rewritten half
    // the database and then complains is a database in two keys with nothing
    // recording which rows are in which.
    const acknowledged = new Set(orphan)
    const unacked      = orphaned.filter(o => !acknowledged.has(o.key))
    if (unacked.length) {
      throw Object.assign(new Error(
        `$rotateKey would leave ${unacked.length} column(s) unreadable and has rotated nothing:\n` +
        unacked.map(o => `  ${o.key} — ${o.reason}`).join('\n') +
        `\nThe key swap is global, so a column this cannot re-encrypt is not carried forward.\n` +
        `This client keeps reading it — the old key stays on its ring — but the next process to\n` +
        `start does not, unless it is given previousEncryptionKeys: ['<the old key>'].\n` +
        `Pass { orphan: [${unacked.map(o => `'${o.key}'`).join(', ')}] } to accept that deliberately.`
      ), { orphaned: unacked.map(o => o.key) })
    }

    if (!ctx.enc.key)
      throw new Error('$rotateKey requires an encryption key on this client — pass { encryptionKey: process.env.ENCRYPTION_KEY } to createClient()')

    const newKey = normalizeKey(rawNewKey)
    if (!newKey || newKey.length !== 32)
      throw new Error('New encryption key must be 32 bytes (64 hex chars)')

    const results = {}

    // Group rotatable fields by their target database so each DB gets one transaction
    const byDb = {}
    for (const [modelName, rotatableFields] of Object.entries(carry)) {
      if (!rotatableFields.length) continue

      const modelDef = schema.models.find(m => m.name === modelName)
      const dbName   = modelDef?.attributes.find(a => a.kind === 'db')?.name ?? 'main'
      if (!byDb[dbName]) byDb[dbName] = []
      byDb[dbName].push({ modelName, modelDef, rotatableFields })
    }

    const ROTATE_BATCH = 1000

    for (const [dbName, models] of Object.entries(byDb)) {
      const conn = dbRegistry[dbName]
      const rawDb = conn?.rawWriteDb
      if (!rawDb) continue   // jsonl or disabled — skip

      // One write transaction per database — per-row auto-commit is ~1000x
      // slower (one WAL commit per UPDATE). BEGIN IMMEDIATE takes the write
      // lock up front so we don't upgrade mid-rotation.
      rawDb.run('BEGIN IMMEDIATE')
      try {
        for (const { modelName, modelDef, rotatableFields } of models) {
          const tableName = modelToTableName(modelDef, pluralizeTableNames)
          const cols      = rotatableFields.map(f => `"${f}"`).join(', ')
          // Alias rowid explicitly — when a table has INTEGER PRIMARY KEY, rowid
          // is an alias for that column and SQLite's driver collapses the duplicate,
          // dropping the `rowid` key from the returned row object.
          // Page by rowid instead of loading the whole table into memory.
          const pageStmt = rawDb.query(
            `SELECT rowid AS __litestone_rowid, ${cols} FROM "${tableName}" WHERE rowid > ? ORDER BY rowid LIMIT ${ROTATE_BATCH}`
          )
          let updated   = 0
          let lastRowid = -9007199254740991   // below any real rowid

          while (true) {
            const rows = pageStmt.all(lastRowid)
            if (!rows.length) break
            for (const row of rows) {
              lastRowid = row.__litestone_rowid
              const sets = []
              const vals = []
              for (const fieldName of rotatableFields) {
                if (row[fieldName] == null) continue
                const plain = decryptField(row[fieldName], ctx.enc.ring ?? ctx.enc.key)
                sets.push(`"${fieldName}" = ?`)
                // Re-encrypt in the mode the field was DECLARED with, not the mode
                // rotation happens to use. Rewriting a deterministic column with a
                // random IV would leave every value readable and every equality
                // filter over it answering nothing, silently, until someone searched.
                const mode = fieldPolicyMap?.[modelName]?.[fieldName]
                vals.push(mode?.encrypted?.deterministic
                  ? encryptDeterministic(plain, newKey)
                  : encryptField(plain, newKey))
              }
              if (!sets.length) continue
              // rawDb.query() caches the prepared statement per distinct SQL shape
              rawDb.query(`UPDATE "${tableName}" SET ${sets.join(', ')} WHERE rowid = ?`).run(...vals, row.__litestone_rowid)
              updated++
            }
            if (rows.length < ROTATE_BATCH) break
          }

          results[modelName] = { rows: updated, fields: rotatableFields.length }
        }
        rawDb.run('COMMIT')
      } catch (err) {
        try { rawDb.run('ROLLBACK') } catch {}
        throw err
      }
    }

    // One assignment reaches every client derived from this one, including the
    // memoized asSystem() proxy built before the rotation. That is the whole
    // reason the key lives in a cell.
    //
    // The OLD key stays on the ring, and that is what makes a partial rotation
    // survivable rather than a loss (`FJS-714`). The loop above is one
    // transaction per DATABASE, so a crash between two commits leaves database
    // A on the new key and B on the old — which used to be undetectable and
    // unreadable, with a single global key setting and no way to say which
    // value was under which. Now every value names its key, both keys are held,
    // and running the rotation again finishes it: a row already on the new kid
    // decrypts, re-encrypts to the same kid, and costs a write rather than a
    // wrong answer.
    if (Object.keys(results).length > 0) {
      const previous = ctx.enc.ring?.all ?? (ctx.enc.key ? [ctx.enc.key] : [])
      ctx.enc.key  = newKey
      ctx.enc.ring = makeKeyring(newKey, previous.filter(k => !k.equals(newKey)))
    }

    return results
  }

  return { $rotateKey }
}
