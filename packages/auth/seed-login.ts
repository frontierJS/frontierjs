// seed-login.ts — upsert one login, the first owner of an App or the dev login
//
// `fli auth:dev-admin` and Basecamp's `apps.seedOwner` both run this file, from
// the App's own node_modules, as `bun node_modules/@frontierjs/auth/seed-login.ts`
// with the input as JSON on stdin (`FJS-D2005`). It is here and not in either
// caller because a deployed App's image vendors auth and never the cli, and
// because the hash is auth's: a copy of the bcrypt call elsewhere writes hashes
// the next auth release may not verify.
//
// The password arrives on stdin and never in argv: argv is readable by every
// process on the machine through `ps`, and Basecamp runs this inside a container
// on a box it does not own.

import { hashPassword, verifyPassword } from './crypto.ts'

export const DEFAULT_LOGIN = { email: 'dev@knight.works', password: 'test1234' } as const

export interface SeedLoginInput {
  email:       string
  password:    string
  name?:       string
  role?:       string
  /** Defaults to `db/schema.lite` under the working directory. */
  schemaPath?: string
}

export interface SeedLoginResult {
  id:    unknown
  email: string
  done:  string[]
  set:   string[]
}

export class SeedLoginRefused extends Error {}

// The default login on a public hostname is a login anyone can guess, so
// production takes only an explicit email AND password (`FJS-D2004`). Both
// halves must move off the default: a known password on a new address is still
// a guessable login once the address leaks.
export function productionRefusal(
  login: { email: string, password: string },
  env: Record<string, string | undefined> = process.env,
  databasePaths: string[] = [],
): string | null {
  if (login.email !== DEFAULT_LOGIN.email && login.password !== DEFAULT_LOGIN.password) return null
  const prodPath = databasePaths.find(p => /prod/i.test(p))
  const where = env.NODE_ENV === 'production' || /prod/i.test(env.DATABASE_URL ?? '')
    ? 'this environment points at production'
    : prodPath ? `${prodPath} looks like a production database` : null
  if (!where) return null
  return `Refused: ${where}, where ${DEFAULT_LOGIN.email} / ${DEFAULT_LOGIN.password} is never a login`
}

/** The upsert, over an open client. Run twice, it changes nothing; run after a
 *  password or role changed, it puts them back. */
export async function seedLogin(db: any, input: SeedLoginInput): Promise<SeedLoginResult> {
  const paths = Object.values(db.$databases ?? {}).map((d: any) => String(d.path ?? ''))
  const refusal = productionRefusal(input, process.env, paths)
  if (refusal) throw new SeedLoginRefused(refusal)

  const model = db.$schema.models.find((m: any) => m.name === 'User')
  if (!model) throw new SeedLoginRefused('Refused: no model User in this schema')
  const has = (name: string, type?: string) =>
    model.fields.some((f: any) => f.name === name && (!type || f.type?.name === type))

  const sys  = db.asSystem()
  const done: string[] = []

  let user = await sys.user.findFirst({ where: { email: input.email } })
  if (!user) {
    user = await sys.user.create({ data: { email: input.email } })
    done.push('created')
  }

  const cred = await sys.credential.findFirst({ where: { userId: user.id, type: 'password' } })
  if (!cred || !(await verifyPassword(input.password, cred.value))) {
    const value = await hashPassword(input.password)
    if (cred) await sys.credential.update({ where: { id: cred.id }, data: { value } })
    else await sys.credential.create({ data: { userId: user.id, type: 'password', value } })
    done.push('password set')
  }

  const data: Record<string, unknown> = {}
  if (input.name && has('name'))          data.name = input.name
  if (input.name && has('displayName'))   data.displayName = input.name
  if (has('isEmailVerified', 'Boolean'))  data.isEmailVerified = true
  if (has('isSystemAdmin', 'Boolean'))    data.isSystemAdmin = true
  if (input.role && has('role', 'String')) data.role = input.role
  await sys.user.update({ where: { id: user.id }, data })

  return { id: user.id, email: input.email, done, set: Object.keys(data) }
}

// The answer is one JSON line on stdout and never carries the password; a
// refusal is one line on stderr and exit 1.
async function main() {
  let input: SeedLoginInput
  try {
    input = JSON.parse(await Bun.stdin.text())
  } catch {
    console.error('Refused: seed-login reads its input as JSON on stdin')
    process.exit(1)
  }
  if (typeof input?.email !== 'string' || typeof input?.password !== 'string' || !input.email || !input.password) {
    console.error('Refused: seed-login needs an email and a password')
    process.exit(1)
  }
  // Refused before a client opens, so a production box never runs a migration
  // check or creates a database file for a login it was always going to refuse.
  const early = productionRefusal(input)
  if (early) {
    console.error(early)
    process.exit(1)
  }

  const { createClient } = await import('@frontierjs/litestone')
  const db = await createClient({
    path:          input.schemaPath ?? `${process.cwd()}/db/schema.lite`,
    resolveFrom:   'schema',
    encryptionKey: process.env.ENCRYPTION_KEY,
  } as any)
  try {
    console.log(JSON.stringify(await seedLogin(db, input)))
  } catch (err) {
    console.error(err instanceof SeedLoginRefused ? err.message : `seed-login failed: ${(err as Error)?.message ?? err}`)
    process.exitCode = 1
  } finally {
    db.$close()
  }
}

if (import.meta.main) await main()
