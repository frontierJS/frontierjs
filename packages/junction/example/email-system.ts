// example/email-system.ts
// ─────────────────────────────────────────────────────────────────────────
// Tier 1 email — native SMTP, zero extra dependencies.
//
// Shows:
//   • SMTP configuration (STARTTLS on port 587)
//   • Sending directly via app.email.system.send()
//   • sendSystemEmail() hook — welcome email on user create
//   • sendSystemEmail() hook — optional: false for password reset
//   • Local dev fallback using Mailpit (https://mailpit.axllent.org)
//
// ─── Quick start ─────────────────────────────────────────────────────────
//
//   # Option A — use Mailpit for local dev (catches all outgoing mail)
//   docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit
//   SMTP_HOST=localhost SMTP_PORT=1025 SMTP_USER=dev SMTP_PASS=dev bun run example/email-system.ts
//   open http://localhost:8025   ← Mailpit inbox
//
//   # Option B — use a real server (Google Workspace etc.)
//   SMTP_HOST=smtp.gmail.com SMTP_PORT=587 SMTP_USER=you@domain.com SMTP_PASS=app-password \
//     bun run example/email-system.ts
//
// ─── Try it ──────────────────────────────────────────────────────────────
//
//   # Create a user — triggers welcome email
//   curl -s -X POST http://localhost:3000/api/users \
//     -H "Content-Type: application/json" \
//     -d '{"name":"Alice","email":"alice@example.com","password":"secret"}'
//
//   # Get a token
//   TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
//     -H "Content-Type: application/json" \
//     -d '{"email":"alice@example.com","password":"secret"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
//
//   # Reset password — triggers mandatory password reset email
//   curl -s -X POST http://localhost:3000/api/users/reset-password \
//     -H "Content-Type: application/json" \
//     -H "Authorization: Bearer $TOKEN" \
//     -d '{"email":"alice@example.com"}'
//
//   # Send a test email directly
//   curl -s -X POST http://localhost:3000/email/test \
//     -H "Content-Type: application/json" \
//     -d '{"to":"you@example.com","subject":"Test","html":"<p>It works.</p>"}'
//
// ─────────────────────────────────────────────────────────────────────────

import {
  createApp,
  createService, createSchema, v,
  authenticate,
  correlationId, requestLogger,
  healthPlugin,
  defaultConfig,
} from '../index.ts'

import { email, sendSystemEmail } from '../src/plugins/email/index.ts'

// ─── Config ───────────────────────────────────────────────────────────────────

const SMTP_HOST = process.env.SMTP_HOST ?? 'localhost'
const SMTP_PORT = parseInt(process.env.SMTP_PORT ?? '1025')
const SMTP_USER = process.env.SMTP_USER ?? 'dev'
const SMTP_PASS = process.env.SMTP_PASS ?? 'dev'
const FROM_ADDR = process.env.FROM_ADDR ?? 'system@example.com'

// ─── In-memory user store ─────────────────────────────────────────────────────

const users = new Map<string, { id: string; name: string; email: string; password: string }>()
const tokens = new Map<string, string>()   // token → userId

// ─── App ──────────────────────────────────────────────────────────────────────

const app = createApp({
  config: {
    ...defaultConfig,
    port: 3000,
    name: 'email-example',
    database: { url: '', log: false },
  }
})

app.configure(correlationId())
app.configure(requestLogger())
app.configure(healthPlugin())

// ─── Email plugin — Tier 1 only ───────────────────────────────────────────────

app.configure(email({
  system: {
    from: FROM_ADDR,
    smtp: {
      host: SMTP_HOST,
      port: SMTP_PORT,
      user: SMTP_USER,
      pass: SMTP_PASS,
      // tls: true   ← uncomment for implicit TLS on port 465
    }
  }
  // No campaign config — Tier 2 not used in this example
}))

// ─── Schema ───────────────────────────────────────────────────────────────────

const CreateUserSchema = createSchema({
  name:     v.required.string({ minLength: 1, maxLength: 100, trim: true }),
  email:    v.required.email(),
  password: v.required.string({ minLength: 8 }),
})

// ─── Users service ────────────────────────────────────────────────────────────

