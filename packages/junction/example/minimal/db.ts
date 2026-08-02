// example/minimal/db.ts
// A tiny in-memory, table-shaped db client — the contract app.db needs for
// db-less services: app.db.<model> exposing findMany / count / findUnique /
// create / update / updateMany / delete / deleteMany.
//
// In a real app this is your Litestone client (which satisfies the same
// surface natively); this file exists so the minimal example runs with
// zero database setup.

type Row = Record<string, unknown> & { id: string }

function table(seed: Row[] = []) {
  const rows = [...seed]
  const match = (where: Record<string, unknown> = {}) => (r: Row) =>
    Object.entries(where).every(([k, v]) => r[k] === v)

  return {
    findMany:   async (a: { where?: Record<string, unknown>; take?: number; skip?: number } = {}) =>
      rows.filter(match(a.where)).slice(a.skip ?? 0, (a.skip ?? 0) + (a.take ?? 20)),
    count:      async (a: { where?: Record<string, unknown> } = {}) => rows.filter(match(a.where)).length,
    findUnique: async (a: { where: { id: string } }) => rows.find(r => r.id === a.where.id) ?? null,
    findFirst:  async (a: { where?: Record<string, unknown> } = {}) => rows.find(match(a.where)) ?? null,
    create:     async (a: { data: Record<string, unknown> }) => {
      const rec: Row = { id: crypto.randomUUID(), ...a.data }
      rows.push(rec)
      return rec
    },
    update:     async (a: { where: { id: string }; data: Record<string, unknown> }) => {
      const rec = rows.find(r => r.id === a.where.id)
      if (!rec) return null
      Object.assign(rec, a.data)
      return rec
    },
    updateMany: async (a: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hits = rows.filter(match(a.where))
      for (const r of hits) Object.assign(r, a.data)
      return { count: hits.length }
    },
    delete:     async (a: { where: { id: string } }) => {
      const i = rows.findIndex(r => r.id === a.where.id)
      if (i === -1) return null
      return rows.splice(i, 1)[0]
    },
    deleteMany: async (a: { where?: Record<string, unknown> } = {}) => {
      const hits = rows.filter(match(a.where))
      for (const r of hits) rows.splice(rows.indexOf(r), 1)
      return { count: hits.length }
    },
  }
}

export function createDb() {
  return {
    // SINGULAR, like a real Litestone client: `model Post` → db.post.
    // The service is named 'posts' (from its filename) and resolves to this.
    post: table([{ id: '1', title: 'Hello Junction', body: 'The first post.' }]),
  }
}
