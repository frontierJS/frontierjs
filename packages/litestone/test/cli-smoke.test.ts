// CLI smoke test — spawns the real `litestone` CLI as a subprocess against
// PascalCase-model fixtures. Catches bugs the unit tests can't see because
// they bypass the CLI wrappers (loadConfig, loadSchema, cmdStudio, cmdRepl).
//
// Each test gets its own scratch dir so tests can't contaminate each other.
// Commands that spawn long-running servers (repl, studio) are torn down
// explicitly — a timeout kill is the fallback.
//
// Run with:  bun test test/cli-smoke.test.ts

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'

// ─── Setup ────────────────────────────────────────────────────────────────────

const CLI    = resolve(import.meta.dir, '..', 'src', 'tools', 'cli.js')
let   rootTmp: string

beforeAll(() => {
  rootTmp = mkdtempSync(join(tmpdir(), 'litestone-smoke-'))
})

afterAll(() => {
  // Best-effort cleanup — don't fail the suite if a leftover file is locked
  try { rmSync(rootTmp, { recursive: true, force: true }) } catch {}
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fresh, isolated scratch dir for one test. Written to disk, returned as abs path. */
function makeFixtureDir(label: string, opts: { schema?: string | null; config?: string } = {}) {
  const dir = mkdtempSync(join(rootTmp, `${label}-`))
  if (opts.schema !== null) {
    writeFileSync(join(dir, 'schema.lite'), opts.schema ?? DEFAULT_SCHEMA, 'utf8')
    writeFileSync(join(dir, 'litestone.config.js'),
      opts.config ?? `export default {
        schema: './schema.lite',
        migrations: './migrations',
        db: './test.db',
      }\n`,
      'utf8',
    )
    mkdirSync(join(dir, 'migrations'), { recursive: true })
  }
  return dir
}

/** Fixture schema — PascalCase singular models, exercises common attributes. */
const DEFAULT_SCHEMA = `
model User {
  id        Int  @id
  email     String     @unique
  name      String?
  role      String     @default("member")
  createdAt DateTime @default(now())
  deletedAt DateTime?

  posts     Post[]

  @@softDelete
  @@index([email])
}

model Post {
  id        Int  @id
  title     String
  body      String
  author    User     @relation(fields: [authorId], references: [id])
  authorId  Int
  createdAt DateTime @default(now())

  @@fts([title, body])
}
`

/**
 * Run the CLI to completion. Returns stdout, stderr, exit code.
 * Throws if the process exceeds the timeout.
 */
async function runCli(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd,
    env:    { ...process.env, ...(opts.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const killer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs)
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(killer)
  return { stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), exit }
}

/**
 * Spawn a long-running CLI (repl / studio) and stream stdout until a matcher
 * fires or the timeout expires. Returns the proc so the caller can kill it.
 */
async function spawnUntil(
  cwd: string,
  args: string[],
  matcher: (buf: string) => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<{ proc: ReturnType<typeof Bun.spawn>; output: string }> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let buf = ''
  const deadline = Date.now() + timeoutMs
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()

  while (Date.now() < deadline) {
    const timeLeft = deadline - Date.now()
    const raced = await Promise.race([
      reader.read(),
      new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), timeLeft)),
    ])
    if ((raced as any).done) break
    const chunk = (raced as any).value as Uint8Array | undefined
    if (chunk) buf += decoder.decode(chunk, { stream: true })
    if (matcher(stripAnsi(buf))) return { proc, output: stripAnsi(buf) }
  }
  // Timeout — reader hasn't matched. Return whatever we've got; caller decides.
  try { reader.releaseLock() } catch {}
  return { proc, output: stripAnsi(buf) }
}

function stripAnsi(s: string) { return s.replace(/\x1b\[[0-9;]*m/g, '') }

async function killProc(proc: ReturnType<typeof Bun.spawn>) {
  try { proc.kill('SIGTERM') } catch {}
  // Give it half a second, then force-kill. Await the exit to avoid zombies.
  const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 500)
  try { await proc.exited } catch {}
  clearTimeout(timer)
}

