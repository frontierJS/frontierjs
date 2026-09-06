#!/usr/bin/env bun
// tools/init.ts
// Junction project initializer — run once to scaffold a new project.
//
// Asks a focused set of questions up-front, then generates a complete,
// immediately-runnable project in one shot. No repair loops, no "press
// enter when done" pauses. Everything is generated at the end.
//
// Usage:
//   bunx @frontierjs/junction init           ← in an empty directory
//   bunx @frontierjs/junction init my-api    ← creates ./my-api/
//   bun run tools/init.ts                    ← from inside the framework repo

import * as fs   from 'node:fs'
import * as path from 'node:path'

import { c, paint, ok, note, header, dim, sep, createPrompter } from './ui.ts'
import {
  type GenOptions,
  genPackageJson, genDotEnv, genGitignore,
  genDefaultConfig, genProductionConfig,
  genAppEntryPoint, genService, genTests,
  genReadme, genAuthModule, genMigrationsReadme,
} from './generators.ts'

type Answers = GenOptions

const { rl, ask, select, multiSelect } = createPrompter()

// ─── Interview ────────────────────────────────────────────────────────────

async function interview(targetDir: string): Promise<Answers> {

  console.log()
  console.log(`  ${header('Junction init')}`)
  console.log(`  ${paint(c.gray, 'Answer a few questions to scaffold your project.')}`)
  console.log(`  ${paint(c.gray, 'All choices can be changed later.')}`)
  console.log()
  console.log(sep())

  // ── Project name ────────────────────────────────────────────────
  console.log()
  const defaultName = path.basename(targetDir) || 'my-api'
  const projectName = await ask('Project name', defaultName)

  // ── Port ────────────────────────────────────────────────────────
  const portStr  = await ask('Port', '3000')
  const port     = parseInt(portStr, 10) || 3000

  // ── API prefix ──────────────────────────────────────────────────
  // Default '' — Junction mounts services at /{service} unless told otherwise.
  const apiPrefix = await ask('API prefix (blank for none, e.g. /api or /api/v1)', '')

  // ── Database ────────────────────────────────────────────────────
  const db = await select('Database', [
    {
      value: 'sqlite',
      label: 'SQLite',
      desc:  'file-based, zero config, built into Bun — great for most apps',
    },
    {
      value: 'postgres',
      label: 'Postgres',
      desc:  'needs DATABASE_URL, works with Prisma/Litestone',
    },
    {
      value: 'mysql',
      label: 'MySQL',
      desc:  'needs DATABASE_URL, works with Prisma/Litestone',
    },
    {
      value: 'none',
      label: 'None — add later',
      desc:  'scaffolds without any database config',
    },
  ])

  // ── Auth ────────────────────────────────────────────────────────
  const auth = await select('Auth', [
    {
      value: 'none',
      label: 'None — stub it, add later',
      desc:  'app starts without auth; routes are unprotected until you wire it',
    },
    {
      value: 'better-auth',
      label: 'Better Auth',
      desc:  'full session/API-key auth; needs `bun add better-auth`',
    },
    {
      value: 'api-keys',
      label: 'API keys only',
      desc:  'simple bearer token validation from environment variable',
    },
  ])

  // ── First service ───────────────────────────────────────────────
  console.log()
  console.log(dim('  Scaffolding a starter service gives you a working CRUD endpoint immediately.'))
  const firstServiceRaw = await ask('First service name (leave blank to skip)', 'users')
  const firstService    = firstServiceRaw.toLowerCase().replace(/[^a-z0-9-]/g, '')

  // ── CORS origins ────────────────────────────────────────────────
  console.log()
  console.log(dim("  Production frontend URL(s) for CORS. Separate multiple with commas."))
  console.log(dim("  Leave blank to use '*' in dev — you can set this in config/production.ts later."))
  const originsRaw = await ask('Frontend URL(s) for CORS', '')
  const corsOrigins = originsRaw
    ? originsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : []

  // ── Extras ──────────────────────────────────────────────────────
  const extras = await multiSelect('Optional extras (all can be added later)', [
    {
      value: 'openapi',
      label: 'OpenAPI + Swagger UI',
      desc:  'auto-generated docs at /api/docs',
    },
    {
      value: 'channels',
      label: 'Real-time WebSocket channels',
      desc:  'push events to connected clients after service mutations',
    },
    {
      value: 'webhooks',
      label: 'Webhook delivery',
      desc:  'at-least-once HTTP delivery to external subscribers',
    },
    {
      value: 'ai',
      label: 'AI model adapter',
      desc:  'thin IAIModel abstraction over OpenAI, Anthropic, etc.',
    },
  ])

  return { projectName, port, apiPrefix, db, auth, firstService, corsOrigins, extras }
}

// ─── Summary printer ──────────────────────────────────────────────────────

