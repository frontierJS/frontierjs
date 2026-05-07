// schema.ts
// Auth schema fragments — injected into schema.lite by fli auth:install.
// Exported as a function so the db name is parameterized.

export function authSchemaFragments(db = 'main'): string {
  return `
// ─── Auth — injected by fli auth:install ─────────────────────────────────────
// Users:         identity table — who you are
// Credentials:   how you prove it — passwords, API keys, OAuth tokens
// Sessions:      are you currently logged in
// Verifications: ephemeral tokens — password reset, email verify

model users {
  id            Text      @id @default(uuid())
  email         Text      @email @unique @lower
  name          Text?     @trim
  emailVerified Boolean   @default(false)
  role          Text      @default("user")
  accountId     Integer?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @default(now()) @updatedAt

  @@db(${db})
  @@gate("8")
  @@log(audit)
}

model credentials {
  id             Integer   @id
  userId         Text
  type           Text
  value          Text      @guarded(all)
  label          Text?
  accessToken    Text?     @secret
  refreshToken   Text?     @secret
  tokenExpiresAt DateTime?
  scope          Text?
  createdAt      DateTime  @default(now())

  @@db(${db})
  @@gate("8")
  @@index([userId, type])
  @@index([type, value])
}

model sessions {
  id        Text     @id @default(uuid())
  userId    Text
  token     Text     @unique @guarded(all)
  expiresAt DateTime
  ipAddress Text?
  userAgent Text?
  createdAt DateTime @default(now())

  @@db(${db})
  @@gate("8")
  @@log(audit)
  @@index([userId])
  @@index([expiresAt])
}

model verifications {
  id         Integer  @id
  identifier Text
  value      Text     @guarded(all)
  expiresAt  DateTime
  createdAt  DateTime @default(now())

  @@db(${db})
  @@gate("8")
  @@index([identifier])
}
`
}
