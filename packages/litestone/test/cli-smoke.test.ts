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
import { execFileSync } from 'child_process'
import { Database } from 'bun:sqlite'
import { createTestEnv } from '../src/testing.js'

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

  // `fli db:pull` runs `litestone introspect --schema <schema>` and passes no
  // path, so this is the only shape the documented command ever uses. It read
  // `cfg.db`, which loadConfig answers as `./development.db` when nothing said
  // otherwise — so for every app that declares a `database` block it named a
  // file the schema never mentions, and the command could not be run at all.
  test('introspect finds the database the SCHEMA declares, given no path', async () => {
    const dir = makeFixtureDir('introspect-declared', {
      schema: `
database main { path "shop.db" }
model Widget { id Int @id  name String }
`,
      config: `export default { schema: './schema.lite', migrations: './migrations' }\n`,
    })
    await runCli(dir, ['migrate', 'create', 'init'])
    await runCli(dir, ['migrate', 'apply'])
    expect(existsSync(join(dir, 'shop.db'))).toBe(true)

    const r = await runCli(dir, ['introspect'])
    expect(r.stderr).not.toMatch(/development\.db/)
    expect(r.exit).toBe(0)
    expect(r.stdout).toMatch(/model\s+Widget\b/)
  })

  test('introspect asks WHICH database when the schema declares several', async () => {
    const dir = makeFixtureDir('introspect-multi', {
      schema: `
database main  { path "main.db" }
database extra { path "extra.db" }
model Widget { id Int @id  name String }
model Note   { id Int @id  body String  @@db(extra) }
`,
      config: `export default { schema: './schema.lite', migrations: './migrations' }\n`,
    })
    await runCli(dir, ['migrate', 'create', 'init'])
    await runCli(dir, ['migrate', 'apply'])

    // One database in, one schema out — the output carries no @@db, so serving
    // the first would silently answer half the question.
    const r = await runCli(dir, ['introspect'])
    expect(r.exit).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/--db=/)

    const named = await runCli(dir, ['introspect', '--db=extra'])
    expect(named.exit).toBe(0)
    expect(named.stdout).toMatch(/model\s+Note\b/)
    expect(named.stdout).not.toMatch(/model\s+Widget\b/)
  })

  // The property the six substring assertions above could never make (FJS-594).
  test('what introspect writes, litestone can read', async () => {
    const dir = makeFixtureDir('introspect-parses')
    await runCli(dir, ['migrate', 'create', 'init'])
    await runCli(dir, ['migrate', 'apply'])

    const outPath = join(dir, 'pulled.lite')
    const r = await runCli(dir, ['introspect', './test.db', `--out=${outPath}`])
    expect(r.exit).toBe(0)

    const { parse } = await import('../src/core/parser.js')
    const parsed = parse(readFileSync(outPath, 'utf8'))
    expect(parsed.errors ?? []).toEqual([])
    expect(parsed.valid).toBe(true)
  })

  // `schemaMutants` mutates TEXT and `mutationScore` parses it, and `parse` does
  // not follow an import — so a schema that imports a fragment read as a file
  // full of `extend model` naming models nothing declared, every mutant died for
  // a reason that had nothing to do with the mutation, and the command refused
  // outright. On basecamp that was all 300 of them (`FJS-597`).
  test('mutate follows an import, and mutates what the fragment declares', async () => {
    const dir = makeFixtureDir('mutate-import', {
      schema: `
import "./vendor.lite"

model Team { id Int @id  name String }
`,
      config: `export default { schema: './schema.lite', migrations: './migrations', db: './test.db' }\n`,
    })
    writeFileSync(join(dir, 'vendor.lite'), `
model Ticket {
  id     Int    @id
  ref    String @unique
  @@gate("2.4.4.5")
}
`, 'utf8')

    const r = await runCli(dir, ['mutate', '--kinds=unique-drop'], { timeoutMs: 60_000 })
    expect(r.stdout + r.stderr).not.toMatch(/does not parse/)
    // The @unique is in the IMPORTED file and nowhere else, so a mutant at all
    // is proof the fragment was read.
    expect(r.stdout).toMatch(/1 mutants/)
    expect(r.exit).toBe(0)
  })

  // The key is read from the environment by every other command in the CLI;
  // this one read `cfg.encryptionKey`, which loadConfig does not populate — so a
  // schema declaring `@secret` could not be BUILT and every mutant came back
  // "refused by the loader", which the score counts as a kill.
  test('mutate reads the encryption key where every other command does', async () => {
    const dir = makeFixtureDir('mutate-secret', {
      schema: `
model Vault {
  id    Int    @id
  label String @unique
  data  String @secret
  @@gate("4.4.4.5")
}
`,
    })
    const key = '11'.repeat(32)
    const r = await runCli(dir, ['mutate', '--kinds=unique-drop'], {
      timeoutMs: 60_000, env: { ENCRYPTION_KEY: key },
    })
    // Without the key the ORIGINAL cannot build, and the control below refuses
    // rather than reporting every mutant killed.
    expect(r.stdout + r.stderr).not.toMatch(/ORIGINAL schema does not build/)
    expect(r.exit).toBe(0)
  })

  test('mutate refuses when the ORIGINAL cannot be built', async () => {
    const dir = makeFixtureDir('mutate-nokey', {
      schema: `
model Vault {
  id    Int    @id
  label String @unique
  data  String @secret
  @@gate("4.4.4.5")
}
`,
    })
    // Same schema, no key. Every mutant would be refused by the loader for a
    // reason that is not about the mutation, and the run would read 100%.
    const r = await runCli(dir, ['mutate', '--kinds=unique-drop'], { timeoutMs: 60_000 })
    expect(r.exit).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/ORIGINAL schema does not build/)
    expect(r.stdout + r.stderr).not.toMatch(/100% killed/)
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

  test('ddl writes a snapshot whose header names the command that regenerates it', async () => {
    const dir = makeFixtureDir('ddl')
    const r   = await runCli(dir, ['ddl'])
    expect(r.exit).toBe(0)

    const out = join(dir, 'ddl.snapshot.sql')
    expect(existsSync(out)).toBe(true)

    const body = readFileSync(out, 'utf8')
    // scripts/ci.mjs's snapshots phase reads this line and reruns it with
    // --check. The schema is named by basename because the phase runs the
    // command from the snapshot's own directory.
    expect(body).toContain('-- generated by: litestone ddl --schema schema.lite')
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS "user"/)
    // Columns are emitted verbatim camelCase — the fact every hand-written
    // statement in an app binds to, and the reason this file is committed.
    expect(body).toContain('"createdAt"')
  })

  test('ddl --check passes on a fresh snapshot and fails on an edited one', async () => {
    const dir = makeFixtureDir('ddl-check')
    await runCli(dir, ['ddl'])

    const current = await runCli(dir, ['ddl', '--check'])
    expect(current.exit).toBe(0)
    expect(current.stdout).toContain('is current')

    const out = join(dir, 'ddl.snapshot.sql')
    writeFileSync(out, readFileSync(out, 'utf8') + '\n-- hand edit\n', 'utf8')

    const stale = await runCli(dir, ['ddl', '--check'])
    expect(stale.exit).toBe(1)
    // The diff itself, not just the verdict — a stale snapshot is read, not
    // regenerated blind.
    expect(stale.stdout).toContain('-- hand edit')
  })

  test('jsonschema --snapshot renders the contract three packages read', async () => {
    const dir = makeFixtureDir('jsonschema-snapshot')
    const r   = await runCli(dir, ['jsonschema', '--snapshot'])
    expect(r.exit).toBe(0)

    const body = readFileSync(join(dir, 'jsonschema.snapshot.md'), 'utf8')
    expect(body).toContain('<!-- generated by: litestone jsonschema --snapshot --schema schema.lite -->')

    // The three facts a reader branches on and nothing else records: the $defs
    // table (a name missing here is a $ref resolving to nothing in a browser),
    // the keywords a validator runs, and what a create is allowed to send.
    expect(body).toContain('## Definitions')
    expect(body).toMatch(/\|\s*`User`\s*\|\s*model\s*\|/)
    expect(body).toContain('**On create**:')

    const stale = await runCli(dir, ['jsonschema', '--snapshot', '--check'])
    expect(stale.exit).toBe(0)
    expect(stale.stdout).toContain('is current')
  })

  test('access --check answers the same way, so one CI phase drives both', async () => {
    const dir = makeFixtureDir('access-check')
    await runCli(dir, ['access'])

    const body = readFileSync(join(dir, 'access.snapshot.md'), 'utf8')
    expect(body).toContain('<!-- generated by: litestone access --schema schema.lite -->')

    const current = await runCli(dir, ['access', '--check'])
    expect(current.exit).toBe(0)
    expect(current.stdout).toContain('is current')

    const missing = await runCli(makeFixtureDir('access-missing'), ['access', '--check'])
    expect(missing.exit).not.toBe(0)
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

  // `cmdDbPush` branched on skipped / in-sync / migrated and nothing else, so a
  // refused migration printed nothing, fell through to "already in sync" and
  // exited 0 — the command reporting the refusal was the one hiding it
  // (`FJS-646`). Nothing had ever asserted what this command PRINTS.
  test('db push refuses a change that destroys data, and says so', async () => {
    const dir = makeFixtureDir('db-push-loss', {
      schema: `model Post { id Int @id @default(autoincrement())  body String?  keep String? }`,
    })
    expect((await runCli(dir, ['db', 'push'])).exit).toBe(0)

    writeFileSync(join(dir, 'schema.lite'),
      `model Post { id Int @id @default(autoincrement())  content String?  keep String? }`, 'utf8')

    const blocked = await runCli(dir, ['db', 'push'])
    const out     = blocked.stdout + blocked.stderr
    expect(blocked.exit).toBe(1)                    // a script has to be able to see it
    expect(out).toContain('DB not pushed')
    expect(out).toContain('post.body')
    expect(out).toContain('--accept-data-loss')
    expect(out).not.toContain('already in sync')    // the sentence it used to print

    // …and the flag applies it, which is the control: without this the test
    // passes against a command that refuses everything.
    const forced = await runCli(dir, ['db', 'push', '--accept-data-loss'])
    expect(forced.exit).toBe(0)
    expect(forced.stdout + forced.stderr).toContain('DB pushed')
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
  }, 30_000)

  // There is no `down`. `--backup` is the way back, and the run has to be able
  // to say so BEFORE it is the only thing that could have helped.
  test('migrate apply: --backup copies first, and a drop without one is named', async () => {
    const dir = makeFixtureDir('apply-backup', {
      schema: `
        model Post {
          id    Int    @id
          title String
          views Int    @default(0)
        }
      `,
    })

    await runCli(dir, ['migrate', 'create', 'init'])
    await runCli(dir, ['migrate', 'apply'])
    const live = new Database(join(dir, 'test.db'))
    live.run(`INSERT INTO post (title, views) VALUES ('Hello', 42)`)
    live.close()

    // Dropping a column is a rebuild, which is a DROP TABLE.
    writeFileSync(join(dir, 'schema.lite'), `
      model Post {
        id    Int    @id
        title String
      }
    `, 'utf8')
    await runCli(dir, ['migrate', 'create', 'drop_views'])

    const backed = await runCli(dir, ['migrate', 'apply', '--backup'])
    expect(backed.exit).toBe(0)
    expect(backed.stderr).not.toContain('no way back from this run')

    const copies = readdirSync(join(dir, 'backups'))
    expect(copies).toHaveLength(1)
    const copy = new Database(join(dir, 'backups', copies[0], 'main.db'), { readonly: true })
    const cols = copy.query(`PRAGMA table_info(post)`).all().map((c: { name: string }) => c.name)
    copy.close()
    // The copy is of the database as it was BEFORE the migration ran.
    expect(cols).toContain('views')

    // The same run with no copy asked for says what it is about to destroy.
    writeFileSync(join(dir, 'schema.lite'), `
      model Post {
        id Int @id
      }
    `, 'utf8')
    await runCli(dir, ['migrate', 'create', 'drop_title'])
    const bare = await runCli(dir, ['migrate', 'apply'])
    expect(bare.exit).toBe(0)
    expect(bare.stderr).toContain('no way back from this run')
    expect(bare.stderr).toContain('drops 1 table')
  }, 30_000)
})

