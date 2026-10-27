#!/usr/bin/env bun
// tools/call.ts
// One service method, once, as somebody — then exit. With no method word, a
// prompt over the same booted app (`FJS-D1532`): a second boot beside any
// serving process, never attached to it (`FJS-D1535`), graded by the app's own
// gate, so there is no `--gate` (`FJS-D1536`).
//
//   junction call --app src/app.ts orders.find '{"status":"paid","$limit":5}' --as alex@shop.test --tenant flagship
//   junction call --app src/app.ts orders.patch 12 '{"note":"late"}' --as alex@shop.test --tenant flagship
//   junction call --app src/app.ts --as alex@shop.test
//   junction call --app src/app.ts -e 'db.order.count()' --as alex@shop.test
//
// Without this, calling a service as a person meant a dev server started in the
// background, a login by curl, a token copied by hand, a sleep and a kill — and
// when that got tedious, sqlite3 against the file, which answers with every gate
// off. This is the call without the socket, through `src/core/call-as.ts`, the
// path devtools' `POST /api/call` runs inside a live app: the app's own caller
// inside `app.runAs`, so the hooks, the gate and the envelope are a request's.
//
// The answer is JSON on stdout and nothing else is: the build's chatter, the
// standing and a refusal all go to stderr, so `| jq` reads it.

import { flag, getFlag, fatal, loadApp, quietly, stopApp, writeOut } from './app-module.ts'
import { actAs, callAs, readable }                                from '../src/core/call-as.ts'
import { WRITE_VERBS }                                            from '../src/core/litestone.ts'
import { homedir }                                                from 'node:os'
import { join }                                                   from 'node:path'

// ─── args ─────────────────────────────────────────────────────────────────────

// The flags that take a value, so the value is not read as an argument to the
// method. A flag named here and not handled below is a flag silently ignored.
const VALUED = new Set(['app', 'export', 'as', 'tenant'])
const BARE   = new Set(['force'])

// `--eval` is read here and not by `getFlag`, which takes a value starting
// with `--` for the next flag — and `-e` is its short form, `db:repl`'s.
const argv = Bun.argv.slice(2)
const words: string[] = []
let code: string | null = null
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '-e' || a === '--eval') {
    code = argv[++i] ?? null
    if (code == null) fatal(`${a} takes an expression: ${a} 'db.order.count()'`)
    continue
  }
  if (a.startsWith('--eval=')) { code = a.slice(7); continue }
  if (a.startsWith('--')) {
    const name = a.slice(2).split('=')[0]
    if (BARE.has(name)) continue
    if (!VALUED.has(name)) fatal(`Unknown flag --${name}. junction call takes ${[...VALUED, ...BARE, 'eval'].map(f => `--${f}`).join(', ')}.`)
    if (!a.includes('=')) i++
    continue
  }
  words.push(a)
}

const USAGE =
  `junction call --app <module> <service>.<method> [id] [json] [--as <who>] [--tenant <id>]`

const appPath = getFlag('app')
if (!appPath) fatal(`Name the app module: ${USAGE}`)

const once = code != null
if (once && words.length) fatal(`-e is the prompt run once and ${words[0]} is one call — name one or the other.`)
if (flag('force') && words.length) fatal(`--force is for a sys write at the prompt, and a call runs no sys.`)

// Only a terminal gets the prompt, or `-e` its one line. A script that dropped
// the method word is refused as it always was — given a prompt, it hangs on a
// stdin nobody writes.
const prompting = !words.length && (once || process.stdin.isTTY)
if (!prompting && !words[0]?.includes('.')) fatal(`Name a method as <service>.<method> — ${USAGE}`)

// A word that parses as JSON is that value, anything else is a string — so `12`
// is an id, `'{"a":1}'` is a bag, and `abc-123` is a string id without quoting
// it twice.
const args: unknown[] = words.slice(1).map(w => { try { return JSON.parse(w) } catch { return w } })

// ─── the prompt ───────────────────────────────────────────────────────────────

const app = await loadApp(appPath, getFlag('export'))

