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
  emailVerified  Boolean   @default(false)
  role           String    @default("user")
  accountId      Int?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @default(now()) @updatedAt

  @@db(${db})
  @@gate("8")
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
