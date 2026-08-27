// src/services/invitations/invitations.service.ts
// An offer of membership to an email address — the only door into this app for
// a human who is not the first one (`FJS-032`).
//
// Mounted at /invitations. Custom methods dispatch on X-Service-Method:
//   resend   — a new token and a new expiry for the same address
//   preview  — what is this link? UNAUTHENTICATED
//   accept   — take it. UNAUTHENTICATED
//
// **Why a model and not `addMember`.** `workspaces.addMember` takes a `userId`,
// so it can only reach somebody who already has an account, and the one route
// that creates an account is `/auth/register`, which leaves them with no
// account row and no workspace — every scoped request then 400s and they cannot
// create a workspace either. So the invitation has to carry the workspace and
// the role across a gap where there is no user to hang them on.
//
// **Two of these methods run with no session, and that is the feature.** The
// person accepting is by definition not yet a member, and may not yet exist.
// The token IS the credential: 32 random bytes, `@guarded(all)` so no scoped
// read can answer it, looked up through `asSystem()` because there is no
// principal to scope by. Everything a token cannot decide — is the workspace
// still there, is it suspended, has the invitation expired — is decided here,
// explicitly, because none of the hooks that normally decide it are running.
//
// **Accepting with an existing account requires being signed in as that
// account.** The alternative is taking a password on this method, which makes
// it a second login door with none of the rate limiting of the first and turns
// a wrong password into an oracle. The screen sends them to /login/ and back.
//
// Mail is best-effort and its outcome is REPORTED. This app may have no mailer
// (core/mailer.ts), and a fleet console that cannot mail is an ordinary state;
// what is not acceptable is a screen that looks like it sent something. So the
// link comes back from `create` either way, exactly once, the way an API key's
// token does.