function printSummary(a: Answers, generated: string[]): void {
  console.log()
  console.log(sep())
  console.log()
  console.log(`  ${header('Generated files')}`)
  console.log()
  for (const f of generated) console.log(ok(paint(c.gray, f)))
  console.log()
  console.log(sep())
  console.log()
  console.log(`  ${header('Next steps')}`)
  console.log()

  if (a.auth === 'better-auth') {
    console.log(note('bun add better-auth'))
  }
  if (a.db === 'postgres' || a.db === 'mysql') {
    console.log(note(`Update DATABASE_URL in .env to point at your ${a.db} instance`))
  }

  console.log(note('bun install'))
  console.log(note('bun run dev'))
  console.log()
  console.log(`  ${paint(c.gray, 'REPL:')}   bun run repl`)
  console.log(`  ${paint(c.gray, 'Audit:')}  bun run setup audit`)

  if (a.extras.includes('openapi')) {
    console.log(`  ${paint(c.gray, 'Docs:')}   http://localhost:${a.port}${a.apiPrefix ?? ''}/docs`)
  }

  console.log()
  console.log(`  ${paint(c.bgreen, '★')} ${paint(c.bwhite, 'Happy building!')}`)
  console.log()
}

// ─── Main ─────────────────────────────────────────────────────────────────

// Resolve target directory — optional first arg
const arg   = Bun.argv[2]
const isDir = arg && !arg.startsWith('--')
const cwd   = isDir ? path.resolve(process.cwd(), arg) : process.cwd()

// Guard: refuse to overwrite an existing project
if (fs.existsSync(path.join(cwd, 'package.json'))) {
  console.error()
  console.error(`  ${paint(c.bred, '✗')} ${paint(c.bwhite, `${cwd} already has a package.json`)}`)
  console.error()
  console.error(`  This looks like an existing project. Run ${paint(c.bcyan, 'bun run setup')} to audit it instead.`)
  console.error(`  If you really want to reinitialize, delete package.json first.`)
  console.error()
  process.exit(1)
}

if (isDir && !fs.existsSync(cwd)) {
  fs.mkdirSync(cwd, { recursive: true })
}

const answers  = await interview(cwd)
const generated: string[] = []

function write(filePath: string, content: string): void {
  const full = path.join(cwd, filePath)
  const dir  = path.dirname(full)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(full, content)
  generated.push(filePath)
}

console.log()
console.log(sep())
console.log()
console.log(`  ${header('Creating project...')}`)
console.log()

// Always generated
write('package.json',          genPackageJson(answers))
write('.env',                  genDotEnv(answers))
write('.gitignore',            genGitignore())
write('config/default.ts',    genDefaultConfig(answers))
write('config/production.ts', genProductionConfig(answers))
write('app.ts',                genAppEntryPoint(answers))
write('tests/app.test.ts',    genTests(answers))
write('README.md',             genReadme(answers))

// Auth module
const authContent = genAuthModule(answers)
if (authContent) write('auth/index.ts', authContent)

// First service
if (answers.firstService) {
  write(`services/${answers.firstService}.service.ts`, genService(answers.firstService, answers))
}

// Database migrations dir
if (answers.db !== 'none') {
  write('migrations/.gitkeep', '')
  const migrationsReadme = genMigrationsReadme(answers)
  if (migrationsReadme) write('migrations/README.md', migrationsReadme)
}

// AI placeholder
if (answers.extras.includes('ai')) {
  // No backtick anywhere in this template: one inside a template literal ends
  // the literal, and the parse error lands on a line further down.
  write('ai/index.ts', `// ai/index.ts
// An AI model adapter. Junction ships the SHAPE — IAIModel, AIBuilder,
// AIRegistry — and no vendor, for the reason FJS-D215 gives: the boundary owns
// the mechanism, and a vendor's API moves on the vendor's schedule.
//
// So the adapter lives here, and it reaches the vendor through app.conduit,
// which is where the deadline, the retry, the auth header and the body encoding
// are already declared per target:
//
//   import { AIRegistry } from '@frontierjs/junction'
//   import type { IAIModel } from '@frontierjs/junction/ai'
//
//   const model: IAIModel = {
//     name: 'claude',
//     async complete(req) {
//       const res = await app.conduit.send('anthropic', {
//         path: '/v1/messages',
//         headers: { 'anthropic-version': '2023-06-01' },
//         body: { model: 'claude-sonnet-5', max_tokens: req.maxTokens ?? 1024, messages: req.messages },
//       })
//       return { content: res.body.content[0].text, model: res.body.model }
//     },
//     async stream(req, onChunk) { throw new Error('not implemented') },
//   }
//
//   export const ai = new AIRegistry().register(model)

export const ai = undefined  // replace with your adapter
`)
}

rl.close()
printSummary(answers, generated)