app.services.register(createService({
  name: 'users',

  async find(_ctx) {
    return { total: users.size, limit: 20, skip: 0, data: [...users.values()].map(u => ({ id: u.id, name: u.name, email: u.email })) }
  },

  async get(ctx) {
    const user = users.get(String(ctx.id))
    if (!user) throw Object.assign(new Error('Not found'), { code: 404 })
    return { id: user.id, name: user.name, email: user.email }
  },

  async create(ctx) {
    const id   = crypto.randomUUID()
    const user = { id, ...ctx.data as { name: string; email: string; password: string } }
    users.set(id, user)
    // Return without password
    return { id: user.id, name: user.name, email: user.email }
  },

  hooks: {
    before: {
      create: [CreateUserSchema.hook()],
      get:    [authenticate],
    },
    after: {
      // Welcome email — optional (default).
      // SMTP failure is logged as a warning, never fails the create.
      create: [
        sendSystemEmail(app, ctx => {
          const user = ctx.result as { name: string; email: string }
          return {
            to:      user.email,
            subject: 'Welcome!',
            html: `
              <h2>Hi ${user.name},</h2>
              <p>Your account has been created. You're all set.</p>
              <p>— The Team</p>
            `,
            text: `Hi ${user.name},\n\nYour account has been created.\n\n— The Team`,
          }
        }),
      ],
    },
  },
}))

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/auth/login', async ctx => {
  const { email: emailAddr, password } = (ctx.body ?? {}) as { email?: string; password?: string }
  if (!emailAddr || !password) return ctx.json({ error: 'email and password required' }, 400)

  const user = [...users.values()].find(u => u.email === emailAddr && u.password === password)
  if (!user) return ctx.json({ error: 'invalid credentials' }, 401)

  const token = crypto.randomUUID()
  tokens.set(token, user.id)
  return ctx.json({ token, user: { id: user.id, name: user.name, email: user.email } })
})

// ─── Password reset ───────────────────────────────────────────────────────────
// Shows optional: false — email failure throws and the route returns 500.
// For a real app you'd queue this, but the pattern is the same.

app.post('/api/users/reset-password', async ctx => {
  const { email: emailAddr } = (ctx.body ?? {}) as { email?: string }
  if (!emailAddr) return ctx.json({ error: 'email required' }, 400)

  const user = [...users.values()].find(u => u.email === emailAddr)
  if (!user) {
    // Don't leak whether the email exists — respond the same either way
    return ctx.json({ message: 'If that address is registered, a reset link is on its way.' })
  }

  const resetToken = crypto.randomUUID()

  // optional: false — this email MUST be delivered.
  // If SMTP fails the route returns 500 and the caller can retry.
  try {
    await app.email!.system.send({
      to:      user.email,
      subject: 'Reset your password',
      html: `
        <h2>Password reset request</h2>
        <p>Click the link below to set a new password. This link expires in 1 hour.</p>
        <p><a href="http://localhost:3000/reset?token=${resetToken}">Reset password</a></p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
      text: `Reset your password: http://localhost:3000/reset?token=${resetToken}\n\nExpires in 1 hour.`,
    })
  } catch (err) {
    console.error('[email] password reset failed:', err)
    return ctx.json({ error: 'Could not send reset email. Please try again.' }, 500)
  }

  return ctx.json({ message: 'If that address is registered, a reset link is on its way.' })
})

// ─── Direct send test route ───────────────────────────────────────────────────
// Handy for confirming SMTP config works before wiring hooks.
// Remove in production.

app.post('/email/test', async ctx => {
  const { to, subject, html } = (ctx.body ?? {}) as {
    to?: string; subject?: string; html?: string
  }

  if (!to || !subject || !html) {
    return ctx.json({ error: 'to, subject, and html are required' }, 400)
  }

  try {
    const result = await app.email!.system.send({ to, subject, html })
    return ctx.json({ ok: true, id: result.id })
  } catch (err) {
    return ctx.json({ error: (err as Error).message }, 500)
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────

await app.start()

console.log('\n📬 Email example running')
console.log(`   SMTP: ${SMTP_HOST}:${SMTP_PORT}`)
console.log(`   From: ${FROM_ADDR}`)
if (SMTP_HOST === 'localhost' && SMTP_PORT === 1025) {
  console.log('   Mailpit inbox: http://localhost:8025')
}
console.log('\n   POST /api/users              create user (triggers welcome email)')
console.log('   POST /auth/login             get token')
console.log('   POST /api/users/reset-password  password reset (optional: false)')
console.log('   POST /email/test             send a test email directly\n')
