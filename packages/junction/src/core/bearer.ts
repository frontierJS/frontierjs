// core/bearer.ts
// `@frontierjs/junction/bearer` — a principal with no session, admitted by a
// token that names a grant row (`bearerClaim`), and the places a token is read
// from (`header`, `cookie`, `authorization`). Bare verbs, which read as token
// sources only under this path (FJS-D1333). Resolved and graded at the Data
// boundary; litestone.ts imports from here, never the reverse at runtime.

import type { ServiceContext } from './context.ts'
import type { TransportContext } from '../transport/types.ts'
import type { HookMap } from './hooks.ts'
import { BadRequest, Unauthorized } from './errors.ts'
import { callDb, currentCall, requestMeta } from './context.ts'
import { resultData, isServiceResult } from './envelope.ts'
import { generateNanoid } from '@frontierjs/toolbelt/ids'
import { fingerprint } from '@frontierjs/toolbelt/bearer'
import type { PrincipalClaims, SelfDescribedResolver, LitestoneClient, ResolvedTenancy } from './litestone.ts'

// 43 characters of a 64-symbol alphabet is 258 bits. A cuid is 24 base36
// characters, about 124, under the 128-bit floor of ASVS V11.5.1.
const mintToken = () => generateNanoid(43)

// ─── bearerClaim ─────────────────────────────────────────────────────────────
//
// The resolver for a caller who has no session and still owns rows: a shopper
// holding a basket, a client following a portal link, a machine holding a key.
// `membershipClaim`'s sibling, and the two divide by what the caller HAS — a
// session that proves who they are, against a string whose holder is the whole
// of the proof.
//
// **One form: the row is read** (`FJS-D343`). The alternative — comparing the
// token to the column it lives on, which is what `example`'s basket did — needs
// no read and cannot answer the three questions a link asks: has it expired,
// was it revoked, and WHICH of several links is this. It also forces the
// token's value onto every child row a policy has to reach, because a policy
// cannot traverse a relation; resolving to an id instead means the children are
// already scoped by the id they carry.
//
// What travels is the SUBJECT, never the token. `@@allow(read, clientId ==
// auth().portalClientId)` compares an id to an id, so the secret stops at this
// function and never reaches a policy, a query or a log line.

/** Where the token is on the request. `header()`, `authorization()` and
 *  `cookie()` are the shipped readers; a path segment is not one (`FJS-D340`). */
export type BearerSource = ((ctx: ServiceContext) => string | null) & {
  /** The request header this source reads, where it reads one. The CORS
   *  preflight and the socket frame allow-list both need it, and without it the
   *  app restates the name in `http.callHeaders` or the preflight drops it. */
  readonly headerName?: string
  /** The cookie this source reads, where it reads one — what `redeem()` sets. */
  readonly cookieName?: string
}

/**
 * Every place a request's headers can be, in the order they are authoritative.
 *
 * `ctx.headers` on a TransportContext and `ctx.caller.headers` on a
 * ServiceContext are the same fact in two shapes, and a resolver runs against
 * whichever one made the call. The request STORE is the third and it is not a
 * fallback for the other two failing: an in-process call carries no client at
 * all — `CallOptions` is auth, transport, locals and directives — so a service
 * calling a service is reached only this way. `membershipClaim` reads its
 * tenant down the same two steps and for the same reason.
 */
function requestHeaders(ctx: ServiceContext): Record<string, string> {
  const meta = requestMeta() as { headers?: Record<string, string>; caller?: { headers?: Record<string, string> } } | null
  return (ctx as { headers?: Record<string, string> }).headers
      ?? ctx.caller?.headers
      ?? meta?.headers
      ?? meta?.caller?.headers
      ?? {}
}

