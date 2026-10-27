/**
 * web/test/verify-repl.mjs — the app prompt, as an operator runs it.
 *
 * **bun, and no server.** `fli app:repl -e` boots the app in its own process
 * (`FJS-D1535`), so there is nothing to start; the argv is built by
 * `app:repl`'s own `callArgv`, so this resolves junction and the app module the
 * way the command does.
 *
 * ─── What only this drive asks ────────────────────────────────────────────
 *
 * Junction's `call-tool.test.ts` asks the same three things of a fixture with a
 * hand-made gate. This asks them of a real app's gate, tenancy and seed, where
 * the failure that reached yuma lived: a `sys` client graded as whatever
 * `createApp({ system })` declares (`FJS-3517`).
 *
 * **`member.readsRows` / `nobody.isRefused`** — PAIRED. The same read at a
 * member's standing answers, and with no `--as` it is refused at the gate, so
 * a prompt that quietly ran as the app passes the first and fails the second.
 *
 * **`sys.filesTheOperator`** — a `sys` write is filed under whoever is at the
 * keyboard (`$USER`), typed `repl`, and `sys.underAsStillTheOperator` says
 * the `--as` standing never is (`FJS-D1534`).
 *
 * **`sys.removeKeepsATombstone`** — `remove()` through `sys` soft-deletes and
 * the default read hides the row; `delete()` is the hard one for every
 * principal. Asked because a probe on yuma used `delete()` and read as `sys`
 * skipping `@@softDelete`.
 *
 * Fixtures are minted per run and hard-deleted in the `finally`.
 */

import { spawnSync }       from 'node:child_process'
import { dirname, join }   from 'node:path'
import { fileURLToPath }   from 'node:url'

import { callArgv }        from '../../../packages/cli/core/app-entry.js'
import { results, report } from './lib/report.mjs'

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), '../..')
const TENANT = 'flagship'
const MEMBER = 'alex@shop.test'
const RUN    = String(Date.now()).slice(-6)
const OP     = `verify-repl-${RUN}`
const EMAIL  = (tag) => `repl-${tag}-${RUN}@verify.test`

const { got, t } = results()

/** One `fli app:repl -e`, answering its exit, its parsed stdout and its stderr. */
function repl(code, { as, user = OP } = {}) {
  const plan = callArgv(ROOT, { as, tenant: TENANT, code, cwd: ROOT })
  if (plan.error) throw new Error(plan.error)
  const r = spawnSync(plan.argv[0], plan.argv.slice(1), {
    cwd: plan.cwd, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, USER: user, NODE_ENV: 'development' },
  })
  let value
  try { value = r.stdout.trim() ? JSON.parse(r.stdout) : undefined } catch { value = r.stdout }
  return { code: r.status, value, err: r.stderr }
}

const customer = (tag) =>
  `{ name: 'repl ${tag}', firstName: 'Repl', lastName: '${tag}', email: '${EMAIL(tag)}' }`

const trailFor = (email) =>
  `const c = await sys.customer.findFirst({ where: { email: '${email}' }, withDeleted: true }); ` +
  `const rows = await sys.auditTrail.findMany({ where: { model: 'Customer' } }); ` +
  `return rows.filter(r => r.records?.includes(c.id)).map(r => [r.operation, r.actorId, r.actorType])`

let stoppedEarly = null

try {
  const member = repl('db.customer.count()', { as: MEMBER })
  t('member.readsRows', member.code === 0 && member.value > 0)

  const nobody = repl('db.customer.count()')
  t('nobody.isRefused', nobody.code === 1 && nobody.value === undefined && /requires level/.test(nobody.err))

  repl(`await sys.customer.create({ data: ${customer('sys')} }); return 1`)
  t('sys.filesTheOperator', repl(trailFor(EMAIL('sys'))).value)

  repl(`await sys.customer.create({ data: ${customer('as')} }); return 1`, { as: MEMBER })
  t('sys.underAsStillTheOperator', repl(trailFor(EMAIL('as'))).value)

  const soft = repl(
    `const c = await sys.customer.create({ data: ${customer('soft')} }); ` +
    `const r = await sys.customer.remove({ where: { id: c.id } }); ` +
    `return [r.deletedAt !== null, ` +
    `await sys.customer.count({ where: { id: c.id } }), ` +
    `await sys.customer.count({ where: { id: c.id }, withDeleted: true })]`)
  t('sys.removeKeepsATombstone', soft.value)
} catch (err) {
  stoppedEarly = err
} finally {
  const emails = ['sys', 'as', 'soft'].map(EMAIL)
  repl(`return (await sys.customer.deleteMany({ where: { email: { in: ${JSON.stringify(emails)} } } })).count`)
}

const failed = report(got, {
  'member.readsRows':            true,
  'nobody.isRefused':            true,
  'sys.filesTheOperator':        [['create', OP, 'repl']],
  'sys.underAsStillTheOperator': [['create', OP, 'repl']],
  'sys.removeKeepsATombstone':   [true, 0, 1],
}, { stoppedEarly })

process.exit(failed ? 1 : 0)
