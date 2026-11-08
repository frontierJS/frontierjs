// FJS-3236: the API's sinks follow the API port a checkout was handed.
//
// `fli prove` and `fli dev` hand a lane or branch its API port only as
// FRONTIER_PORT_BE, and the sinks (mail, psp, idp, stripe, push) kept their dev
// literals 8111–8119. The lane's API then died on "port already answering"
// whenever the main checkout's API held 8111, so the drive never reached it. The
// sink is the API's port plus its service digit (packages/cli/core/ports.js),
// which is also how the test tier's 7111–7119 are spelled. Each case is its own
// process because the modules read process.env at import.
import { test, expect } from 'bun:test'
import { fileURLToPath } from 'node:url'

const at = rel => fileURLToPath(new URL(rel, import.meta.url))

const READ = `
  const m = await import(${JSON.stringify(at('../api/src/providers/mail/sink.ts'))})
  const i = await import(${JSON.stringify(at('../api/src/providers/idp/sink.ts'))})
  const s = await import(${JSON.stringify(at('../api/src/providers/stripe/index.ts'))})
  const p = await import(${JSON.stringify(at('../api/src/providers/psp/index.ts'))})
  const c = await import(${JSON.stringify(at('../api/src/core/sink-ports.ts'))})
  console.log(JSON.stringify({ mail: c.sinkPort(1, 'MAIL_SINK_PORT'), psp: p.PSP_URL, idp: i.IDP_URL, stripe: s.STRIPE_URL, push: c.sinkPort(9, 'PUSH_SINK_PORT'), api: c.API_PORT }))
`

async function read(env) {
  const base = { ...process.env }
  for (const k of ['FRONTIER_PORT_BE', 'API_PORT', 'MAIL_SINK_PORT', 'PSP_SINK_PORT', 'IDP_SINK_PORT', 'STRIPE_SINK_PORT', 'PUSH_SINK_PORT', 'PSP_URL', 'IDP_URL', 'STRIPE_URL', 'MAIL_SINK_URL']) delete base[k]
  const proc = Bun.spawn(['bun', '--no-env-file', '-e', READ], { env: { ...base, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(err)
  return JSON.parse(out)
}

test('no env: the sinks sit at the API port plus their service digit', async () => {
  const { api, ...sinks } = await read({})
  expect(sinks).toEqual({ mail: api + 1, psp: `http://localhost:${api + 2}`, idp: `http://localhost:${api + 3}`, stripe: `http://localhost:${api + 4}`, push: api + 9 })
})

test('a lane handed FRONTIER_PORT_BE gets its own sinks beside its API', async () => {
  expect(await read({ FRONTIER_PORT_BE: '18110' })).toEqual({ api: 18110, mail: 18111, psp: 'http://localhost:18112', idp: 'http://localhost:18113', stripe: 'http://localhost:18114', push: 18119 })
})

test('API_PORT, what a drive sets, wins over FRONTIER_PORT_BE', async () => {
  expect((await read({ FRONTIER_PORT_BE: '18110', API_PORT: '17110' })).mail).toBe(17111)
})

test('a stated sink port is left alone', async () => {
  const got = await read({ FRONTIER_PORT_BE: '18110', MAIL_SINK_PORT: '9111', STRIPE_SINK_PORT: '9114' })
  expect(got.mail).toBe(9111)
  expect(got.stripe).toBe('http://localhost:9114')
})