/** Read the token from a request header. */
export function header(name: string): BearerSource {
  const lower = name.toLowerCase()
  // Read whole, `Authorization` is the scheme and the token together, and it is
  // also where a signed-in person's session rides, so every session the auth
  // plugin accepted was fingerprinted, found no grant and refused (`FJS-2150`).
  if (lower === 'authorization') throw new Error(
    `bearerClaim: header('${name}') reads the scheme along with the token, and the same header carries ` +
    `every signed-in person's session. Use authorization(), which takes the token after 'Bearer ' ` +
    `and passes on one the request already signed in with.`)
  const source = (ctx: ServiceContext) => {
    const headers = requestHeaders(ctx)
    // A header name is case-insensitive on the wire and two transports
    // normalize differently, so all three spellings are asked rather than
    // assuming the one this app happens to see today.
    const raw = headers[lower] ?? headers[name] ?? headers[name.toUpperCase()]
    return typeof raw === 'string' && raw ? raw : null
  }
  return Object.assign(source, { headerName: name })
}

/** Read the token from `Authorization: Bearer <token>` — where an API key
 *  travels for every SDK that calls a metered API. */
export function authorization(): BearerSource {
  const raw = (ctx: ServiceContext) => {
    const headers = requestHeaders(ctx)
    return headers.authorization ?? headers.Authorization ?? headers.AUTHORIZATION
  }
  const source = (ctx: ServiceContext) => {
    // The transport reads a Bearer as a session before any resolver runs, and
    // ahead of the cookie and `x-api-key`, so a caller who is signed in on this
    // request was signed in BY this token: it is a session, not a grant, and
    // fingerprinting it would refuse the person as a dead link.
    if (ctx.user) return null
    const value = raw(ctx)
    if (typeof value !== 'string' || !value.startsWith('Bearer ')) return null
    const token = value.slice(7).trim()
    return token || null
  }
  return Object.assign(source, { headerName: 'authorization' })
}

/** Read the token from a cookie — what a redeemed link leaves behind. */
export function cookie(name: string): BearerSource {
  const source = (ctx: ServiceContext) => {
    // A cookie is ambient — the browser sends it on every request to the origin
    // — so a seller who once opened a customer's link carries it on every call
    // of their own session, and once that link is replaced, reading it refuses
    // the seller as a dead link for the cookie's life (`FJS-2175`). A session
    // and a grant are not held together (`FJS-D344`); the session wins.
    if (ctx.user) return null
    const direct = (ctx as { cookies?: Record<string, string> }).cookies?.[name]
                ?? (ctx.caller as { cookies?: Record<string, string> } | undefined)?.cookies?.[name]
    if (typeof direct === 'string' && direct) return direct

    // Parsed here rather than reached for on the context, because a raw route
    // and a socket frame both arrive with the header and neither has a parsed
    // bag. One cookie, split off the header the same way `parseCookies` does,
    // without importing the transport into the Data seam.
    const raw = requestHeaders(ctx).cookie
    if (typeof raw !== 'string' || !raw) return null
    for (const pair of raw.split(';')) {
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      if (pair.slice(0, eq).trim() !== name) continue
      const value = pair.slice(eq + 1).trim()
      return value ? decodeURIComponent(value) : null
    }
    return null
  }
  return Object.assign(source, { cookieName: name })
}

export interface BearerClaimOptions {
  /** Where the token is on the request — `header('x-cart-token')`, `cookie('portal')`. */
  from:    BearerSource
  /** The ACCESSOR of the model holding the grants — its name with a lower first
   *  letter, so `model PortalLink` is `'portalLink'`. A PascalCase name is refused. */
  model:   string
  /** The column holding the token's DIGEST. Never the token: what is stored is
   *  `fingerprint(token, { key, purpose })` and the token itself is in the email
   *  or the header that carried it, nowhere else. */
  column:  string
  /** Claim name → the column on the grant row it is read from. These are what a
   *  policy compares, so they are ids and states, never the token. A dotted
   *  column reads through a relation — `'page.workspaceId'` — which is how a
   *  grant scoped `@@tenant(via: page)` emits the tenant claim without a copy
   *  of the parent's workspace on every grant. */
  claims:  Record<string, string>
  /** The app secret the digest is keyed on. A function where it is per tenant. */
  key:     string | ((ctx: ServiceContext) => string)
  /** Domain separation for the digest. Defaults to `<model>.<column>`, which is
   *  already unique per app; state it only to match an existing column. */
  purpose?: string
  /** The column naming what the grant is FOR — a client, a cart, a user. Written
   *  to the audit trail's `subjectId`, where `actorId` is the grant row
   *  (`FJS-D342`): revoking one link has to be answerable by *which link did
   *  this*, which the subject alone cannot say. */
  subject?: string
  /** How a caller presents the token, quoted into nothing yet — carried for the
   *  same reason `membershipClaim` carries it: once installed this is the only
   *  static answer to *how does a request name its grant*. */
  namedBy?: string
  /** What a request carrying a SESSION as well as this grant is (`FJS-D832`).
   *  `refuse`, the default: a 400 before the grant is read — one caller per
   *  request, because a merged principal is two standings under one name and
   *  a `@default(auth().x)` then stamps the grant's value on a row the
   *  person's own rule admitted (`FJS-1987`). `merge`: the grant's claims join
   *  the session's and the person is the trail's actor — a basket a signed-in
   *  shopper still holds. */
  session?: 'refuse' | 'merge'
}