/** Simple TCP poller — resolves when `port` accepts connections. */
async function waitForPort(port: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const s = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {}, open() {}, close() {}, error() {} } })
      s.end()
      return true
    } catch { /* not yet */ }
    await Bun.sleep(50)
  }
  return false
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CLI smoke — one-shot commands', () => {
  test('init scaffolds schema.lite + config with PascalCase model', async () => {
    const dir = makeFixtureDir('init', { schema: null })  // no pre-written schema
    const r = await runCli(dir, ['init'])
    expect(r.exit).toBe(0)
    expect(existsSync(join(dir, 'schema.lite'))).toBe(true)
    expect(existsSync(join(dir, 'litestone.config.js'))).toBe(true)
    const schema = readFileSync(join(dir, 'schema.lite'), 'utf8')
    // Init's scaffolded schema must use PascalCase singular model names — the
    // state doc's hard convention. Regression guard against accidental reverts.
    expect(schema).toMatch(/model\s+User\s*\{/)
  })

  test('migrate create + apply + status roundtrips against PascalCase models', async () => {
    const dir = makeFixtureDir('migrate')
    const created = await runCli(dir, ['migrate', 'create', 'init'])
    expect(created.exit).toBe(0)
    const files = readdirSync(join(dir, 'migrations'))
    // One .sql file should have been generated for the initial schema
    expect(files.some((f) => f.endsWith('.sql'))).toBe(true)

    const applied = await runCli(dir, ['migrate', 'apply'])
    expect(applied.exit).toBe(0)
    expect(existsSync(join(dir, 'test.db'))).toBe(true)

    const status = await runCli(dir, ['migrate', 'status'])
    expect(status.exit).toBe(0)
    expect(status.stdout.toLowerCase()).toContain('applied')
  })

  test('introspect emits PascalCase singular model names', async () => {
    const dir = makeFixtureDir('introspect')
    await runCli(dir, ['migrate', 'create', 'init'])
    await runCli(dir, ['migrate', 'apply'])

    const r = await runCli(dir, ['introspect', './test.db'])
    expect(r.exit).toBe(0)
    // introspect output goes to stdout (unless --out given). The schema it
    // emits must use PascalCase singular (the new convention).
    expect(r.stdout).toMatch(/model\s+User\b/)
    expect(r.stdout).not.toMatch(/model\s+users\b/)  // no plural/lowercase regression
  })

  test('jsonschema writes valid JSON with PascalCase model keys', async () => {
    const dir = makeFixtureDir('jsonschema')
    await runCli(dir, ['migrate', 'create', 'init'])
    await runCli(dir, ['migrate', 'apply'])

    const outPath = join(dir, 'schema.json')
    const r = await runCli(dir, ['jsonschema', '--out', outPath])
    expect(r.exit).toBe(0)
    expect(existsSync(outPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(outPath, 'utf8'))
    // definitions format uses $defs (JSON Schema draft-07 standard)
    const defs = (parsed as any).$defs ?? (parsed as any).definitions ?? parsed
    expect(defs).toHaveProperty('User')
  })

  test('types --stdout emits PascalCase TypeScript interfaces', async () => {
    const dir = makeFixtureDir('types')
    const r = await runCli(dir, ['types', '--stdout'])
    expect(r.exit).toBe(0)
    // typegen emits `export interface User { ... }` — PascalCase, singular.
    expect(r.stdout).toMatch(/export interface User\b/)
    expect(r.stdout).toMatch(/export interface Post\b/)
    // And the OrderBy type (recently fixed — it used to leak a lowercase `accounts`)
    expect(r.stdout).toMatch(/export type UserOrderBy/)
    // Regression guard: the OrderBy array form must reference the PascalCase
    // row interface, not the raw lowercase schema model name.
    expect(r.stdout).not.toMatch(/keyof Omit<user,/)
  })

  test('doctor runs without crashing', async () => {
    const dir = makeFixtureDir('doctor')
    await runCli(dir, ['migrate', 'create', 'init'])
    await runCli(dir, ['migrate', 'apply'])

    const r = await runCli(dir, ['doctor'])
    // `doctor` may exit non-zero if it flags issues — we just want it to not crash.
    // (A crash would show up as exit 1 with no structured output.)
    expect(r.exit === 0 || r.exit === 1).toBe(true)
    expect(r.stdout.length).toBeGreaterThan(0)
  })

  test('createClient auto-creates the parent directory for a nested db path', async () => {
    // Regression guard for the SQLITE_CANTOPEN bug: a schema that points into
    // a directory that doesn't exist yet must not crash the CLI.
    const dir = makeFixtureDir('nested-db', {
      schema: `
        database main { path "./nested/deep/app.db" }
        ${DEFAULT_SCHEMA}
      `,
      config: `export default { schema: './schema.lite', migrations: './migrations' }\n`,
    })
    const created = await runCli(dir, ['migrate', 'create', 'init'])
    expect(created.exit).toBe(0)
    const applied = await runCli(dir, ['migrate', 'apply'])
    expect(applied.exit).toBe(0)
    expect(existsSync(join(dir, 'nested', 'deep', 'app.db'))).toBe(true)
  })

  test('db push works on a schema with @encrypted fields when ENCRYPTION_KEY is set', async () => {
    // Regression guard: cmdDbPush (and other CLI cmds) used to call
    // createClient without forwarding encryptionKey, so any schema with
    // @encrypted/@secret would crash with "no encryption key was provided".
    const dir = makeFixtureDir('db-push-encrypted', {
      schema: `
        model User {
          id    Int @id
          email String    @unique
          ssn   String    @encrypted
        }
      `,
    })
    const key = 'a'.repeat(64) // 32 bytes hex
    const pushed = await runCli(dir, ['db', 'push'], { env: { ENCRYPTION_KEY: key } })
    expect(pushed.exit).toBe(0)
    expect(pushed.stdout + pushed.stderr).not.toContain('no encryption key was provided')
    expect(existsSync(join(dir, 'test.db'))).toBe(true)
  })

  test('--env-file loads keys from a custom file', async () => {
    // Regression guard for the auto .env loader. Bun reads ./.env on its own,
    // but --env-file must support arbitrary paths (e.g. .env.production).
    const dir = makeFixtureDir('db-push-env-file', {
      schema: `
        model User {
          id    Int @id
          email String    @unique
          ssn   String    @encrypted
        }
      `,
    })
    const key = 'c'.repeat(64)
    writeFileSync(join(dir, 'prod.env'), `ENCRYPTION_KEY=${key}\n`, 'utf8')
    const pushed = await runCli(dir, ['db', 'push', '--env-file=prod.env'])
    expect(pushed.exit).toBe(0)
    expect(pushed.stdout + pushed.stderr).not.toContain('no encryption key was provided')
    expect(existsSync(join(dir, 'test.db'))).toBe(true)
  })

  test('codemod: rewrites old type names in .lite files in place', async () => {
    // Hard-cut migration helper. After the Text/Integer/Real/Blob → String/
    // Int/Float/Bytes rename, this command walks .lite files and applies
    // word-boundary replacements. Default: writes .bak alongside.
    const dir = makeFixtureDir('codemod-basic', {
      schema: `model U { id Integer @id; name Text; data Blob?; price Real }`,
    })
    const r = await runCli(dir, ['codemod'])
    expect(r.exit).toBe(0)
    const after = readFileSync(join(dir, 'schema.lite'), 'utf8')
    expect(after).toContain('id Int @id')
    expect(after).toContain('name String')
    expect(after).toContain('data Bytes')
    expect(after).toContain('price Float')
    expect(after).not.toContain('Integer')
    expect(after).not.toContain('Text')
    expect(after).not.toContain('Blob')
    expect(after).not.toContain(' Real')
    expect(existsSync(join(dir, 'schema.lite.bak'))).toBe(true)
    const bak = readFileSync(join(dir, 'schema.lite.bak'), 'utf8')
    expect(bak).toContain('Integer')   // backup preserves original
  })

  test('codemod --dry-run: prints changes but writes nothing', async () => {
    const dir = makeFixtureDir('codemod-dryrun', {
      schema: `model U { id Integer @id; name Text }`,
    })
    const before = readFileSync(join(dir, 'schema.lite'), 'utf8')
    const r = await runCli(dir, ['codemod', '--dry-run'])
    expect(r.exit).toBe(0)
    expect(r.stdout + r.stderr).toContain('dry-run')
    const after = readFileSync(join(dir, 'schema.lite'), 'utf8')
    expect(after).toBe(before)   // unchanged
    expect(existsSync(join(dir, 'schema.lite.bak'))).toBe(false)
  })

  test('codemod --no-backup: rewrites without .bak file', async () => {
    const dir = makeFixtureDir('codemod-nobackup', {
      schema: `model U { id Integer @id }`,
    })
    const r = await runCli(dir, ['codemod', '--no-backup'])
    expect(r.exit).toBe(0)
    expect(existsSync(join(dir, 'schema.lite.bak'))).toBe(false)
    const after = readFileSync(join(dir, 'schema.lite'), 'utf8')
    expect(after).toContain('Int @id')
  })

  test('full pipeline: schema with trait + type → migrate → types → jsonschema', async () => {
    // Exercises every CLI surface that sees the post-splice schema:
    //   - migrate create / migrate apply (column emission for trait fields)
    //   - litestone types (TypeScript output for the type interface)
    //   - litestone jsonschema (typed JSON $ref)
    //   - litestone doctor (counts traits + types in SCHEMA section)
    const dir = makeFixtureDir('trait-type-full', {
      schema: `
        trait Dates {
          createdAt DateTime @default(now())
          updatedAt DateTime @updatedAt
        }

        type Address {
          street     String
          city       String
          state      String?
          postalCode String
        }

        model User {
          id      Int @id
          name    String
          address Json @type(Address)
          @@trait(Dates)
        }
      `,
    })

    // 1. doctor — should count 1 trait, 1 type
    const doctorBefore = await runCli(dir, ['doctor'])
    expect(doctorBefore.exit).toBe(0)
    expect(doctorBefore.stdout).toContain('1 trait')
    expect(doctorBefore.stdout).toContain('1 type')

    // 2. migrate create — column for spliced trait fields and the typed JSON
    const created = await runCli(dir, ['migrate', 'create', 'init'])
    expect(created.exit).toBe(0)
    const migDir = join(dir, 'migrations')
    const files  = readdirSync(migDir).filter(f => f.endsWith('.sql'))
    expect(files.length).toBeGreaterThan(0)
    const sql = readFileSync(join(migDir, files[0]), 'utf8')
    expect(sql).toContain('"createdAt"')   // from trait
    expect(sql).toContain('"updatedAt"')   // from trait
    expect(sql).toContain('"address"')     // typed JSON column

    // 3. migrate apply
    const applied = await runCli(dir, ['migrate', 'apply'])
    expect(applied.exit).toBe(0)
    expect(existsSync(join(dir, 'test.db'))).toBe(true)

    // 4. types — emits Address interface and uses it on the User.address field
    const types = await runCli(dir, ['types', '--out', './types.d.ts'])
    expect(types.exit).toBe(0)
    const dts = readFileSync(join(dir, 'types.d.ts'), 'utf8')
    expect(dts).toContain('export interface Address {')
    expect(dts).toMatch(/address:\s*Address/)

    // 5. jsonschema — emits Address def and User.address as $ref
    const js = await runCli(dir, ['jsonschema', '--out', './schema.json'])
    expect(js.exit).toBe(0)
    const jsonSchema = JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8'))
    expect(jsonSchema.$defs.Address).toBeDefined()
    expect(jsonSchema.$defs.Address.type).toBe('object')
    expect(jsonSchema.$defs.User.properties.address).toEqual({ $ref: '#/$defs/Address' })
  })
})

