// fixtures/audit-browser-scenarios.mjs — what the client does on a host that is
// not a server, asked the same way on two hosts (audit run 2.3, `FJS-D305`).
//
// Each scenario drives `createClient` through a schema that reaches one thing
// the code outside the two seams assumes about the runtime — `process.env`,
// `process.cwd()`, `process.pid`, `setImmediate`, `Buffer`, `Bun.write` — and
// answers what happened: the value, or the error's name, code and first line.
//
// Two runners import this file. `test/browser/audit-browser-seams.mjs` bundles
// it into a module worker over the wasm engine in Chrome, which is the real
// host. `test/fixtures/audit-browser-host.mjs` runs it under
// `node --conditions=browser` with those four globals removed and `node:sqlite`
// registered, which is the half a `bun test` can spawn. A difference between
// the two answers is a fact about the engine; a shared answer that differs from
// Bun's is a fact about the host.

const describeErr = (e) => ({
  error:   true,
  name:    e?.name ?? 'Error',
  code:    e?.code,
  message: String(e?.message ?? e).split('\n')[0].slice(0, 200),
})

const settle = (ms = 30) => new Promise(r => setTimeout(r, ms))

const KEY = 'ab'.repeat(32)   // 64 hex chars, the 32-byte key createClient accepts

export function scenarios({ createClient, parse, deviceSchema = null, rawOpen = null, fileDir = '' }) {
  const open = (lite, options = {}) => createClient({ parsed: parse(lite), db: ':memory:', ...options })

  const warnings = []
  const origWarn = console.warn
  console.warn = (...a) => { warnings.push(a.map(String).join(' ').split('\n')[0].slice(0, 200)); origWarn(...a) }

  return [
    ['host-globals', async () => ({
      setImmediate: typeof globalThis.setImmediate,
      process:      (() => { try { return typeof process } catch { return 'undefined' } })(),
      Buffer:       typeof globalThis.Buffer,
      Bun:          typeof globalThis.Bun,
    })],

    // core/databases.js resolveDbPath reads process.env for `path env(...)`.
    ['env-path', async () => {
      const db = await open(`
database main { path env("AUDIT_PROBE_DB", ":memory:") }
model Item { id Int @id @default(autoincrement())  name String }`, { db: undefined })
      return { opened: true, models: Object.keys(db).filter(k => db[k]?.findMany) }
    }],

    // core/tenancy.js resolveTenancy reads process.cwd() for ANY strategy
    // before it looks at which strategy was declared.
    ['tenancy-row', async () => {
      const db = await open(`
tenancy { strategy row  column workspaceId }
model Project { id Int @id @default(autoincrement())  workspaceId String  name String }`)
      const sys = db.asSystem()
      await sys.project.create({ data: { workspaceId: 'w1', name: 'p' } })
      return { opened: true, count: await sys.project.count() }
    }],

    // Stmt.safeIntegers on bun; wideRow over sqlite3_column_int64 in wasm.
    ['big-int', async () => {
      const db = (await open(`model Event { id Int @id @default(autoincrement())  snowflake Int @big }`)).asSystem()
      await db.event.create({ data: { snowflake: '1152921504606846976' } })
      const row   = await db.event.findFirst()
      const count = await db.event.count()
      return { snowflake: row.snowflake, snowflakeType: typeof row.snowflake, count, countType: typeof count }
    }],

    // An Int that is not @big, holding a value past 2^53. oo1 answers a BigInt
    // past the double range; bun:sqlite answers a rounded Number.
    ['int-past-safe', async () => {
      const db = (await open(`model Num { id Int @id @default(autoincrement())  n Int }`)).asSystem()
      let _created
      try { _created = await db.num.create({ data: { n: 2 ** 60 } }) } catch (e) { return { refused: describeErr(e) } }
      const row = await db.num.findFirst()
      return { n: typeof row.n === 'bigint' ? row.n.toString() + 'n' : row.n, type: typeof row.n }
    }],

    // encryption.js normalizeKey is Buffer.from — before #host's createCipheriv
    // refusal has a chance to say what is wrong.
    ['encrypted-with-key', async () => {
      const db = (await open(`model Vault { id Int @id @default(autoincrement())  secret String @encrypted }`,
        { encryptionKey: KEY })).asSystem()
      await db.vault.create({ data: { secret: 's' } })
      return { wrote: true, back: (await db.vault.findFirst()).secret }
    }],

    ['encrypted-no-key', async () => {
      await open(`model Vault { id Int @id @default(autoincrement())  secret String @encrypted }`)
      return { opened: true }
    }],

    // @@trail writes through a file driver; the write is fire-and-forget and
    // its failure is swallowed into a warning.
    ['trail', async () => {
      warnings.length = 0
      const db = (await open(`
database main  { path ":memory:" }
database audit { path "/audit-probe/"  driver trail }
model Item { id Int @id @default(autoincrement())  name String  @@trail(audit) }`)).asSystem()
      let threw = null
      try { await db.item.create({ data: { name: 'x' } }) } catch (e) { threw = describeErr(e) }
      await settle()
      return { landed: await db.item.count(), threw, warnings: [...warnings] }
    }],

    // The schema a real device is handed: deviceSchema keeps @@trail(audit) on a
    // @@sync model and drops the `audit` database block it names.
    ['trail-device', async () => {
      if (!deviceSchema) return { skipped: 'no deviceSchema in this runner' }
      warnings.length = 0
      const { parsed } = deviceSchema(parse(`
database main  { path "./main.db" }
database audit { path "./audit/"  driver trail }
model Item { id Int @id @default(autoincrement())  name String  @@sync(server)  @@trail(audit) }`))
      const db = (await createClient({ parsed, db: ':memory:' })).asSystem()
      let threw = null
      try { await db.item.create({ data: { name: 'x' } }) } catch (e) { threw = describeErr(e) }
      await settle()
      return { landed: await db.item.count(), threw, warnings: [...warnings] }
    }],

    // A jsonl model is a file, and the browser has none.
    ['jsonl', async () => {
      const db = (await open(`
database main { path ":memory:" }
database logs { path "/logs-probe/"  driver jsonl }
model Log { id String @id @default(uuid())  msg String  @@db(logs) }`)).asSystem()
      await db.log.create({ data: { msg: 'm' } })
      return { wrote: true }
    }],

    // `announce crossProcess` mints a writer id from process.pid at createClient.
    ['cross-process', async () => {
      await open(`
database main { path "/cp-probe.db"  announce crossProcess }
model Item { id Int @id @default(autoincrement())  name String }`,
        { db: undefined, databases: { main: { path: `${fileDir}/cp-probe.db` } } })
      return { opened: true }
    }],

    // hooks.js emit() dispatches with a bare setImmediate.
    ['on-event-hook', async () => {
      let fired = 0
      const db = (await open(`model Item { id Int @id @default(autoincrement())  name String }`,
        { onEvent: { create: () => { fired++ } } })).asSystem()
      let threw = null
      try { await db.item.create({ data: { name: 'x' } }) } catch (e) { threw = describeErr(e) }
      await settle()
      return { fired, threw, landed: await db.item.count() }
    }],

    // FTS5 is a compile-time option; the official wasm build carries it.
    ['fts', async () => {
      const db = (await open(`model Note { id Int @id @default(autoincrement())  body String  @@fts([body]) }`)).asSystem()
      await db.note.create({ data: { body: 'hello wasm world' } })
      await db.note.create({ data: { body: 'nothing here' } })
      const hits = await db.note.search('wasm')
      return { hits: hits.length }
    }],

    ['json', async () => {
      const db = (await open(`model Doc { id Int @id @default(autoincrement())  data Json }`)).asSystem()
      await db.doc.create({ data: { data: { a: [1, 2] } } })
      return { second: (await db.doc.findFirst()).data.a[1] }
    }],

    // core/backup.js is Bun.write and Bun.file, behind no seam.
    ['backup', async () => {
      const db = (await open(`model Item { id Int @id @default(autoincrement())  name String }`)).asSystem()
      const size = await db.$backup(`${fileDir}/backup-probe.db`)
      return { size }
    }],

    // The engine contract's optional serialize(), as the browser engine answers it.
    ['engine-serialize', async () => {
      if (!rawOpen) return { skipped: 'no raw engine handle in this runner' }
      const raw = rawOpen(':memory:')
      try {
        raw.run('CREATE TABLE t (x)')
        const out = typeof raw.serialize === 'function' ? raw.serialize() : 'no serialize()'
        return { type: out === null ? 'null' : out?.constructor?.name ?? typeof out, bytes: out?.byteLength ?? out?.length ?? null }
      } finally { raw.close() }
    }],
  ]
}

export async function runAll(list) {
  const out = []
  for (const [name, fn] of list) {
    try { out.push({ name, value: await fn() }) }
    catch (e) { out.push({ name, value: describeErr(e) }) }
  }
  return out
}