describe('CLI smoke — long-running servers', () => {
  test('repl banner shows camelCase accessors, not PascalCase', async () => {
    const dir = makeFixtureDir('repl')
    await runCli(dir, ['migrate', 'create', 'init'])
    await runCli(dir, ['migrate', 'apply'])

    // The prompt is the last thing printed, and it is the standing rather than
    // a `>` — waiting for `>` alone would match the banner's own punctuation.
    const { proc, output } = await spawnUntil(
      dir,
      ['repl'],
      (buf) => buf.includes('anonymous(0) >'),
      { timeoutMs: 6_000 },
    )
    await killProc(proc)

    // The accessor list MUST be camelCase singular. This is the exact bug we
    // shipped: the REPL printed `db.User.findMany()` (PascalCase). The banner's
    // worked examples are gone, so the Tables line is where it would surface —
    // `.help` prints the same list, and repl.test.ts asserts that side.
    expect(output).toMatch(/Tables:\s+[^\n]*\buser\b/)
    expect(output).not.toMatch(/Tables:\s+[^\n]*\bUser\b/)

    // And the standing is on the prompt, not only in the banner — the rule the
    // command exists for.
    expect(output).toContain('anonymous(0) >')
  })

  test('studio serves /api/info and /api/table against a PascalCase model', async () => {
    const dir  = makeFixtureDir('studio')
    await runCli(dir, ['migrate', 'create', 'init'])
    await runCli(dir, ['migrate', 'apply'])

    // Ask for 0 and read the answer back. A number picked at random from a
    // range nobody reserved is a collision waiting for a busy machine, and it
    // found one: this test failed twice in four `bun run test` runs and 3/3
    // green alone, which is contention wearing a product defect's clothes
    // (FJS-213). `Bun.serve` throws on conflict, so the failure was loud and
    // in the wrong place. Port 0 cannot collide.
    const { proc, output } = await spawnUntil(
      dir,
      ['studio', '--port=0'],
      (buf) => buf.includes('Studio at'),
      // Generous because this is a cold process start under whatever else the
      // run is doing. At 6s it failed inside `bun run ci` — five phases and
      // every package's suite in flight — and passed on its own, which is the
      // shape that gets a green suite called flaky and then ignored.
      { timeoutMs: 20_000 },
    )
    const port = Number(output.match(/http:\/\/localhost:(\d+)/)?.[1])
    // The bound port, not the requested one — printing 0 back would make the
    // assertion below pass against a server nothing could reach.
    expect(port).toBeGreaterThan(0)
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

// ─── imports in a schema ──────────────────────────────────────────────────────
//
// `createClient` has always resolved `import "./other.lite"` — it goes through
// parseFile. Every CLI command went through `parse(readFileSync(...))` instead,
// so it saw the root file alone, and nothing said so: `db push` compared the
// database against a schema with the imported models missing and reported
// "already in sync" while their tables were never created.
//
// This is the shape `fli auth:install` writes — the app's own models beside an
// imported file it does not own — so it is not a hypothetical layout.

const ROOT_WITH_IMPORT = `
import "./auth.lite"

model Note {
  id     Int     @id
  title  String
}
`

const IMPORTED = `
model Session {
  id      String  @id @default(uuid())
  userId  String
  token   String  @unique
}

model Verification {
  id          Int     @id
  identifier  String
}
`

function makeImportFixture(label: string) {
  const dir = makeFixtureDir(label, { schema: ROOT_WITH_IMPORT })
  writeFileSync(join(dir, 'auth.lite'), IMPORTED, 'utf8')
  return dir
}

describe('a schema that imports another file', () => {

  test('db push creates the imported models tables', async () => {
    const dir = makeImportFixture('push-import')
    const { exit } = await runCli(dir, ['db', 'push'])
    expect(exit).toBe(0)

    const db    = new Database(join(dir, 'test.db'))
    const names = db.prepare("select name from sqlite_master where type = 'table'")
      .all().map((r: any) => r.name)
    db.close()

    // note proves the root file was read at all — without it, an empty database
    // would pass this test by failing everything equally.
    expect(names).toContain('note')
    expect(names).toContain('session')
    expect(names).toContain('verification')
  })

  test('ddl emits the imported models', async () => {
    const dir = makeImportFixture('ddl-import')
    const { stdout, exit } = await runCli(dir, ['ddl', '--stdout'])
    expect(exit).toBe(0)
    expect(stdout).toContain('"note"')
    expect(stdout).toContain('"session"')
    expect(stdout).toContain('"verification"')
  })

  // The baseline `release` compares against comes out of git, where there is no
  // tree for parseFile to walk — so its imports are fetched at the same ref. Read
  // from the working tree instead and the previous release's root schema would be
  // compared against TODAY's imported models, calling every one of them unchanged.
  test('release resolves the baselines imports at the ref, not from disk', async () => {
    const dir = makeImportFixture('release-import')
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })

    git('init', '-q')
    git('add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')

    const unchanged = await runCli(dir, ['release', '--from', 'HEAD', '--json'])
    expect(JSON.parse(unchanged.stdout).verdict).toBe('unchanged')

    // Drop the import and the three imported models must read as REMOVED — which
    // is only possible if the baseline had them. A baseline that skipped imports
    // reports this as unchanged, and reports the opposite edit as three additions.
    writeFileSync(join(dir, 'schema.lite'), ROOT_WITH_IMPORT.replace(/^import .*$/m, ''), 'utf8')

    const dropped = JSON.parse((await runCli(dir, ['release', '--from', 'HEAD', '--json'])).stdout)
    expect(dropped.verdict).toBe('contract')
    expect(dropped.counts.contract).toBe(2)
  })

  // A baseline is parsed by TODAY's validator, and every rule this parser learns
  // is retroactive. The moment `@@unique` over a nullable column became an error
  // (`FJS-437`), every ref written before that commit stopped being a baseline:
  // both commands answered *no baseline* and `--strict`, which fails on no
  // baseline by design, failed every branch. Measured on basecamp against a real
  // ref the day the rule landed.
  //
  // The schema at that ref shipped. Refusing to compare against it because it
  // breaks a rule invented afterwards grades the past by today's law.
  test('a baseline that breaks a rule invented after it is compared anyway', async () => {
    const dir = makeFixtureDir('release-old-rule')
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })

    // Valid before FJS-437, an error now: a composite unique over two optional
    // columns, saying nothing about the NULL rows it cannot constrain.
    const OLD = `
model Variant {
  id        Int     @id
  productId Int
  color    String?
  size      String?
  @@unique([productId, color, size])
}
`
    writeFileSync(join(dir, 'schema.lite'), OLD, 'utf8')
    git('init', '-q')
    git('add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')

    // Today's schema says it meant it, and adds a model.
    writeFileSync(join(dir, 'schema.lite'),
      OLD.replace('@@unique([productId, color, size])',
                  '@@unique([productId, color, size], nullsDistinct: true)') +
      `
model Note { id Int @id  @@gate("2.4.4.5") }
`, 'utf8')

    const out = JSON.parse((await runCli(dir, ['release', '--from', 'HEAD', '--json'])).stdout)
    expect(out.baseline.resolved).toBe(true)
    expect(out.verdict).toBe('expand')

    const access = JSON.parse((await runCli(dir, ['access', '--from', 'HEAD', '--json'])).stdout)
    expect(access.baseline.resolved).toBe(true)
    expect(access.baseline.note).toContain('shipped before they existed')
    expect(access.verdict).toBe('new')
  })

  // The line the leniency does NOT cross: validation rejects a schema the parser
  // understood, and there is nothing to compare when it did not.
  test('a baseline that does not PARSE is still no baseline', async () => {
    const dir = makeFixtureDir('release-unparseable')
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })

    writeFileSync(join(dir, 'schema.lite'), 'model Broken { id Int @id', 'utf8')
    git('init', '-q')
    git('add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')

    writeFileSync(join(dir, 'schema.lite'), 'model Fine { id Int @id }', 'utf8')

    const out = JSON.parse((await runCli(dir, ['access', '--from', 'HEAD', '--json'])).stdout)
    expect(out.baseline.resolved).toBe(false)
    // A syntax error yields no schema at all — `loadFile` collects it and
    // returns null — so this lands on the same branch a genuinely unusable
    // baseline does, and never on the lenient one.
    expect(out.baseline.note).toMatch(/the schema there has errors/)
  })
})