/** Where this call's resolved grant row is parked, so a service can read the
 *  rest of it — its scope, its purpose, when it expires — without a second
 *  query, and so `installLogContext` can name it as the actor. */
export const BEARER = 'bearer'

/** What `ctx.locals[BEARER]` holds once a grant resolved. */
export interface ResolvedBearer {
  /** The grant row's own primary key — the audit trail's actor. */
  id:      unknown
  /** What the grant is for, where `subject` named a column. */
  subject: unknown
  /** The row itself, so nothing has to read it twice. */
  row:     Record<string, unknown>
  /** The grant model's accessor — which of several grants this is. */
  model:   string
}

/**
 * The grant a NAMED resolver resolved on this call, or null.
 *
 * `ctx.locals[BEARER]` is one slot and a principal list may carry two bearers
 * (a widget's grant beside a survey link, both live on one request), so the
 * slot keeps the FIRST in the app's stated order — the one the trail names as
 * the actor — and each grant is also parked under its model, which is what a
 * service for that model reads.
 */
export function bearerOf(ctx: ServiceContext, model: string): ResolvedBearer | null {
  return (ctx.locals?.[`${BEARER}:${model}`] as ResolvedBearer | undefined) ?? null
}

/** What `mint()` answers: the token, which exists in this answer and wherever
 *  the app sends it, and the row as the caller may read it. */
export interface MintedGrant { token: string; row: Record<string, unknown> }

export interface RedeemOptions {
  /** The cookie's life in seconds. Default: until the grant's `expiresAt`, or
   *  the browser session where the grant declares none. */
  maxAge?:   number
  path?:     string
  sameSite?: 'strict' | 'lax' | 'none'
  secure?:   boolean
}

/** The slice of a raw route's context the redeem reads and answers through. */
export type RedeemContext = Pick<TransportContext, 'body' | 'json' | 'setCookie'>

/**
 * `bearerClaim()`'s answer: the resolver, and the two acts that go with a grant
 * — issuing one and, for a link, trading it for the cookie the resolver reads.
 */
export interface BearerResolver extends SelfDescribedResolver {
  /**
   * Create a grant row on `db`, as whoever `db` is scoped to. The digest is
   * written by naming the column in `system:`, so the model's own `@@gate` and
   * create policy decide who may issue a link, and the trail names the caller.
   * For a `cookie()` bearer the token is a LINK token: `redeem()` trades it for
   * the cookie's own and it is dead from then on (`FJS-D340`).
   */
  mint(db: unknown, data: Record<string, unknown>, extra?: { system?: string[] }): Promise<MintedGrant>
  /**
   * Hooks for the grant model's own `create`, installed with `svc.hooks(...)`:
   * the caller's create is the mint, the answer carries `token` once, and the
   * broadcast carries the row without it.
   */
  mintOnCreate(): HookMap
  /**
   * A raw-route handler for the redeem (`FJS-D340`): `{ token }` in the body,
   * the grant's digest rotated to a fresh token's, that token set as the
   * httpOnly cookie `from` reads, and `{ subject }` answered so the page can
   * open what the link was for. Only a `cookie()` bearer has one.
   */
  redeem(db: unknown, opts?: RedeemOptions): (ctx: RedeemContext) => Promise<Response>
  /**
   * Spend one open of the grant this call resolved (`FJS-D1132`): the third act
   * beside `mint` and `redeem`. Call it once, from the service method that IS
   * the open — the resolver stays a pure read, so a Send's open and its later
   * file fetch are not two spends. The grant's `accessCount` rises by one only
   * while it is under `maxAccessCount` (null is no maximum), in one conditional
   * UPDATE, so the (max+1)th open under concurrency is refused with the same
   * 401 sentence a dead link gets.
   */
  spend(db: unknown, ctx: ServiceContext): Promise<void>
}

