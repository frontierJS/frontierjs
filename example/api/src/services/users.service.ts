// The roster — who has an account here, and what the shop says about them.
//
// This is the one service in the app over a model the app did not write.
// `User` is @frontierjs/auth's, assembled into the schema by api/src/core/db.ts
// and extended by db/user.lite, so everything that guards this service is
// declared in two files neither of which is this one:
//
//   @@gate("4.4.4.5")        read/create/update at USER(4), delete at ADMIN(5)
//   @@allow('read', …)       your own row, or every row if you are staff
//   @@allow('update', …)     your own row, or any row if you are an admin
//   role          @allow('write', auth().isAdmin)
//   emailVerified @allow('write', auth().isAdmin)
//   isStaff       @allow('write', auth().isAdmin)
//
// So the four things a person can do on the users screen — see the roster,
// promote somebody to staff, change a role, mark an address verified — are each
// refused or permitted by the Data boundary, and there is not a line here about
// any of them. That is the whole demonstration: the file is short because the
// rules are in the schema, not because the screen is trusted.
//
// ─── Why the surface is narrowed ──────────────────────────────────────────
//
// Declaring `methods:` answers 405 to every verb not named, and two are left
// out on purpose:
//
//   create   A `User` row is half an account. The other half is a `Credential`,
//            which only @frontierjs/auth writes, so a row created here is an
//            address nobody can ever sign in as. Registration is POST
//            /auth/register and there is no second door.
//
//   remove   `User` declares no @@softDelete, and `Credential.userId` /
//            `Session.userId` are bare String columns with no relation behind
//            them — auth keeps its own machinery at @@gate("8") rather than
//            wiring foreign keys into an app's schema. So a delete here would
//            leave live sessions pointing at a row that is gone: the person
//            stays signed in, and the next request they make is authenticated
//            against nothing. Taking somebody's access away is
//            `isStaff: false` plus DELETE /auth/sessions, not a row removal.
//
// The gate would have permitted it — delete at ADMINISTRATOR(5). A gate answers
// *what kind of caller*; whether the operation makes sense at all is the
// service's, and this is what that distinction looks like in a file.
//
// ─── Adding somebody, and why it is a plain create ────────────────────────
//
// `create` IS here, and it is the generated one rather than a custom `invite`.
// That is the whole design, so it is worth saying why the obvious alternative
// is worse.
//
// An `invite` method would have to establish its own authority, because
// `gateAuth` grades CRUD against the model's `@@gate` and says nothing about a
// custom method — junction states it: *a method the map does not name is not
// gated here*. Establishing it would mean `if (level < 5)` in this file, which
// is the seed's rule written a second time in a place nothing keeps in step —
// the mistake `payments.refund` documents at length and refuses to make.
//
// A plain create asks instead. `db/user.lite` declares
// `@@allow('create', auth().isAdmin)`, so the Data boundary refuses a shopper
// with a 403 naming the model, and moving that line moves this method with it.
// Three more things come free and none of them is written here:
//
//   · `role`, `emailVerified` and `isStaff` are each
//     `@allow('write', auth().isAdmin)`, so the same payload from a
//     non-admin is accepted with those columns unmoved.
//   · `email @unique` answers `UniqueConflictError` — a 409 carrying `errors`,
//     so <Form> marks the box rather than showing a banner. auth's own
//     `EmailTakenError` is the same fact one door along.
//   · `@email` and `@lower` are applied at the boundary, so the address is
//     normalized before it is compared.
//
// ─── What a created row is NOT ────────────────────────────────────────────
//
// A `User` is half an account. The other half is a `Credential`, which only
// @frontierjs/auth writes — so this row cannot sign in, and creating it must
// be followed by an invitation or it is a dead record.
//
// That happens in `afterCommit` and it is deliberate: sending mail is
// irreversible, and an `after` hook runs after the METHOD rather than after the
// transaction, so a later hook throwing would roll the row back with the
// invitation already gone. It is an Observer — a throw is logged and never
// reported as the call failing, which is right, because the account IS made and
// the admin can send the link again.
//
// Deliberately NOT a password typed by an admin. `requestPasswordReset` mints a
// token the PERSON redeems, so no colleague ever knows anybody else's password
// and nothing here has to hold one. basecamp's `model Invitation` is the fuller
// answer to the same question — an offer of membership to an address that has
// no account yet — and it earns a table because it carries state this does not.
import { createBaseService, resultData } from '@frontierjs/junction'

type NewUser = { id?: string; email?: string }

export function createUsersService() {
  return createBaseService({
    model:   'User',
    channel: 'users',
    methods: ['find', 'get', 'create', 'patch'],

    hooks: {
      after: {
        create: [
          function inviteTheNewAccount(ctx) {
            // `resultData`, not `ctx.result`. Inside the pipeline the result is
            // still the ENVELOPE — `{ kind: 'single', object: 'users', data }` —
            // and only the transport unwraps it. Reading `.email` off it is
            // `undefined` with no error anywhere: the hook runs, the account is
            // made, and the invitation silently never goes out. Junction exports
            // the unwrapper for exactly this.
            const row = resultData(ctx.result) as NewUser | undefined
            if (!row?.email) return
            const email = row.email

            ctx.afterCommit(async () => {
              // Per SHOP. `app.auth` is the proxy in api/src/core/auth.ts, which
              // routes every method to the provider for the tenant this request
              // is for — so an invitation is minted against the database the
              // account was made in, and never against the default shop's.
              await ctx.app.auth?.requestPasswordReset?.(email)
            })
          },
        ],
      },
    },
  })
}
