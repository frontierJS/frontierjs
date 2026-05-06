// Fixture Harbor — Phase 4 smoke.
//
// Adds island registration on top of Phase 3 (resources). Harbor reads the
// `islands` map from jetty.config.js and passes it to defineHarbor so the
// runtime can call chrome.scripting.registerContentScripts.

import { defineHarbor } from '../../../../../src/index.js'
import jettyConfig      from '../../config/jetty.config.js'

function createMockAdapter() {
  let connected = false
  let token = null
  const events = { connect: new Set(), disconnect: new Set(), reconnect: new Set(), error: new Set() }
  const users = {
    'demo@example.com':  { id: 1, email: 'demo@example.com',  name: 'Demo User' },
    'admin@example.com': { id: 2, email: 'admin@example.com', name: 'Admin'    },
  }

  // Fake leads dataset — initial seed + push event simulator.
  let _leadsNextId = 4
  const leads = [
    { id: 1, name: 'Acme Corp',  status: 'active',   ownerId: 1 },
    { id: 2, name: 'Globex Inc', status: 'pending',  ownerId: 1 },
    { id: 3, name: 'Initech',    status: 'inactive', ownerId: 2 },
  ]
  // Track service-channel handlers so push events can fan out
  const channelHandlers = new Map() // channel name → handler

  return {
    async connect(opts) {
      connected = true
      token = opts.token ?? null
      console.log('[mock-junction] connected:', opts.url, token ? '(authed)' : '(anon)')
      for (const fn of events.connect) fn()
    },
    async disconnect() { connected = false; for (const fn of events.disconnect) fn() },
    isConnected() { return connected },
    async setToken(t) { token = t },
    async call(service, method, args) {
      console.log('[mock-junction] call', `${service}.${method}`, args)

      // Auth
      if (service === 'auth' && method === 'login') {
        const u = users[args?.email]
        if (!u) throw new Error('unknown user')
        if (args?.password !== 'demo') throw new Error('bad password (hint: "demo")')
        return { token: `tok-${u.id}-${Date.now()}`, user: u, expiresAt: null }
      }
      if (service === 'auth' && method === 'logout') return { ok: true }
      if (service === 'auth' && method === 'verify') {
        if (typeof args?.token === 'string' && args.token.startsWith('tok-')) {
          const id = parseInt(args.token.split('-')[1], 10)
          const u = Object.values(users).find((x) => x.id === id)
          return u ? { user: u, expiresAt: null } : null
        }
        return null
      }

      // Schema
      if (service === '__schema__' && method === 'fetch') {
        return {
          version: 'demo-schema-v3',
          schema: {
            $defs: {
              leads: {
                properties: {
                  id:      { type: 'integer' },
                  name:    { type: 'string' },
                  status:  { type: 'string', default: 'new' },
                  ownerId: { type: 'integer' },
                },
              },
            },
            resources: ['leads'],
          },
        }
      }
      if (service === '__schema__' && method === 'version') {
        return { version: 'demo-schema-v3' }
      }

      // Leads service
      if (service === 'leads') {
        if (method === 'find') {
          const q = args?.query ?? {}
          let result = [...leads]
          if (q.status) result = result.filter((l) => l.status === q.status)
          return result
        }
        if (method === 'get') {
          const id = args?.id
          const found = leads.find((l) => l.id === id)
          if (!found) throw new Error(`lead ${id} not found`)
          return found
        }
        if (method === 'create') {
          const lead = { ...args?.data, id: _leadsNextId++ }
          leads.push(lead)
          // Simulate the push event that real Junction sends after a create
          setTimeout(() => fireChannel('leads:created', lead), 0)
          return lead
        }
        if (method === 'patch') {
          const id = args?.id
          const idx = leads.findIndex((l) => l.id === id)
          if (idx === -1) throw new Error(`lead ${id} not found`)
          leads[idx] = { ...leads[idx], ...(args?.data ?? {}) }
          setTimeout(() => fireChannel('leads:patched', leads[idx]), 0)
          return leads[idx]
        }
        if (method === 'remove') {
          const id = args?.id
          const idx = leads.findIndex((l) => l.id === id)
          if (idx === -1) throw new Error(`lead ${id} not found`)
          const [removed] = leads.splice(idx, 1)
          setTimeout(() => fireChannel('leads:removed', removed), 0)
          return removed
        }
      }

      throw new Error(`mock: no handler for ${service}.${method}`)
    },
    async subscribe(channel, handler) {
      channelHandlers.set(channel, handler)
      return () => channelHandlers.delete(channel)
    },
    on(event, fn) { events[event]?.add(fn); return () => events[event]?.delete(fn) },
    async fetchSchema() { return this.call('__schema__', 'fetch', {}) },
    async getServerSchemaVersion() { const r = await this.call('__schema__', 'version', {}); return r?.version ?? null },
  }

  function fireChannel(name, payload) {
    const handler = channelHandlers.get(name)
    if (handler) handler(payload)
  }
}

export default defineHarbor({
  junction: {
    url:      'mock://local',
    tokenKey: 'phase3_token',
    adapter:  createMockAdapter,
  },

  // Pass islands config from jetty.config.js so harbor can register them
  // via chrome.scripting on every wake.
  islands: jettyConfig.islands,

  async run({ storage, junction, pages, channels }) {
    console.log('[harbor] awake; junction connected?', junction.isConnected())

    try {
      await storage.local.set({ phase3_seen_at: Date.now() })
    } catch {}

    channels.on('connection', ({ type, id }) => {
      console.log('[harbor] connection:', type, id)
    })

    setTimeout(() => {
      const ok = pages.broadcast('hello-from-run', {
        message: 'Phase 3 smoke — try create/patch/remove a lead',
        at: Date.now(),
      })
      console.log('[harbor] hello broadcast → delivered?', ok)
    }, 1000)
  },
})
