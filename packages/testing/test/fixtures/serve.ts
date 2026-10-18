// A server for drive.test.ts: answers on $PORT until it is killed.
Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('up') })
