# auth — layout

The file-by-file map of `@frontierjs/auth`; the owners that matter most turns are `CLAUDE.md` § Where things are.

```
auth.ts      the IAuth implementation — sessions, login, verification
authorize.ts GET / POST /authorize (`FJS-D1925`): admits the client and its
             redirect, then password, TOTP and consent on the packed page;
             mounted by plugin.ts where the auth has `encryptionKey`
clients.ts   the client registry for /authorize (`FJS-D1929`): a client's
             metadata document (CIMD) fetched through junction's
             `fetchPublicJson`, graded, and cached no longer than its
             max-age; `checkRedirect`, `isLoopbackOnly`, `clientHost`
oauth.ts     the OAuth flow engine — the URL, the code-for-token trade, the
             normalized identity. No HTTP, no database, no session — plugin.ts
             owns the routes and auth.ts decides who the identity is
plugin.ts    auth() — mounts /auth/*, declares the cookie mode,
             and registers the three services at boot()
services.ts  account / sessions / api-keys — the half that is NOT a route
tenancy.ts   what the app's tenancy block says about a person — the claim,
             and the column on User a tenant is written to
db/user.lite      model User — the app's. Appended into its schema.lite
db/auth.lite      Credential / Session / Verification / LoginChallenge /
                  OauthFlow — imported, and adjusted at the app end with
                  `extend model`, never pasted
schema.ts    reads those two: authUserModel / authMachineryModels /
             authSchemaFragments (both) / retargetDb
crypto.ts    hashing / token generation; the access token's sign and read
             (`fja_`, `FJS-D1926`), which verifySession takes as its third arm
totp.ts      RFC 6238 codes, base32, recovery codes — clockless, `at` is a
             parameter (`FJS-D261`). Published as `@frontierjs/auth/totp` so a
             seed or drive types a code with this copy, not its own HOTP.
cleanup.ts   expired-row pruning — `auth.cleanup` on the instance, started in
             the plugin's work() and stopped at shutdown
errors.ts    the auth error classes (each carries its own `status`)
types.ts     the public types
index.ts     public API
Authorize.mesa  the /authorize page: password, TOTP, consent (`FJS-D1934`).
             Source only — auth never imports it
authorize-page.snapshot.js  that page packed by `fli mesa:pack`: `render(props)`
             and `STYLE_HASH`, with Mesa's render and the css subset inlined,
             so auth takes no dependency on mesa or css. Regenerate from its
             header; the `snapshots` phase fails it stale. Its types are
             `authorize-page.snapshot.d.ts`, the props contract the route keeps
```
