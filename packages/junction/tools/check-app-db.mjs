import { createApp } from '/home/claude/review/junction/src/core/app.ts'
const chk = (l, ok, d='') => console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? '  — ' + d : ''}`)

let scopedFor = null
const litestone = {
  $setAuth: (user) => { scopedFor = user; return { __scoped: true, user, $setAuth: litestone.$setAuth } },
  lead: { findMany: async () => [] },
}

const a = createApp({ db: litestone })
chk('app.db is the client we passed', a.db === litestone)
const around = a._appHooks?.around?.all ?? []
chk('around hook installed', around.length === 1)

// authenticated request
const ctx = { auth: { user: { userId: 'u1' } }, locals: {} }
await around[0](ctx, async () => {})
chk('scopes ctx.locals.db to the caller', ctx.locals.db?.__scoped === true)
chk('passes the caller to $setAuth',      scopedFor?.userId === 'u1')

// anonymous request — no user, so no scoping, root client
const anon = { auth: {}, locals: {} }
await around[0](anon, async () => {})
chk('anonymous gets the root client',     anon.locals.db === litestone)

// plain (non-litestone) client
const plain = { lead: { findMany: async () => [] } }
const b = createApp({ db: plain })
chk('plain client: no hook installed',    (b._appHooks?.around?.all ?? []).length === 0)
chk('plain client still on app.db',       b.db === plain)

const c = createApp({})
chk('no db → app.db undefined',           c.db === undefined)
chk('no db → no around hooks',            (c._appHooks?.around?.all ?? []).length === 0)

const d = createApp({ db: litestone })
d.hooks({ around: { all: [async (_c, next) => next()] } })
chk('later app.hooks() compose',          (d._appHooks.around.all ?? []).length === 2)
