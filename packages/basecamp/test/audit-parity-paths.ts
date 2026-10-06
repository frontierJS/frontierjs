// The six paths as one shape: `call(path, who, service, method, args)`.
import { createJunctionClient } from '@frontierjs/junction/client'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { http, rowsOf, LEVELS_ORDER, type Fixture, type Who } from './audit-parity-harness.ts'

export type PathName = 'http' | 'ws' | 'mcp' | 'job-caller-svc' | 'job-caller-db' | 'job-app'
export const PATHS: PathName[] = ['http', 'ws', 'mcp', 'job-caller-svc', 'job-caller-db', 'job-app']
// `sysadmin` is asked twice: naming the workspace and naming none.
export type Who2 = Who | 'sysadmin-nows'
export const WHO2: Who2[] = [...LEVELS_ORDER, 'sysadmin-nows']

export interface Out { ok: boolean; status: number | string; body: any }
const errOf = (e: any): Out => ({ ok: false, status: e?.status ?? e?.statusCode ?? e?.code ?? 'throw', body: String(e?.message ?? e).slice(0, 160) })

const ACCESSOR: Record<string, string> = { secrets: 'secret', servers: 'server', variables: 'variable', audit: 'auditEvent', users: 'user' }

export class Driver {
  ws = new Map<string, any>()
  mcp = new Map<string, any>()
  constructor(public fx: Fixture) {}
  base(w: Who2): Who { return w === 'sysadmin-nows' ? 'sysadmin' : w }
  wsId(w: Who2) { return w === 'sysadmin-nows' ? null : this.fx.ws.id }

  async wsClient(w: Who2) {
    if (this.ws.has(w)) return this.ws.get(w)
    const c = createJunctionClient({ url: this.fx.env.url, token: this.fx.tokens[this.base(w)] ?? undefined, workspaceId: this.wsId(w) ?? undefined, timeout: 8000 } as any)
    c.connect()
    const t = Date.now()
    while (!(c as any)._wsReady && Date.now() - t < 5000) await new Promise(r => setTimeout(r, 10))
    if (!(c as any)._wsReady && this.fx.tokens[this.base(w)]) throw new Error(`ws not ready for ${w}`)
    this.ws.set(w, c)
    return c
  }
  async mcpClient(w: Who2) {
    if (this.mcp.has(w)) return this.mcp.get(w)
    const token = this.fx.tokens[this.base(w)]
    const headers: any = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(this.wsId(w) ? { 'x-workspace-id': this.wsId(w) } : {}) }
    const c = new Client({ name: 'audit', version: '1.0.0' })
    try { await c.connect(new StreamableHTTPClientTransport(new URL(`${this.fx.env.url}/mcp`), { requestInit: { headers } })) }
    catch (e) { this.mcp.set(w, { failed: String(e).slice(0, 120) }); return this.mcp.get(w) }
    this.mcp.set(w, c)
    return c
  }
  async tools(w: Who2): Promise<Set<string> | string> {
    const c = await this.mcpClient(w)
    if (c.failed) return c.failed
    return new Set((await c.listTools()).tools.map((t: any) => t.name))
  }
  async close() {
    for (const c of this.ws.values()) c.disconnect?.()
    for (const c of this.mcp.values()) await c.close?.().catch?.(() => {})
  }

  /** method: find | get | create | patch | remove */
  async call(path: PathName, w: Who2, svc: string, method: string, id?: string, data?: any): Promise<Out> {
    const fx = this.fx, who = this.base(w)
    const app = fx.env.app
    try {
      if (path === 'http') {
        const p = id ? `/${svc}/${id}` : `/${svc}`
        const verb = { find: 'GET', get: 'GET', create: 'POST', patch: 'PATCH', remove: 'DELETE' }[method]!
        const r = await http(fx, who, verb, p, data, this.wsId(w))
        return { ok: r.status < 400, status: r.status, body: r.json }
      }
      if (path === 'ws') {
        const c = await this.wsClient(w)
        const s = c.service(svc)
        const body = method === 'find' ? await s.find() : method === 'get' ? await s.get(id) : method === 'create' ? await s.create(data)
          : method === 'patch' ? await s.patch(id, data) : await s.remove(id)
        return { ok: true, status: 200, body }
      }
      if (path === 'mcp') {
        const c = await this.mcpClient(w)
        if (c.failed) return { ok: false, status: 'connect', body: c.failed }
        const args: any = method === 'create' ? { ...(data ?? {}) } : {}; if (id) args.id = id; if (method !== 'create' && data) args.data = data
        const r = await c.callTool({ name: `${svc}_${method}`, arguments: args }).catch((e: any) => ({ isError: true, content: [{ text: String(e) }] }))
        const text = r.content?.[0]?.text ?? ''
        let body: any = text; try { body = JSON.parse(text) } catch {}
        return { ok: !r.isError, status: r.isError ? 'mcp-refused' : 200, body }
      }
      if (path === 'job-caller-svc' || path === 'job-caller-db') {
        const uid = fx.ids[who]
        if (!uid) return { ok: false, status: 'no-principal', body: 'a stranger has no id to runAs' }
        const tenant = this.wsId(w)
        return await app.runAs(uid, { tenant }, async () => {
          if (path === 'job-caller-svc') {
            const s = app.service(svc)
            const body = method === 'find' ? await s.find() : method === 'get' ? await s.get(id) : method === 'create' ? await s.create(data)
              : method === 'patch' ? await s.patch(id, data) : await s.remove(id)
            return { ok: true, status: 200, body }
          }
          return await app.withDb(async (db: any) => {
            const m = db[ACCESSOR[svc]]
            const body = method === 'find' ? await m.findMany({ limit: 100 }) : method === 'get' ? await m.findFirst({ where: { id } })
              : method === 'create' ? await m.create({ data }) : method === 'patch' ? await m.update({ where: { id }, data })
              : await m.delete({ where: { id } })
            return { ok: true, status: 200, body }
          })
        })
      }
      // job-app: asSystem()
      const m = (app.db as any).asSystem()[ACCESSOR[svc]]
      const body = method === 'find' ? await m.findMany({ limit: 100 }) : method === 'get' ? await m.findFirst({ where: { id } })
        : method === 'create' ? await m.create({ data }) : method === 'patch' ? await m.update({ where: { id }, data })
        : await m.delete({ where: { id } })
      return { ok: true, status: 200, body }
    } catch (e) { return errOf(e) }
  }
}

export const SENTINELS = ['PLAINTEXT-SECRET-DATA', 'HASH-OF-ENROLL-TOKEN', 'SECRET-VAR-PLAINTEXT', 'OTHER-PLAINTEXT']
export function summarize(out: Out) {
  if (!out.ok) return { ok: false as const, status: out.status, why: typeof out.body === 'string' ? out.body : (out.body?.message ?? '') }
  const rows = rowsOf(out.body)
  const fields = [...new Set(rows.flatMap((r: any) => Object.keys(r)))].sort()
  const raw = JSON.stringify(out.body)
  return { ok: true as const, status: out.status, n: rows.length, fields, leaks: SENTINELS.filter(s => raw.includes(s)), rows }
}
