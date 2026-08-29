// journal-runner.mjs — the half that runs on the deploy target.
//
// It binds statements and returns rows. It decides NOTHING: every rule about
// what a deploy may do lives in `core/journal.js`, on the machine running `fli`,
// where the tests are. This file is deliberately too small to be wrong, for the
// same reason `@frontierjs/outpost` takes an injected runner — the half that is
// hard to test is the half that gets shipped somewhere else.
//
// It is copied to the target and run with `bun`, which `deploy:setup` installs.
// `bun:sqlite` is built in, so there is nothing to install and no `node_modules`
// to resolve — the checkout on a target has none, because the build happens
// inside Docker.
//
// Protocol: one JSON object on stdin, one on stdout.
//
//   in   { db, ddl?, statements: [{ name, sql, params }], transaction? }
//   out  { ok: true, results: { <name>: { rows, changes } } }
//        { ok: false, error }
//
// The DDL is `db/ddl.snapshot.sql`, generated from `db/deploy.lite` and gated by
// the `snapshots` CI phase. It is `CREATE TABLE IF NOT EXISTS` throughout, so
// sending it on every call costs a parse and makes a missing journal impossible.

import { Database } from 'bun:sqlite'

const read = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const main = async () => {
  const input = JSON.parse(await read(process.stdin))
  const db    = new Database(input.db, { create: true })

  try {
    // WAL so a reader — `fli deploy:journal`, or the Outpost answering basecamp
    // — never blocks the deploy writing its own history.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    if (input.ddl) db.exec(input.ddl)

    const results = {}
    const run = () => {
      for (const s of input.statements ?? []) {
        const q = db.query(s.sql)
        // `all()` on a statement that returns nothing answers [], and `run()` on
        // one that returns rows discards them — so the shape of the statement
        // decides, and the caller names what it wants back.
        const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(s.sql)
        if (isRead) results[s.name] = { rows: q.all(...(s.params ?? [])), changes: 0 }
        else {
          const r = q.run(...(s.params ?? []))
          results[s.name] = { rows: [], changes: Number(r?.changes ?? 0) }
        }
      }
    }

    if (input.transaction === false) run()
    else db.transaction(run)()

    process.stdout.write(JSON.stringify({ ok: true, results }))
  } catch (err) {
    // Answered rather than thrown: the caller is reading stdout over ssh, where
    // a non-zero exit and a stack trace on stderr is a deploy that fails with
    // "command failed" and no sentence anybody can act on.
    process.stdout.write(JSON.stringify({ ok: false, error: err?.message ?? String(err) }))
    process.exitCode = 1
  } finally {
    db.close()
  }
}

await main()