import { createService, NotFound, BadRequest, Conflict, Forbidden, Unauthorized, Gone, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, refuseGrantAboveOwn, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { grantsFor } from '../../core/capabilities.ts'
import { db, ws, actor, findScoped, getScoped } from '../../core/resource.ts'
import { env } from '../../core/env.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'
import type { WorkspaceRole }  from '../../../../db/schema.d.ts'
import { WORKSPACE_ROLE_LEVEL } from '../../core/gate.ts'

/** How long a link is good for. Long enough to survive a weekend, short enough
 *  that a forwarded mail from six months ago is not a way in. */
const TTL_DAYS = 7

/** 32 bytes, base64url. Not a UUID: a v4 UUID is 122 bits of randomness dressed
 *  as an identifier, and this is a credential, so it should read as one. */
function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The link a person clicks. The WEB origin, not the API's — accepting is a
 *  screen. `env.APP_URL` is named rather than derived from the request's Host,
 *  which is a value the caller chooses. */
export function acceptUrl(token: string): string {
  return `${env.APP_URL.replace(/\/+$/, '')}/invite/${token}/`
}

function expiryFrom(now = Date.now()): string {
  return new Date(now + TTL_DAYS * 86_400_000).toISOString()
}

export function createInvitationsService(app: BasecampApp) {

  /** The system client. Everything about an invitation is a system act: the
   *  token is `@guarded`, and the accept path has no principal to scope by. */
  const sys = () => $.db.asSystem() as any

  /** A role off the wire, refused BY NAME. The vocabulary is the map
   *  `core/gate.ts` grades on, which a data test holds to the schema enum — a
   *  role this app cannot grade is a role it must not hand out. */
  function toRole(value: unknown, fallback: WorkspaceRole = 'developer'): WorkspaceRole {
    if (value === undefined || value === null || value === '') return fallback
    const roles = Object.keys(WORKSPACE_ROLE_LEVEL)
    if (typeof value !== 'string' || !roles.includes(value))
      throw new BadRequest(`role must be one of: ${roles.join(', ')}`)
    return value as WorkspaceRole
  }

  /** Lower-cased on the way in, so `Ada@Example.test` and `ada@example.test`
   *  cannot hold two open invitations to one workspace and cannot miss an
   *  existing account by case alone. */
  function toEmail(value: unknown): string {
    const email = String(value ?? '').trim().toLowerCase()
    if (!email) throw new BadRequest('email is required')
    return email
  }

  /**
   * Send the link, and answer whether it went.
   *
   * Never throws. The invitation is already written and the link already works
   * — failing the call would leave the row behind with the caller believing
   * nothing happened. What the caller gets instead is the truth, which the
   * screen renders beside the copyable link.
   */
  async function deliver(
    to: string, workspaceName: string, inviter: string | null, url: string,
  ): Promise<{ mailed: boolean; mailError: string | null }> {
    if (!app.mail)
      return { mailed: false, mailError: 'No mailer is configured — send this link yourself' }

    const from = inviter ? `${inviter} has invited you` : 'You have been invited'
    try {
      await app.mail.send({
        to,
        subject: `Join ${workspaceName} on Basecamp`,
        text: `${from} to join ${workspaceName} on Basecamp.\n\nAccept: ${url}\n\nThe link expires in ${TTL_DAYS} days.`,
        html: `<p>${from} to join <strong>${workspaceName}</strong> on Basecamp.</p>`
            + `<p><a href="${url}">Accept the invitation</a></p>`
            + `<p>The link expires in ${TTL_DAYS} days.</p>`,
      })
      return { mailed: true, mailError: null }
    } catch (err) {
      return { mailed: false, mailError: (err as Error).message }
    }
  }

  /** The inviter's display name, for the mail. A missing one is not an error —
   *  the sentence has a subjectless form. */
  async function inviterName(userId: string): Promise<string | null> {
    if (!userId || userId === 'system') return null
    const user = await sys().user.findUnique({ where: { id: userId } })
    return (user?.displayName as string) ?? (user?.name as string) ?? null
  }

  /**
   * Resolve a token to a live invitation, or refuse by name.
   *
   * Every refusal a token cannot decide for itself is here, in one place,
   * because `preview` and `accept` are the two methods running with none of the
   * hooks that would normally decide them. The order is deliberate: an unknown
   * token and an expired one read differently, because "ask for a new link" and
   * "this was never a link" are different instructions.
   */
  async function resolveToken(token: unknown) {
    if (typeof token !== 'string' || !token.trim())
      throw new BadRequest('token is required')

    const invitation = await sys().invitation.findFirst({ where: { token: token.trim() } })
    if (!invitation) throw new NotFound('This invitation link is not valid')

    if (Date.parse(invitation.expiresAt as string) < Date.now())
      throw new Gone('This invitation has expired — ask for a new one')

    const workspace = await sys().workspace.findUnique({ where: { id: invitation.workspaceId } })
    if (!workspace) throw new Gone('The workspace this invitation is for no longer exists')
    if (workspace.status === 'suspended')
      throw new Forbidden('This workspace is suspended. Ask a system administrator to restore it.')

    return { invitation, workspace }
  }

  return createService({
    name:  'invitations',
    model: 'Invitation',

    // The workspace channel, except for `accept` — whose result carries a
    // session token, and an announcement announces the RESULT. Silencing it
    // with `$.dispatch = false` would have worked and cost the audit trail:
    // `recordable()` reads the same flag to mean *this method is read-shaped*,
    // so an accept would have gone unrecorded. Two different statements —
    // "nobody needs to hear this" and "nobody may hear this" — and only one of
    // them belongs on the publish side.
    channel: (data: unknown, ctx: ServiceContext) =>
      $.method === 'accept' ? null : workspaceChannel(app)(data, ctx),

    reservedQuery: WORKSPACE_QUERY,

    // The whole surface, declared. Without `methods:` the Litestone base
    // answers `patch` and `put` too, and a patch of this model is a caller
    // moving their own expiry or their own role.
    methods: ['find', 'create', 'remove', 'resend', 'preview', 'accept'],

    /**
     * Open invitations for this workspace, newest first.
     *
     * Expired rows are listed rather than filtered. An administrator asking
     * "did Ada ever get invited" is asking about the row, and a list that
     * silently drops what has lapsed answers "no" to a question it was not
     * asked. `expiresAt` is on every row, so the screen says which are dead.
     *
     * The token is not here: `db()` is the CALLER's client and `@guarded(all)`
     * means the column is absent from a scoped read entirely, not redacted.
     */
    async find() {
      const { limit, offset } = getPagination()
      return findScoped('invitation', { limit, offset })
    },

    async create() {
      const data      = ($.data ?? {}) as Record<string, unknown>
      const email     = data.email as string          // lower-cased by stampInvitation
      const workspace = await sys().workspace.findUnique({ where: { id: ws() } })

      // Both refusals name the state rather than leaving SQLite to answer the
      // @@unique with a constraint error at the end of the write.
      const existing = await sys().user.findFirst({ where: { email } })
      if (existing && await sys().workspaceMember.exists({
        where: { workspaceId: ws(), userId: existing.id },
      }))
        throw new Conflict(`${email} is already a member of this workspace`)

      if (await sys().invitation.exists({ where: { workspaceId: ws(), email } }))
        throw new Conflict(`${email} already has an open invitation — resend it or revoke it first`)

      // asSystem, and the token generated HERE rather than stamped onto
      // $.data: `token` is `@guarded(all)`, which puts it outside the
      // create-mode JSON Schema, and that schema is closed — so a stamped token
      // is refused as an unknown key before the write is ever attempted.
      const token = mintToken()
      const row   = await sys().invitation.create({ data: { ...data, token } })

      const url  = acceptUrl(token)
      const post = await deliver(email, workspace?.name ?? 'a workspace', await inviterName(actor()), url)

      // The only moment the token exists outside the row. `token` and
      // `acceptUrl` are not columns and are on no later read — the same shape
      // an issued API key has, and for the same reason.
      return { ...row, token, acceptUrl: url, ...post }
    },

    /**
     * A new token and a new expiry for the same address.
     *
     * The old token stops working, which is what makes this different from
     * mailing the same link again: an invitation forwarded to the wrong person
     * is revoked by resending it.
     */
    async resend() {
      const current   = await getScoped('invitation', 'Invitation')
      const workspace = await sys().workspace.findUnique({ where: { id: ws() } })

      const token = mintToken()
      const row   = await sys().invitation.update({
        where: { id: current.id },
        data:  { token, expiresAt: expiryFrom() },
      })

      const url  = acceptUrl(token)
      const post = await deliver(current.email as string, workspace?.name ?? 'a workspace',
                                 await inviterName(actor()), url)

      return { ...row, token, acceptUrl: url, ...post }
    },

    /**
     * Revoke. A hard delete, because the row IS the pending state — there is no
     * `revokedAt` to set, and a tombstone would be a second place a membership's
     * origin is recorded that nothing reads. `@@log(audit)` keeps the record.
     */
    async remove() {
      const row = await getScoped('invitation', 'Invitation')
      await sys().invitation.delete({ where: { id: row.id } })
      return row
    },

    // ── the two unauthenticated methods ───────────────────────────────

    /**
     * What is this link? Answered to whoever holds the token and nobody else.
     *
     * A POST for a read, deliberately: the token in a path or a query string is
     * a credential in the browser history, the referrer header and every access
     * log between here and there.
     *
     * `hasAccount` is what the screen branches on — sign in and come back, or
     * choose a password. Telling the holder of the token whether that address
     * has an account leaks nothing: they were handed a link addressed to it.
     */
    async preview() {
      $.dispatch = false
      const { invitation, workspace } = await resolveToken(($.data as Record<string, unknown>)?.token)
      const user = await sys().user.findFirst({ where: { email: invitation.email } })

      return {
        email:      invitation.email,
        role:       invitation.role,
        expiresAt:  invitation.expiresAt,
        workspace:  { id: workspace.id, name: workspace.name, slug: workspace.slug },
        hasAccount: Boolean(user),
      }
    },

    /**
     * Take the invitation.
     *
     * Two branches, and which one applies is not the caller's to choose — it is
     * decided by whether the invited ADDRESS has an account:
     *
     *   · it does   — the caller must already be signed in as that person. Not
     *                 a password on this method: that is a second login door
     *                 with none of the first one's rate limiting, and a wrong
     *                 answer to it is an oracle.
     *   · it does not — `name` and `password` create the account, into the
     *                 workspace's own account row, and the reply carries a
     *                 session so the person lands signed in rather than at a
     *                 login form they have no password memory of.
     *
     * Not announced — see `channel:` above. It IS recorded, under the workspace
     * it happened in, which is set below because sessionScope normally sets it
     * and sessionScope is not running here.
     */
    async accept() {
      const data = ($.data ?? {}) as Record<string, unknown>
      const { invitation, workspace } = await resolveToken(data.token)

      const email   = invitation.email as string
      const caller  = $.auth?.user as { userId?: string; email?: string } | undefined
      const account = await sys().user.findFirst({ where: { email } })

      // The trail files this under the workspace it happened in. Nothing else
      // set it: sessionScope, which normally does, is not running here.
      $.locals.workspaceId = workspace.id

      let userId: string
      let session: { token: string; user: unknown } | null = null

      if (account) {
        if (!caller?.userId)
          throw new Unauthorized(`${email} already has an account — sign in as ${email}, then open this link again`)
        if (caller.userId !== account.id)
          throw new Forbidden(`This invitation is for ${email}, and you are signed in as ${caller.email ?? 'somebody else'}`)
        userId = account.id
      } else {
        const name     = String(data.name ?? '').trim()
        const password = String(data.password ?? '')
        if (!name)               throw new BadRequest('name is required')
        if (password.length < 8) throw new BadRequest('password must be at least 8 characters')

        // `app.auth` is junction's SessionVerifier — it DECLARES only what
        // junction calls, so a provider without these two refuses by name here
        // rather than failing halfway through the transaction below.
        const auth = app.auth as { createUser?: Function; login?: Function } | undefined
        if (!auth?.createUser || !auth?.login)
          throw new BadRequest('This deployment cannot create accounts')

        const created = await auth.createUser({ email, name, password })
        userId = created.userId as string

        // The workspace's account, not a new one: an invited person joins the
        // tenant that invited them. Doing anything else gives them a session
        // whose accountId does not match the workspace they were let into, and
        // every scoped request 400s — which is exactly the shape of the gap
        // /auth/register left behind.
        await sys().user.update({
          where: { id: userId },
          data:  { accountId: workspace.accountId, status: 'active',
                   displayName: name, emailVerified: true },
        })
        session = await auth.login(email, password)
      }

      // One transaction: a consumed invitation with no membership behind it is
      // a link that reports success and lets nobody in.
      const member = await sys().$transaction(async (tx: any) => {
        const member = await tx.workspaceMember.create({
          data: {
            workspaceId: workspace.id,
            userId,
            role:        invitation.role,
            // Stamped from the role the invitation named, which is the role
            // `refuseGrantAboveOwn` already graded against the inviter's own
            // set when the invitation was created.
            capabilities: grantsFor(invitation.role),
            // The three columns `WorkspaceMember` has always declared and
            // nothing ever wrote. Carried forward from the invitation, which is
            // then consumed — the membership is where a membership's origin
            // belongs.
            invitedBy:   invitation.invitedBy ?? null,
            invitedAt:   invitation.createdAt,
            acceptedAt:  new Date().toISOString(),
          },
        })
        await tx.invitation.delete({ where: { id: invitation.id } })
        return member
      })

      return {
        member,
        workspace_id: workspace.id,
        workspace:    { id: workspace.id, name: workspace.name, slug: workspace.slug },
        // Present only on the branch that created the account. A caller who was
        // already signed in keeps the session they already had.
        ...(session ? { token: session.token, user: session.user } : {}),
      }
    },

    hooks: {
      before: {
        // `preview` and `accept` are exempt from the whole of it — authenticate,
        // requireWorkspace and scopeToWorkspace. All three are wrong for a
        // caller who is not a member yet and may not exist yet, which is the
        // entire population this service is for.
        all:    [sessionScope(app, { except: ['preview', 'accept'] })],
        // refuseGrantAboveOwn runs AFTER stampInvitation, which normalises the
        // role — and it is here because an invitation is the second way to hand
        // out standing: an admin inviting an address they own as `owner` signs
        // in as that account and holds level 6 (`FJS-410`).
        create: [requireWorkspaceRole(app, 'admin', 'owner'), stampInvitation, refuseGrantAboveOwn()],
        resend: [requireWorkspaceRole(app, 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
      },
    },
  })

  /**
   * before/create: everything the client does not send.
   *
   * A hook and not the first lines of `create()`, because `model:` brings
   * `autoValidate(model, 'create')` with it and user hooks run first — do this
   * inside the method and every request 400s on `workspaceId is required` and
   * `expiresAt is required`, fields a client was never meant to supply.
   *
   * `token` is deliberately NOT here — see `create`.
   */
  function stampInvitation(): void {
    const data = ($.data ?? {}) as Record<string, unknown>
    data.email       = toEmail(data.email)
    data.role        = toRole(data.role)
    data.expiresAt   = expiryFrom()
    data.invitedBy   = actor()
    // The tenant, because `create` writes through `sys()` and a system client
    // carries no principal for `@default(auth().workspaceId)` to read. Every
    // other create here goes through the scoped client and is stamped at the
    // Data boundary; this one bypasses it, so the tenant has to be stated —
    // from `ws()`, the workspace the request resolved to, never from the
    // payload. The browser used to supply it, which is a client naming its own
    // tenant for a write nothing was checking (`FJS-387`).
    data.workspaceId = ws()
    $.data = data
  }
}