if (prompting) {
  // Litestone is an optional peer of junction; without it the prompt has no
  // loop, and a bare module-not-found names neither.
  const [{ startRepl, evalOnce, replOperator }, { modelToAccessor }] = await Promise.all([
    import('@frontierjs/litestone/repl'), import('@frontierjs/litestone'),
  ]).catch(() =>
    fatal('The prompt is @frontierjs/litestone/repl, and litestone is not installed here. Name a method to call it once.'))
  // The session's standing is a name and a tenant, re-resolved on every `call`
  // and `db` call: `as()` replaces it, and a person deleted mid-session is
  // refused rather than acted as.
  let session: { as?: string; tenant?: string } = { as: getFlag('as') ?? undefined, tenant: getFlag('tenant') ?? undefined }
  const scope = () => session.tenant ? { tenant: session.tenant } : {}

  // A refusal throws, so the prompt prints it as `Forbidden (403): …` and `-e`
  // exits 1 — a returned outcome would print as an answer. The status rides
  // the error too, for a `catch` that branches on it.
  const refusal = (out: { status: number; message: string; name?: string; data?: unknown }) => {
    const err = Object.assign(new Error(out.data ? `${out.message} ${JSON.stringify(out.data)}` : out.message),
      { status: out.status, data: out.data })
    err.name = out.name ? `${out.name} (${out.status})` : `Not called (${out.status})`
    return err
  }
  const atSession = async <T>(fn: () => Promise<T>) => {
    const out = await actAs(app, session, fn)
    if (!out.ok) throw refusal(out)
    return out.result
  }

  const resolve = async (next: typeof session) => {
    const who = await actAs(app, next, async () => {})
    if (!who.ok) throw refusal(who)
    return who.standing
  }
  let standing = await resolve(session).catch(async (err: Error) => { await stopApp(app); fatal(err.message) })
  // The line says who and where; `.standing` prints the whole of it.
  const production = process.env.NODE_ENV === 'production'
  const promptLine = () =>
    `${production ? 'PRODUCTION · ' : ''}${session.as ?? 'nobody'}${session.tenant ? ` · ${session.tenant}` : ''}`

  const call = async (method: string, ...args: unknown[]) => {
    const out = await callAs(app, { method, args, ...session }, { around: quietly })
    if (out.ok) return out.result
    throw refusal(out)
  }

  const as = async (who?: string) => {
    const next = { ...session, as: who }
    standing = await resolve(next)
    session = next
    return standing
  }

  // A `sys` write in production asks for `--force` (`FJS-D1533`). Unforced, `sys`
  // runs `<model>.<verb>()` for a verb that is not a write and nothing else: a
  // root method — `$transaction`, `$rawDbs` — writes under no verb's name, and
  // `sys(fn)` is known to write only once it has run, when rolling the rows back
  // does not unsend the mail a service queued. It guards a slip, not a boundary:
  // `app.runAs(null, …)` is in scope and walks past it.
  const unforced = production && !flag('force')
  const needsForce = (what: string) => Object.assign(
    new Error(`${what} as the app, and NODE_ENV is production. Add --force to the command if that is the intent.`),
    { name: 'Refused' })

  // A client held past the call that opened it answers at whatever standing is
  // ambient when it is used, which at the prompt is none. So `db` and `sys`
  // hold no client: each `<model>.<method>(…)` opens one inside `run`, the way
  // `rowsAs` does.
  type Run = <T>(fn: () => Promise<T>) => Promise<T>
  // `sys` is `asSystem()`, not the client `runAs(null)` scopes: that one is graded
  // as `createApp({ system })`, and an app that declares none — Basecamp — is
  // graded a stranger, so `sys.featureFlag.create` was refused at level 0.
  const clientAt = (name: string, run: Run, mayWrite: boolean, system: boolean, path: string[] = []): unknown =>
    new Proxy(() => {}, {
      get: (_, key) => {
        if (key === 'then') return undefined
        // Printed or coerced, a path would otherwise call itself as `toString`.
        if (typeof key === 'symbol' || key === 'toString' || key === 'valueOf' || key === 'toJSON')
          return () => `${[name, ...path].join('.')} — call a method on it`
        return clientAt(name, run, mayWrite, system, [...path, key])
      },
      apply: (_, __, args) => !mayWrite && (path.length !== 2 || path[0].startsWith('$') || WRITE_VERBS.has(path[1]))
        ? Promise.reject(needsForce(`${[name, ...path].join('.')}() may write`))
        : run(() => app.withDb(async (scoped: any) => {
            // `in` first: a Litestone client throws on a property it lacks. A db
            // with no `asSystem` is refused, not run scoped under the name `sys`.
            if (system && !('asSystem' in scoped)) throw new TypeError(`${name} needs a Litestone client; this app's db has no asSystem()`)
            const db = system ? scoped.asSystem() : scoped
            const owner = path.slice(0, -1).reduce<any>((o, k) => o?.[k], db)
            const fn    = owner?.[path.at(-1)!]
            if (typeof fn !== 'function') throw new TypeError(`${[name, ...path].join('.')} is not a method`)
            return fn.apply(owner, args)
          })),
    })

  // A `sys` write is filed under whoever is at the keyboard, never the session's
  // standing: `--as customer@x` is whose view this is, not who wrote (`FJS-D1534`).
  const operator = replOperator()
  const asApp = <T>(fn: () => Promise<T>) => app.runAs(null, { ...scope(), operator }, fn)
  const db    = clientAt('db', atSession, true, false)
  const sysDb = clientAt('sys', asApp, !unforced, true)
  // `sys(fn)` runs `fn` as the app; `sys.order.count()` is `db:repl`'s `sys`.
  const sys   = new Proxy(sysDb as (fn: () => unknown) => unknown, {
    apply: (_, __, [fn]) => typeof fn !== 'function'
      ? Promise.reject(new TypeError("sys takes a function — sys(() => app.service('orders').find())"))
      : unforced ? Promise.reject(needsForce('sys(fn) may write'))
      : asApp(async () => fn()),
  })

  const found     = await readable(app, session.tenant)
  const accessors = 'models' in found ? found.models.map(modelToAccessor) : []

  const binds = { app, call, as, sys, db }

  // `db:repl`'s contract: the answer alone on stdout, unindented, so `| jq`
  // reads it; the standing and a throw on stderr, and exit 1 on the throw.
  if (once) {
    console.error(`  Standing: ${standing}`)
    let answer = ''
    const exit = await quietly(() => evalOnce({
      code: code!, binds, commandsFrom: null, out: line => { answer += `${line}\n` },
    }))
    await stopApp(app)
    await writeOut(answer)
    process.exit(exit)
  }

  await startRepl({
    binds,
    names:        {
      app:  'the booted app — no port, no work phase',
      call: "call('orders.find', { $limit: 5 }) — one method at this standing, as a request",
      as:   "as('alex@shop.test') switches the standing; as() is nobody",
      sys:  "sys.order.count(), or sys(() => app.service('orders').patch(12, {…})) — the app's own principal, every gate off" +
            (unforced ? '; a write asks for --force in production' : ''),
      db:   'db.order.findMany() — the data client at this standing; inside sys() it is still this standing',
    },
    accessors,
    hints:        [`  Standing: ${standing}`, ''],
    standing:     () => standing,
    prompt:       promptLine,
    history:      join(homedir(), '.junction_call_history'),
    commandsFrom: null,
  })
  await stopApp(app)
  process.exit(0)
}

// ─── the call ─────────────────────────────────────────────────────────────────

const json = (value: unknown) => JSON.stringify(value, (_, v) => {
  if (typeof v === 'bigint')   return `${v}n`
  if (v instanceof Uint8Array) return `<${v.length} bytes>`
  return v
}, 2) ?? String(value)

const out = await callAs(app, {
  method: words[0],
  args,
  as:     getFlag('as') ?? undefined,
  tenant: getFlag('tenant') ?? undefined,
}, { around: quietly })

if (out.standing) console.error(`  Standing: ${out.standing}`)
if (!out.ok) {
  // A call never made is named; one that threw prints the status HTTP would
  // have sent, so a refusal reads apart from a bug.
  if (out.name) console.error(`  ${out.name} (${out.status}): ${out.message}`)
  else console.error(`\n  ✗  ${out.message}\n`)
  if (out.data) console.error(`  ${json(out.data).split('\n').join('\n  ')}`)
}

// `stop()` is what drains a job the boot's worker already claimed — exiting
// past it strands the job until its lease lapses.
await stopApp(app)
if (out.ok) await writeOut(json(out.result) + '\n')
process.exit(out.ok ? 0 : 1)
