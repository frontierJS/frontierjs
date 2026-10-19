// FJS-1488 — the "relative `database { path }`" warning is for a RELATIVE path.
// A directory minted for an absolute path is the caller's own statement, and
// `fli test:mutate` mints one per mutant.
import { describe, test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { createClient } from '../src/index.js'
import { createTenantRegistry } from '../src/tenant.js'

const CLI = resolve(import.meta.dir, '..', 'src', 'tools', 'cli.js')

const MINTED = /for a database that was not there/

async function warningsFrom(schema: string, opts: Record<string, unknown> = {}) {
  const warned: string[] = []
  const warn = console.warn
  console.warn = (...a: unknown[]) => { warned.push(a.join(' ')) }
  try {
    const { write, ...rest } = opts
    const db: any = await createClient({ schema, ...rest })
    // a jsonl table makes its directory on the first write
    if (write) await db[write as string].create({ data: { note: 'x' } })
    db.$close()
  } finally { console.warn = warn }
  return warned.filter(w => MINTED.test(w))
}

describe('minted-directory warning', () => {
  test('an absolute sqlite path mints a directory silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'litestone-mint-'))
    try {
      const schema = `database main { path "${join(root, 'nested', 'app.db')}" }\nmodel Thing { id Int @id }`
      expect(await warningsFrom(schema)).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('an absolute jsonl path mints a directory silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'litestone-mint-'))
    try {
      const schema = `database main { path ":memory:" }\ndatabase audit { path "${join(root, 'audit')}/" driver jsonl }\n` +
        `model Note { id Int @id @default(autoincrement())  note String  @@db(audit) }`
      expect(await warningsFrom(schema, { write: 'note' })).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('a relative sqlite path still warns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'litestone-mint-'))
    try {
      const rel = relative(process.cwd(), join(root, 'nested', 'app.db'))
      const schema = `database main { path "${rel}" }\nmodel Thing { id Int @id }`
      expect((await warningsFrom(schema)).length).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  // FJS-2719 — the tenant registry and the CLI receive a path already resolved,
  // so the stated form is what says whether the cwd chose the directory.
  const TENANT_SCHEMA = 'tenancy { strategy database }\nmodel Thing { id Int @id }'

  async function registryWarnings(opts: Record<string, unknown>) {
    const warned: string[] = []
    const warn = console.warn
    console.warn = (...a: unknown[]) => { warned.push(a.join(' ')) }
    try {
      const reg: any = await createTenantRegistry({ schema: TENANT_SCHEMA, ...opts })
      reg.close?.()
    } finally { console.warn = warn }
    return warned.filter(w => MINTED.test(w))
  }

  test('an absolute tenant dir mints a directory silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'litestone-mint-'))
    try {
      expect(await registryWarnings({ dir: join(root, 'nested', 'tenants'), registry: join(root, 'reg.db') })).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('a relative tenant dir still warns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'litestone-mint-'))
    try {
      const rel = relative(process.cwd(), join(root, 'nested', 'tenants'))
      expect((await registryWarnings({ dir: rel, registry: join(root, 'reg.db') })).length).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  function cliWarnings(db: string, cwd: string, flag = false) {
    writeFileSync(join(cwd, 'schema.lite'), 'model Thing { id Int @id }\n')
    writeFileSync(join(cwd, 'litestone.config.js'),
      `export default { schema: './schema.lite', migrations: './migrations'${flag ? '' : `, db: ${JSON.stringify(db)}`} }\n`)
    const r = Bun.spawnSync(['bun', CLI, 'migrate', 'status', ...(flag ? [`--db=${db}`] : [])], { cwd, stdin: 'ignore' })
    return (r.stdout.toString() + r.stderr.toString()).split('\n').filter(l => MINTED.test(l))
  }

  test('the CLI mints the directory of an absolute db path silently', () => {
    const root = mkdtempSync(join(tmpdir(), 'litestone-mint-'))
    try {
      expect(cliWarnings(join(root, 'nested', 'a.db'), root)).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('the CLI mints the directory of a config-relative db path silently', () => {
    const root = mkdtempSync(join(tmpdir(), 'litestone-mint-'))
    try {
      expect(cliWarnings('./nested/a.db', root)).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('the CLI still warns for a relative --db flag', () => {
    const root = mkdtempSync(join(tmpdir(), 'litestone-mint-'))
    try {
      expect(cliWarnings('./nested/a.db', root, true).length).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// FJS-1869 — an anchored declared path is not the cwd's choice: `resolveFrom`
// names the directory, so minting `db/` under it on first boot is expected.
describe('minted-directory warning with an anchor', () => {
  function anchored(resolveFrom: unknown) {
    const root = mkdtempSync(join(tmpdir(), 'litestone-mint-'))
    mkdirSync(join(root, 'db'))
    writeFileSync(join(root, 'db', 'schema.lite'),
      `database main { path "./data/app.db" }\ndatabase audit { path "./data/audit/" driver jsonl }\n` +
      `model Note { id Int @id @default(autoincrement())  note String  @@db(audit) }\n`)
    return { root, opts: { path: join(root, 'db', 'schema.lite'), resolveFrom: resolveFrom === 'root' ? root : resolveFrom } }
  }

  async function run(opts: Record<string, unknown>) {
    const warned: string[] = []
    const warn = console.warn
    console.warn = (...a: unknown[]) => { warned.push(a.join(' ')) }
    try {
      const db: any = await createClient(opts)
      await db.note.create({ data: { note: 'x' } })
      db.$close()
    } finally { console.warn = warn }
    return warned.filter(w => MINTED.test(w))
  }

  test("resolveFrom: 'schema' mints silently", async () => {
    const { root, opts } = anchored('schema')
    try { expect(await run(opts)).toEqual([]) } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('a stated directory mints silently', async () => {
    const { root, opts } = anchored('root')
    try { expect(await run(opts)).toEqual([]) } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