const LAST_USED_WINDOW_MS = 4 * 60_000

export function bearerClaim(opts: BearerClaimOptions): BearerResolver {
  // Every request carrying the header would otherwise answer 500 *not a table
  // in this schema*; a model's name reads as the right value for this option.
  if (/^[A-Z]/.test(opts.model)) {
    const accessor = opts.model[0].toLowerCase() + opts.model.slice(1)
    throw new Error(
      `bearerClaim: \`model\` is the client's accessor, not the model's name — ` +
      `\`model ${opts.model}\` is \`'${accessor}'\`.`)
  }
  const purpose = opts.purpose ?? `${opts.model}.${opts.column}`
  // A link and the cookie it is redeemed for digest under different purposes,
  // so an unredeemed link presented as the cookie matches nothing and a
  // redeemed link is dead the moment it was used — a forwarded email that
  // was already clicked answers as one that never existed.
  const linkPurpose = `${purpose}.link`
  const isLink      = !!opts.from.cookieName

  const keyFor = (ctx: ServiceContext | undefined): string => {
    if (typeof opts.key !== 'function') return opts.key
    if (!ctx) throw new Error(
      `bearerClaim: \`key\` is a function and there is no call in progress to hand it. ` +
      `Mint inside a service method, or pass the key as a string.`)
    return opts.key(ctx)
  }
  const systemTable = (db: unknown) => {
    const client = db as LitestoneClient | undefined
    const bare = typeof client?.$setAuth === 'function' ? client.$setAuth(null) : client
    const sys  = typeof bare?.asSystem === 'function' ? bare.asSystem() : bare
    return sys?.[opts.model] as Record<string, (a: Record<string, unknown>) => Promise<unknown>> | undefined
  }

  const resolver = async function bearerClaim(ctx: ServiceContext, user: ServiceContext['user'] | null): Promise<PrincipalClaims> {
    // A token this request does not carry is not a refusal to report: most
    // callers are ordinary signed-in people, and a resolver that recorded
    // *refused* for every one of them would make `NO_CLAIM` meaningless for
    // the requests that really were turned away.
    const token = opts.from(ctx)
    if (!token) return {}

    // Before the lookup, so the refusal says nothing about whether the token
    // works. A request is one caller: a person who also presents a grant is
    // two standings, and merged they put the grant's ids on rows the person's
    // own rule admitted (`FJS-1987`). An app whose signed-in callers still
    // hold a grant states `session: 'merge'` (`FJS-D832`).
    if (user && (opts.session ?? 'refuse') !== 'merge') throw new BadRequest(
      opts.from.headerName === 'authorization'
        ? `This request is signed in and also carries a key. Send one or the other.`
        : `This request is signed in and also carries a link. Sign out to use the link, or drop it.`,
    )

    const db  = callDb(ctx) as LitestoneClient | undefined
    // `$setAuth(null)` first: `$setAuth(u).asSystem()` keeps `u` (`FJS-519`),
    // and under row tenancy `u`'s tenant claim still filters the lookup — so a
    // signed-in member of account B holding account A's link read no grant at
    // all, where the same token signed out did. Who ELSE the holder is must not
    // decide whether the grant is found (`FJS-2091`).
    const bare = typeof db?.$setAuth === 'function' ? db.$setAuth(null) : db
    const sys  = typeof bare?.asSystem === 'function' ? bare.asSystem() : bare

    // asSystem(), for `membershipClaim`'s reason one step further: a grant is
    // what DECIDES this caller's access, and the caller holding it has no
    // session at all, so a client scoped by that access can read nothing.
    const table = sys?.[opts.model] as { findFirst?: (a: Record<string, unknown>) => Promise<unknown> } | undefined

    if (typeof table?.findFirst !== 'function') throw new BadRequest(
      `bearerClaim: no accessor '${opts.model}' on the client. ` +
      `A model's accessor is its name with a lower first letter — ` +
      `\`model PortalLink\` is \`portalLink\`.`,
    )

    const key = typeof opts.key === 'function' ? opts.key(ctx) : opts.key
    if (typeof key !== 'string' || !key) throw new Error(
      `bearerClaim: \`key\` is the secret the stored digest is keyed on, and there is no default. ` +
      `An unkeyed digest can be attacked offline the moment the column leaks.`)

    // The digest is what the column holds, so the token is never in a query,
    // a log line or an error — and a caller cannot present a digest they read
    // somewhere, because the purpose and the key are not theirs to reproduce.
    const digest = await fingerprint(token, { key, purpose })

    // A dotted claim column ('page.workspaceId') is read through the relation,
    // so a grant on a child of a scoped model needs no copy of its parent's scope.
    const relations = [...new Set(Object.values(opts.claims).filter(c => c.includes('.')).map(c => c.split('.')[0]))]

    const row = await table.findFirst({
      where: { [opts.column]: digest },
      ...(relations.length ? { include: Object.fromEntries(relations.map(r => [r, true])) } : {}),
    }) as Record<string, unknown> | null

    // A token that was PRESENTED and does not work is refused, not answered as
    // anonymity: a stranger's list is 200 of nothing and their write a 403 from
    // the rule, so the holder of a dead link could not be told it is dead
    // (`FJS-1999`; the same refusal a dead session gets, `FJS-1830`). No row, a
    // revoked one and an expired one are one answer on purpose — *this link does
    // not work* is all a bearer may learn, or the refusal becomes an oracle for
    // which tokens once existed.
    // The words are the sender's: an API key rides Authorization, a link rides a
    // cookie or a header of the app's own, and a machine holding a key reads
    // nothing about a link it never had (`FJS-2161`). `header()` refuses the name
    // `authorization`, so that name is `authorization()` and nothing else.
    if (!row || !isLive(row, (db as { $now?: () => Date } | undefined)?.$now)) throw new Unauthorized(
      opts.from.headerName === 'authorization'
        ? `This key does not work. It may have expired or been revoked.`
        : `This link does not work. It may have expired or been withdrawn.`,
    )

    const held = {
      id:      row.id ?? null,
      subject: opts.subject ? row[opts.subject] ?? null : null,
      row,
      model:   opts.model,
    } satisfies ResolvedBearer
    ctx.locals[`${BEARER}:${opts.model}`] = held
    ctx.locals[BEARER] ??= held

    // `redeem()` stamps a cookie bearer once; a header bearer never redeems, so
    // the column that says whether a stolen key is in use would stay null. One
    // write per window keeps a hot key off the write path (`FJS-D1140`).
    if ('lastUsedAt' in row && typeof (sys?.[opts.model] as { update?: unknown } | undefined)?.update === 'function') {
      const now  = ((db as { $now?: () => Date } | undefined)?.$now ?? (() => new Date()))()
      const last = row.lastUsedAt == null ? NaN : new Date(row.lastUsedAt as string | number | Date).getTime()
      if (!(now.getTime() - last < LAST_USED_WINDOW_MS)) {
        // A refused stamp (a read-only replica, a read inside a transaction)
        // must not turn a valid key into a failed request.
        await (sys![opts.model] as { update: (a: Record<string, unknown>) => Promise<unknown> })
          .update({ where: { id: row.id }, data: { lastUsedAt: now.toISOString() } })
          .then(() => { row.lastUsedAt = now.toISOString() }, () => {})
      }
    }

    // A grant admits its holder to a tenant and makes them no member of it, so
    // the tenant claim travels as the admission twin (`FJS-D1100`): the schema's
    // tenant deny passes it and `workspaceId == auth().workspaceId` does not.
    // Reading an unknown property off a Litestone client THROWS, hence the try.
    // Inline, not litestone.ts's `tenancyOf`: that import would make the cycle.
    const tenancy = ((): ResolvedTenancy | null => {
      try { return (db as { $tenancy?: ResolvedTenancy | null })?.$tenancy ?? null } catch { return null }
    })()
    const asAdmitted = tenancy?.strategy === 'row' && tenancy.claim && tenancy.admission ? tenancy : null

    return Object.fromEntries(
      Object.entries(opts.claims).map(([claim, column]) => [
        claim === asAdmitted?.claim ? asAdmitted.admission : claim,
        column.split('.').reduce<unknown>((at, key) => (at as Record<string, unknown> | null | undefined)?.[key], row) ?? null,
      ]),
    )
  }

  async function mint(db: unknown, data: Record<string, unknown>, extra: { system?: string[] } = {}): Promise<MintedGrant> {
    const table = (db as Record<string, { create?: (a: Record<string, unknown>) => Promise<unknown> }> | undefined)?.[opts.model]
    if (typeof table?.create !== 'function') throw new BadRequest(
      `bearerClaim: no accessor '${opts.model}' on the client handed to mint(). ` +
      `A model's accessor is its name with a lower first letter.`)
    const token  = mintToken()
    const digest = await fingerprint(token, { key: keyFor(currentCall()), purpose: isLink ? linkPurpose : purpose })
    const row = await table.create({
      data:   { ...data, [opts.column]: digest },
      system: [...new Set([...(extra.system ?? []), opts.column])],
    }) as Record<string, unknown>
    return { token, row }
  }

  function mintOnCreate(): HookMap {
    const MINTED = `${BEARER}.minted:${opts.model}`
    return {
      // After validation, because a @guarded column is not in the client's
      // schema and a digest added before it is refused as an unknown key.
      validated: { create: [async (ctx) => {
        const token = mintToken()
        const data  = ctx.data as Record<string, unknown> | null
        ctx.data = { ...data, [opts.column]: await fingerprint(token, { key: keyFor(ctx), purpose: isLink ? linkPurpose : purpose }) }
        ctx.system.add(opts.column)
        ctx.locals[MINTED] = token
      }] },
      after: { create: [(ctx) => {
        const token = ctx.locals[MINTED]
        if (typeof token !== 'string') return
        const row = resultData(ctx.result) as Record<string, unknown> | null
        // The row goes out to every subscriber; the token goes to the caller.
        ctx.dispatch = row
        ctx.result   = isServiceResult(ctx.result)
          ? { ...ctx.result, data: { ...row, token } }
          : { ...row, token }
      }] },
    }
  }

  function redeem(db: unknown, ro: RedeemOptions = {}) {
    if (!isLink) throw new Error(
      `bearerClaim: redeem() sets the cookie \`from\` reads, and this bearer reads ` +
      `${opts.from.headerName ? `the ${opts.from.headerName} header` : 'no cookie'}. ` +
      `A header bearer is handed its token directly; the redeem is for a link that arrives by email (FJS-D340).`)
    const name = opts.from.cookieName as string
    return async (ctx: RedeemContext): Promise<Response> => {
      const token = (ctx.body as { token?: unknown } | null)?.token
      if (typeof token !== 'string' || !token) return ctx.json({ message: 'A link token is required' }, 400)

      const table = systemTable(db)
      if (typeof table?.findFirst !== 'function') throw new Error(
        `bearerClaim: no accessor '${opts.model}' on the client handed to redeem().`)
      // The key function reads the tenant off the request, and a raw route's
      // context carries the same headers a call's does.
      const key   = keyFor(ctx as unknown as ServiceContext)
      const clock = (db as { $now?: () => Date } | undefined)?.$now ?? (() => new Date())
      const row   = await table.findFirst({ where: { [opts.column]: await fingerprint(token, { key, purpose: linkPurpose }) } }) as Record<string, unknown> | null
      // One sentence for forged, expired, revoked and already redeemed, the
      // resolver's own (`FJS-D696`).
      if (!row || !isLive(row, clock)) return ctx.json({ message: 'This link does not work. It may have expired or been withdrawn.' }, 401)

      const fresh = mintToken()
      await table.update({
        where: { id: row.id },
        data:  { [opts.column]: await fingerprint(fresh, { key, purpose }),
                 ...('lastUsedAt' in row ? { lastUsedAt: clock().toISOString() } : {}) },
      })

      const maxAge = ro.maxAge ?? (row.expiresAt != null
        ? Math.max(0, Math.floor((new Date(row.expiresAt as string).getTime() - clock().getTime()) / 1000))
        : undefined)
      ctx.setCookie(name, fresh, {
        httpOnly: true, sameSite: ro.sameSite ?? 'strict', path: ro.path ?? '/',
        ...(ro.secure !== undefined ? { secure: ro.secure } : {}),
        ...(maxAge !== undefined ? { maxAge } : {}),
      })
      return ctx.json({ subject: opts.subject ? row[opts.subject] ?? null : null }, 200)
    }
  }

  async function spend(db: unknown, ctx: ServiceContext): Promise<void> {
    const held = bearerOf(ctx, opts.model)
    if (!held) throw new Error(
      `bearerClaim: spend() found no '${opts.model}' grant on this call. ` +
      `It spends the grant the resolver read, so the request must carry the token.`)
    if (!('accessCount' in held.row)) throw new Error(
      `bearerClaim: spend() counts in \`accessCount\` and model ${opts.model} declares no such column. ` +
      `Add \`accessCount Int @default(0)\` (and \`maxAccessCount Int?\` for a budget).`)
    const table = systemTable(db)
    if (typeof table?.updateMany !== 'function') throw new Error(
      `bearerClaim: no accessor '${opts.model}' on the client handed to spend().`)

    // The maximum rides the WHERE as a value, not as a column compared to a
    // column: the resolver read it a moment ago, and a `$raw` clause would name
    // the SQL column, which an `@map` renames.
    const max = 'maxAccessCount' in held.row ? held.row.maxAccessCount : null
    const { count } = await table.updateMany({
      where: { id: held.id, ...(max == null ? {} : { accessCount: { lt: max } }) },
      data:  { accessCount: { increment: 1 } },
    }) as { count: number }
    if (count < 1) throw new Unauthorized(
      opts.from.headerName === 'authorization'
        ? `This key does not work. It may have expired or been revoked.`
        : `This link does not work. It may have expired or been withdrawn.`,
    )
  }

  const described = resolver as BearerResolver
  described.describe = () => ({
    kind:     'bearer',
    model:    opts.model,
    subject:  opts.subject ?? null,
    tenant:   null,
    standing: null,
    claims:   Object.keys(opts.claims),
    include:  [],
    namedBy:  opts.namedBy ?? null,
    headers:  opts.from.headerName ? [opts.from.headerName] : [],
    session:  opts.session ?? 'refuse',
  })
  described.mint         = mint
  described.mintOnCreate = mintOnCreate
  described.redeem       = redeem
  described.spend        = spend

  return described
}

/**
 * Is this grant still good?
 *
 * Read off COLUMNS the app's own model declares rather than off options, so the
 * answer is in the seed where `fli check`, a migration and a person reviewing
 * access can all see it. A model that declares neither column has said its
 * grants do not expire, which is a legitimate thing for a basket to say and a
 * dangerous thing for a portal link to say — and the schema is where that
 * argument belongs.
 *
 * A column that is present and unreadable — a string that is not a date — is
 * treated as EXPIRED. The alternative reading is *live*, which turns a column
 * nobody can parse into a grant that never dies.
 */
function isLive(row: Record<string, unknown>, clock?: () => Date): boolean {
  if ('revokedAt' in row && row.revokedAt != null) return false

  if ('expiresAt' in row && row.expiresAt != null) {
    const at = new Date(row.expiresAt as string | number | Date).getTime()
    // The client's clock, which `createClient({ now })` moves: a deadline that
    // reads the wall clock beside it is the one a drive cannot reach.
    const now = clock ? clock().getTime() : Date.now()
    if (!Number.isFinite(at) || at <= now) return false
  }

  return true
}
