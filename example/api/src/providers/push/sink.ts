// api/src/providers/push/sink.ts — the browser's push service, standing in for it.
//
// A real push service (FCM, Mozilla autopush, Apple) accepts only a
// subscription its own browser made, and nothing reads back what it was sent.
// This one takes every request the webPush driver builds, keeps it, and
// answers the status it was told to, so a drive can hold a device's keys,
// decrypt what arrived, and make an endpoint answer 410.
//
// OPT-IN, unlike the mail sink: with PUSH_SINK_URL unset the driver sends to
// the real service, and a browser subscribed from the account page is pushed
// to for real. The driver's own SSRF check refuses a localhost endpoint, so the
// sink is reached through `deliver` rather than by storing its address as one.
//
//   bun api/src/providers/push/sink.ts                     # :8119
//   PUSH_SINK_URL=http://localhost:8119 bun run api
//
//   GET    /outbox          every request, newest last, body base64
//   DELETE /outbox          empty it
//   POST   /answer          { endpoint, status } — the status that endpoint gets from now on

import type { PushRequest } from '@frontierjs/notifications'

const PORT = Number(process.env.PUSH_SINK_PORT ?? 8119)

interface Received { url: string; headers: Record<string, string>; body: string; status: number; at: string }

export function startPushSink(port = PORT): { stop(): void; port: number } {
  const outbox: Received[] = []
  const answers = new Map<string, number>()

  const server = Bun.serve({
    port,
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname === '/outbox' && req.method === 'GET') return Response.json(outbox)
      if (pathname === '/outbox' && req.method === 'DELETE') { outbox.length = 0; answers.clear(); return new Response(null, { status: 204 }) }
      if (pathname === '/answer' && req.method === 'POST') {
        const { endpoint, status } = await req.json() as { endpoint: string; status: number }
        answers.set(endpoint, status)
        return new Response(null, { status: 204 })
      }
      if (pathname === '/push' && req.method === 'POST') {
        const got = await req.json() as Omit<Received, 'status' | 'at'>
        const status = answers.get(got.url) ?? 201
        outbox.push({ ...got, status, at: new Date().toISOString() })
        return Response.json({ status })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { stop: () => server.stop(true), port: server.port }
}

/** The driver's `deliver`: every push goes to the sink, which answers the push service's status. */
export function deliverToSink(sinkUrl: string) {
  return async (req: PushRequest): Promise<{ status: number }> => {
    const res = await fetch(`${sinkUrl}/push`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ url: req.url, headers: req.headers, body: Buffer.from(req.body).toString('base64') }),
    })
    if (!res.ok) throw new Error(`push sink at ${sinkUrl} answered ${res.status}`)
    return res.json() as Promise<{ status: number }>
  }
}

if (import.meta.main) {
  const { port } = startPushSink()
  console.log(`push sink on http://localhost:${port} — outbox: /outbox`)
}