// ─── createTestEnv over a split schema ────────────────────────────────────────
//
// The Testing realm is the half that would have caught the CLI's blindness, and
// it had the same one: `createTestEnv({ schema: 'path' })` read the root file and
// parsed the text. So every executed check — verifyGateLadder, verifyRowPolicies,
// verifyFieldProtection, verifyConstraints — graded a schema with the imported
// models missing, and PASSED. A green ladder over models it never saw is worse
// than no ladder, and `fli auth:install` puts the @@gate("8") credential models
// on exactly that side of the line.

describe('createTestEnv over a schema that imports another file', () => {

  test('the imported models are in the environment and get graded', async () => {
    const dir = makeFixtureDir('env-import', { schema: ROOT_WITH_IMPORT })
    writeFileSync(join(dir, 'auth.lite'), IMPORTED, 'utf8')

    const env = await createTestEnv({ schema: join(dir, 'schema.lite') })
    try {
      const names = env.db.$schema.models.map((m: any) => m.name).sort()
      expect(names).toEqual(['Note', 'Session', 'Verification'])

      // Present in the AST is not present in the DATABASE — the template is
      // built from this text too, so ask the table.
      await env.db.asSystem().session.create({ data: { userId: 'u1', token: 't1' } })
      expect(await env.db.asSystem().session.count()).toBe(1)
    } finally {
      env.close()
    }
  })

  // An unreadable import is a set of models that will silently not be graded,
  // which is the one thing this helper must not do quietly.
  test('an import it cannot read is refused, not warned', async () => {
    const dir = makeFixtureDir('env-import-missing', { schema: ROOT_WITH_IMPORT })
    // auth.lite deliberately not written
    await expect(createTestEnv({ schema: join(dir, 'schema.lite') }))
      .rejects.toThrow(/could not be read/)
  })
})

