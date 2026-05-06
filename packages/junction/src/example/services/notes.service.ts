// example/services/notes.service.ts
// A self-contained Notes service using in-memory storage.
// No database required — demonstrates the full service + hook pattern.

import { createService }              from '../../core/service.ts'
import { createSchema, v }            from '../../core/schema.ts'
import { NotFound }                   from '../../core/errors.ts'
import { authenticate, requireRole, paginate } from '../../core/hooks.ts'
import type { App }                   from '../../core/app.ts'
import type { ServiceContext }        from '../../transport/bridge.ts'

// ─── In-memory store ──────────────────────────────────────────────────────

interface Note {
  id:         string
  title:      string
  body:       string
  tags:       string[]
  author_id:  string
  created_at: string
  updated_at: string
}

const store = new Map<string, Note>()

// ─── Schemas ──────────────────────────────────────────────────────────────

const CreateNoteSchema = createSchema({
  title: v.required.string({ minLength: 1, maxLength: 200, trim: true }),
  body:  v.required.string({ minLength: 1 }),
  tags:  v.array(v.string({ trim: true }), { default: [] }),
})

const PatchNoteSchema = CreateNoteSchema.partial()

// ─── Service factory ──────────────────────────────────────────────────────

export function createNotesService(app: App) {

  return createService({
    name: 'notes',

    async find(ctx: ServiceContext) {
      let notes = Array.from(store.values())

      // Simple filter by query params
      const { title, author_id, tag } = ctx.query as Record<string, string>
      if (title)     notes = notes.filter(n => n.title.toLowerCase().includes(title.toLowerCase()))
      if (author_id) notes = notes.filter(n => n.author_id === author_id)
      if (tag)       notes = notes.filter(n => n.tags.includes(tag))

      const skip  = parseInt(ctx.query.$offset  ?? '0',  10)
      const limit = parseInt(ctx.query.$limit ?? '20', 10)
      const slice = notes.slice(skip, skip + limit)

      return { total: notes.length, limit, skip, data: slice }
    },

    async get(ctx: ServiceContext) {
      const note = store.get(String(ctx.id))
      if (!note) throw new NotFound(`Note ${ctx.id} not found`)
      return note
    },

    async create(ctx: ServiceContext) {
      const data = CreateNoteSchema.parse(ctx.data)

      const note: Note = {
        id:         crypto.randomUUID(),
        title:      data.title as string,
        body:       data.body  as string,
        tags:       (data.tags ?? []) as string[],
        author_id:  ctx.params.user?.userId ?? 'anonymous',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      store.set(note.id, note)

      // Emit event — other parts of the app can listen
      await app.events.emit('note:created', note)

      return note
    },

    async patch(ctx: ServiceContext) {
      const existing = store.get(String(ctx.id))
      if (!existing) throw new NotFound(`Note ${ctx.id} not found`)

      const data = PatchNoteSchema.parse(ctx.data)

      const updated: Note = {
        ...existing,
        ...(data.title !== undefined && { title: data.title as string }),
        ...(data.body  !== undefined && { body:  data.body  as string }),
        ...(data.tags  !== undefined && { tags:  data.tags  as string[] }),
        updated_at: new Date().toISOString(),
      }

      store.set(updated.id, updated)

      await app.events.emit('note:updated', updated)

      return updated
    },

    async remove(ctx: ServiceContext) {
      const existing = store.get(String(ctx.id))
      if (!existing) throw new NotFound(`Note ${ctx.id} not found`)

      store.delete(String(ctx.id))

      await app.events.emit('note:removed', { id: ctx.id })

      return existing
    },

    // ── Custom methods ──────────────────────────────────────────────────
    // Defined directly alongside CRUD — no separate ‘actions’ wrapper needed.
    // Dispatch from the client by setting the X-Service-Method header on a
    // request to the standard collection or resource URL — the path stays
    // /api/notes or /api/notes/:id; the header picks the action.

    // POST /api/notes/:id  + X-Service-Method: summary
    async summary(ctx: ServiceContext) {
      const note = store.get(String(ctx.id))
      if (!note) throw new NotFound(`Note ${ctx.id} not found`)
      const body = String(note.body ?? '')
      return {
        id:         note.id,
        title:      note.title,
        word_count: body.split(/\s+/).filter(Boolean).length,
        char_count: body.length,
        preview:    body.slice(0, 100) + (body.length > 100 ? '…' : ''),
      }
    },

    // POST /api/notes/:id  + X-Service-Method: pin  — admin only
    async pin(ctx: ServiceContext) {
      const note = store.get(String(ctx.id))
      if (!note) throw new NotFound(`Note ${ctx.id} not found`)
      const pinned = { ...note, pinned: true, updated_at: new Date().toISOString() }
      store.set(String(ctx.id), pinned)
      return pinned
    },

    hooks: {
      before: {
        create: [authenticate],
        patch:  [authenticate],
        remove: [authenticate],
        find:   [paginate(20, 100)],
        pin:    [authenticate, requireRole('admin')],
      },
    },
  })
}
