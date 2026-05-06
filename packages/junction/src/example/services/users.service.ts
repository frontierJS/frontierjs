// example/services/users.service.ts
// A self-contained Users service using in-memory storage.
// Includes a simple password-free demo login that returns a fake token.

import { createService }        from '../../core/service.ts'
import { createSchema, v }      from '../../core/schema.ts'
import { NotFound, Conflict,
         Unauthorized }         from '../../core/errors.ts'
import { protect }              from '../../core/hooks.ts'
import type { App }             from '../../core/app.ts'
import type { ServiceContext }  from '../../transport/bridge.ts'

// ─── In-memory store ──────────────────────────────────────────────────────

interface User {
  id:         string
  name:       string
  email:      string
  role:       'user' | 'admin'
  created_at: string
}

const store = new Map<string, User>()
// Simple token → userId map (in-memory demo auth)
export const tokens = new Map<string, string>()

// Seed one admin user
const seed: User = {
  id:         'admin-1',
  name:       'Admin',
  email:      'admin@demo.local',
  role:       'admin',
  created_at: new Date().toISOString(),
}
store.set(seed.id, seed)
tokens.set('demo-admin-token', seed.id)

// ─── Schemas ──────────────────────────────────────────────────────────────

const CreateUserSchema = createSchema({
  name:  v.required.string({ minLength: 2, maxLength: 80, trim: true }),
  email: v.required.email({ lowercase: true }),
  role:  v.string({ enum: ['user', 'admin'], default: 'user' }),
})

// ─── Service factory ──────────────────────────────────────────────────────

export function createUsersService(app: App) {

  return createService({
    name: 'users',

    async find(ctx: ServiceContext) {
      const users = Array.from(store.values())
      const skip  = parseInt(ctx.query.$offset  ?? '0',  10)
      const limit = parseInt(ctx.query.$limit ?? '20', 10)
      return { total: users.length, limit, skip, data: users.slice(skip, skip + limit) }
    },

    async get(ctx: ServiceContext) {
      const user = store.get(String(ctx.id))
      if (!user) throw new NotFound(`User ${ctx.id} not found`)
      return user
    },

    async create(ctx: ServiceContext) {
      const data = CreateUserSchema.parse(ctx.data)

      // Check email uniqueness
      const exists = Array.from(store.values()).find(u => u.email === data.email)
      if (exists) throw new Conflict(`Email ${data.email} is already registered`)

      const user: User = {
        id:         crypto.randomUUID(),
        name:       data.name as string,
        email:      data.email as string,
        role:       (data.role ?? 'user') as 'user' | 'admin',
        created_at: new Date().toISOString(),
      }

      store.set(user.id, user)
      await app.events.emit('user:created', user)

      // Auto-generate a demo token
      const token = `token-${user.id}`
      tokens.set(token, user.id)

      return { ...user, token }
    },

    async patch(ctx: ServiceContext) {
      const existing = store.get(String(ctx.id))
      if (!existing) throw new NotFound(`User ${ctx.id} not found`)

      const updated = { ...existing, ...ctx.data, updated_at: new Date().toISOString() }
      store.set(existing.id, updated)
      return updated
    },

    async remove(ctx: ServiceContext) {
      const existing = store.get(String(ctx.id))
      if (!existing) throw new NotFound(`User ${ctx.id} not found`)
      store.delete(String(ctx.id))
      return existing
    },

    hooks: {
      after: {
        // Never return internal fields — strip token from list/get results
        find: [protect('token')],
        get:  [protect('token')],
      },
    },
  })
}

// ─── Simple demo auth ─────────────────────────────────────────────────────
// Resolves a Bearer token to a SessionContext.
// Used by app.ts as the auth.verifySession implementation.

export function verifyDemoToken(token: string) {
  const userId = tokens.get(token)
  if (!userId) return null
  const user = store.get(userId)
  if (!user) return null
  return {
    userId:     user.id,
    userType:   user.role,
    role:        user.role,
    authMethod: 'session' as const,
  }
}
