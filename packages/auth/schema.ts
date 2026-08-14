// schema.ts
// Auth schema fragments — injected into schema.lite by fli auth:install.
// Exported as a function so the db name is parameterized.
//
// Model names are PascalCase singular, per Litestone's convention, so the
// accessors auth.ts uses are db.user / db.credential / db.session /
// db.verification. These previously read `model users` etc., which produced
// accessors that matched auth.ts's old plural calls but violated the
// convention — and broke the moment an app wrote its schema the documented way
// ("users" is not a table in this schema).
//
// Types are String / Int / Float. `Text` and `Integer` are listed in
// Litestone's RENAMED_TYPES and rejected outright — "a hard cut", no aliases —
// so the fragments emitted here have to use the current names or the schema
// won't parse at all.

export function authSchemaFragments(db = 'main'): string {
  return `
// ─── Auth — injected by fli auth:install ─────────────────────────────────────
// Users:         identity table — who you are
// Credentials:   how you prove it — passwords, API keys, OAuth tokens
// Sessions:      are you currently logged in
// Verifications: ephemeral tokens — password reset, email verify

model User {
  id             String    @id @default(uuid())
  email          String    @email @unique @lower
  name           String?   @trim
  // The two columns a caller must not write about themselves. role is what an
  // app's own resolver grades on, and marking your own address verified is
  // skipping the verification. auth().isAdmin is the standing
  // FrontierGateGetLevel and sessionGateLevel() both read for ADMINISTRATOR(5),
  // so the level that may delete a person is the level that may set their role
  // — one idea, not two. asSystem() writes both regardless, which is how this
  // package sets them.
  emailVerified  Boolean   @default(false) @allow('write', auth().isAdmin)
  role           String    @default("user") @allow('write', auth().isAdmin)
  accountId      Int?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @default(now()) @updatedAt

  @@db(${db})
  // R.C.U.D. Read, create and update are USER: an app's own screens list its
  // people, and a signed-in caller edits their own profile. Delete is
  // ADMINISTRATOR — removing a person is not self-service.
  //
  // A GATE IS PER MODEL, NOT PER ROW, so the level alone would say *any
  // signed-in caller may write any user row*. The policy is what makes it
  // their own row, and an admin's the exception — the same standing the gate's
  // delete position names. Together with the two field policies above, this is
  // the whole shape an app needs: a level for what kind of caller, a policy for
  // whose row, and a field policy for the columns the level itself is graded
  // from. A column the caller can write is not a column a level can be graded
  // from.
  //
  // Registration is unaffected: every write this package makes goes through
  // asSystem(), which is above the ladder. The three models below stay at 8 —
  // they hold the credential material, and that is the case 8 is for.
  @@gate("4.4.4.5")
  @@allow('update', id == auth().id || auth().isAdmin)
  @@log(audit)
}

model Credential {
  id              Int        @id
  userId          String
  type            String
  value           String     @guarded(all)
  label           String?
  accessToken     String?    @secret
  refreshToken    String?    @secret
  tokenExpiresAt  DateTime?
  scope           String?
  createdAt       DateTime   @default(now())

  @@db(${db})
  @@gate("8")
  @@index([userId, type])
  @@index([type, value])
}

model Session {
  id         String    @id @default(uuid())
  userId     String
  token      String    @unique @guarded(all)
  expiresAt  DateTime
  ipAddress  String?
  userAgent  String?
  createdAt  DateTime  @default(now())

  @@db(${db})
  @@gate("8")
  @@log(audit)
  @@index([userId])
  @@index([expiresAt])
}

model Verification {
  id          Int       @id
  identifier  String
  value       String    @guarded(all)
  expiresAt   DateTime
  createdAt   DateTime  @default(now())

  @@db(${db})
  @@gate("8")
  @@index([identifier])
}
`
}