// ─── importing a package's schema by name ─────────────────────────────────────
//
// The point of FJS-265: a package ships a fragment and apps import it by name,
// so a `bun update` reaches their schema. Before this, `fli auth:install` copied
// auth's models into the app and an upgrade reached nothing.
//
// Resolution is node's, from the importing FILE, so the package's own `exports`
// decides what is importable — nothing guesses at a path inside a package. This
// exercises it through a real CLI process against a real node_modules, which is
// the half a parser unit test cannot answer.

function makePackageFixture(label: string, into = '') {
  const dir = makeFixtureDir(label, {
    schema: `
database main { path "./main.db" }
database vault { path "./vault.db" }

import "frag/schema.lite"${into}

model Note {
  id     Int     @id
  title  String
}
`,
    config: `export default { schema: './schema.lite', migrations: './migrations', db: './test.db' }\n`,
  })

  const pkg = join(dir, 'node_modules', 'frag')
  mkdirSync(join(pkg, 'db'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'),
    JSON.stringify({ name: 'frag', exports: { './schema.lite': './db/models.lite' } }), 'utf8')
  writeFileSync(join(pkg, 'db', 'models.lite'), `
model Shipped {
  id     Int     @id
  label  String
  @@db(main)
}
`, 'utf8')
  return dir
}

describe('a schema importing a package by name', () => {

  test('db push creates the packages models', async () => {
    const dir = makePackageFixture('pkg-import')
    const { exit } = await runCli(dir, ['db', 'push'])
    expect(exit).toBe(0)

    const db    = new Database(join(dir, 'main.db'))
    const names = db.prepare("select name from sqlite_master where type = 'table'")
      .all().map((r: any) => r.name)
    db.close()

    expect(names).toContain('note')
    expect(names).toContain('shipped')
  })

  // `into` is the one parameter that varies between apps, and it beats the @@db
  // the package shipped — a package has to name some database, and only the app
  // knows what its own are called.
  test('into lands them in the apps own database, over the packages @@db', async () => {
    const dir = makePackageFixture('pkg-import-into', ' into vault')
    const { exit } = await runCli(dir, ['db', 'push'])
    expect(exit).toBe(0)

    const tables = (file: string) => {
      const db = new Database(join(dir, file))
      const n  = db.prepare("select name from sqlite_master where type = 'table'")
        .all().map((r: any) => r.name)
      db.close()
      return n
    }

    expect(tables('vault.db')).toContain('shipped')   // the package said main
    expect(tables('main.db')).toContain('note')
    expect(tables('main.db')).not.toContain('shipped')
  })

  test('an unresolvable specifier names both causes and fails', async () => {
    const dir = makeFixtureDir('pkg-import-missing', {
      schema: 'import "@nope/nothing/schema.lite"\nmodel Note { id Int @id }',
    })
    const { exit, stderr, stdout } = await runCli(dir, ['db', 'push'])
    expect(exit).not.toBe(0)
    expect(stdout + stderr).toMatch(/is the package installed, and does it export that subpath\?/)
  })
})