describe('CLI smoke — long-running servers', () => {
  test('repl banner shows camelCase accessors, not PascalCase', async () => {
    const dir = makeFixtureDir('repl')
    await runCli(dir, ['migrate', 'create', 'init'])
    await runCli(dir, ['migrate', 'apply'])

    // Wait until the Examples section has been fully printed. The banner
    // prints findMany then count then (optionally) findFirst — wait for the
    // last line that's deterministic across all schemas.
    const { proc, output } = await spawnUntil(
      dir,
      ['repl'],
      (buf) => buf.includes('db.user.count()'),
      { timeoutMs: 6_000 },
    )
    await killProc(proc)

    // The accessor line MUST be camelCase singular. This is the exact bug we
    // shipped: the REPL was printing `db.User.findMany()` (PascalCase).
    expect(output).toContain('db.user.findMany()')
    expect(output).toContain('db.user.count()')
    // And the Tables line too
    expect(output).toMatch(/Tables:\s+[^\n]*\buser\b/)
    expect(output).not.toMatch(/Tables:\s+[^\n]*\bUser\b/)
  })

  test('studio serves /api/info and /api/table against a PascalCase model', async () => {
    const dir  = makeFixtureDir('studio')
    await runCli(dir, ['migrate', 'create', 'init'])
    await runCli(dir, ['migrate', 'apply'])

    // Pick a port unlikely to collide. Bun.serve throws on conflict — that's fine
    // (the test would fail loudly rather than silently connecting to someone else).
    const port = 5100 + Math.floor(Math.random() * 800)
    const { proc, output } = await spawnUntil(
      dir,
      ['studio', `--port=${port}`],
      (buf) => buf.includes('Studio at'),
      { timeoutMs: 6_000 },
    )
    expect(output).toContain(`http://localhost:${port}`)
    expect(await waitForPort(port)).toBe(true)

    try {
      // /api/info — basic health check
      const info = await fetch(`http://localhost:${port}/api/info`).then((r) => r.json())
      expect(Array.isArray(info.schema?.models)).toBe(true)
      // counts are keyed by model name (PascalCase) — regression guard for the
      // studio row-count loop we just fixed. Before the fix, counts all came
      // back as 0 because `sysDb[model.name]` was undefined.
      expect(info.counts).toHaveProperty('User')
      expect(info.counts).toHaveProperty('Post')

      // /api/table — accept the PascalCase model name from the frontend,
      // even though the client is keyed by camelCase internally.
      const tbl = await fetch(`http://localhost:${port}/api/table`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ table: 'User' }),
      }).then((r) => r.json())
      expect(tbl.error).toBeUndefined()
      expect(Array.isArray(tbl.items)).toBe(true)
      expect(Array.isArray(tbl.columns)).toBe(true)
      expect(tbl.columns).toContain('email')

      // And it should also accept the camelCase accessor form (lenient API).
      const tbl2 = await fetch(`http://localhost:${port}/api/table`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ table: 'user' }),
      }).then((r) => r.json())
      expect(tbl2.error).toBeUndefined()
    } finally {
      await killProc(proc)
    }
  })
})
