/**
 * A real Junction app for test/event-stream.test.js — spawned as a bun
 * subprocess, because junction is Bun-only and sierra's vitest runs under node.
 * The frames are the ones `ctx.sse()` writes, so the reader is graded against
 * the writer rather than against a stream written by hand.
 *
 *   bun test/fixtures/event-stream-server.ts [port]
 */

import { createApp } from '../../../junction/index.ts'

const port = Number(process.argv[2] ?? 7925)

let disconnects = 0

const app = createApp({
  config: {
    port,
    services: { dir: '/nonexistent' },
  },
  logLevel: 'silent',
})

app.get('/ping', (ctx: any) => ctx.json({ ok: true }))

// A stream that finishes: a named event, a bare payload, and the end.
app.get('/stream', (ctx: any) => {
  if (ctx.headers.authorization !== 'Bearer good') {
    return new Response(JSON.stringify({ message: 'Sign in to read this stream' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    })
  }
  const { response, send, close } = ctx.sse()
  queueMicrotask(() => {
    send({ event: 'land', data: { hits: ['a', 'b'] }, id: '1' })
    send('bare')
    send({ event: 'done', data: null })
    close()
  })
  return response
})

// A stream that never finishes, so only the reader hanging up can end it.
app.get('/forever', (ctx: any) => {
  const { response, send, onDisconnect } = ctx.sse()
  let n = 0
  const timer = setInterval(() => send({ data: { n: n++ } }), 10)
  onDisconnect(() => { clearInterval(timer); disconnects++ })
  return response
})

app.get('/json', (ctx: any) => ctx.json({ bang: '!w' }))

app.get('/__disconnects', (ctx: any) => ctx.json({ disconnects }))

await app.start()
console.log(`READY ${port}`)
