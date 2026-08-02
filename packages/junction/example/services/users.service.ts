// example/services/users.service.ts
// A self-contained Users service using in-memory storage.
// Includes a simple password-free demo login that returns a fake token.

import { createService }        from '../../src/core/service.ts'
import { createSchema, v }      from '../../src/core/schema.ts'
import { NotFound, Conflict,
         Unauthorized }         from '../../src/core/errors.ts'
import { protect }              from '../../src/core/hooks.ts'
import type { App }             from '../../src/core/app.ts'
import type { ServiceContext }  from '../../src/transport/bridge.ts'

// ─── In-memory store ──────────────────────────────────────────────────────

interface User {
  id:         string
  name:       string
  email:      string
  role:       'user' | 'admin'
  created_at: string
}

// Simple token → userId map (in-memory demo auth)
export const tokens = new Map<string, string>()

// NOTE: the user store lives INSIDE the factory (see createUsersService) so
// each app instance gets isolated state — a module-level Map would leak
// users across every app created in the same process (e.g. between tests).
// verifyDemoToken (below) needs to look users up outside the service, so the
// factory registers its store here. Last-created service wins — fine for a
// single-app demo; real apps use a proper IAuth provider.
let activeStore: Map<string, User> | null = null

// ─── Schemas ──────────────────────────────────────────────────────────────

const CreateUserSchema = createSchema({
  name:  v.required.string({ minLength: 2, maxLength: 80, trim: true }),
  email: v.required.email({ lowercase: true }),
  role:  v.string({ enum: ['user', 'admin'], default: 'user' }),
})

// ─── Service factory ──────────────────────────────────────────────────────

export function createUsersService(app: App) {

  const store = new Map<string, User>()
  activeStore = store   // expose to verifyDemoToken

  // Seed one admin user per app instance
  const seed: User = {
    id:         'admin-1',
    name:       'Admin',
    email:      'admin@demo.local',
    role:       'admin',
    created_at: new Date().toISOString(),
  }
  store.set(seed.id, seed)
  tokens.set('demo-admin-token', seed.id)

  return createService({
    name: 'users',

    async find(ctx: ServiceContext) {
      const users = Array.from(store.values())
      // Directives, not filters. `$limit`/`$offset` are wire syntax and stop
      // at the bridge — ctx.directives is the structured form, already numeric.
      const skip  = ctx.directives.offset ?? 0
      const limit = ctx.directives.limit  ?? 20
      return { total: users.length, limit, offset: skip, data: users.slice(skip, skip + limit) }
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

    // update() — full replace (PUT). patch() below merges (PATCH).
    async update(ctx: ServiceContext) {
      const existing = store.get(String(ctx.id))
      if (!existing) throw new NotFound(`User ${ctx.id} not found`)

      const data = CreateUserSchema.parse(ctx.data)   // full record required
      const replaced: User = {
        id:         existing.id,
        name:       data.name  as string,
        email:      data.email as string,
        role:       (data.role ?? 'user') as 'user' | 'admin',
        created_at: existing.created_at,
      }
      store.set(replaced.id, replaced)
      return replaced
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
  const user = activeStore?.get(userId)
  if (!user) return null
  return {
    userId:     user.id,
    userType:   user.role,
    role:        user.role,
    authMethod: 'session' as const,
  }
}
