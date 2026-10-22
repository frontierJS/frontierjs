// FJS-2498: the site's API origin follows the API port a checkout was handed.
//
// api.js bakes its fallback in at build time and `fli dev` sets no
// FRONTIER_PUBLIC_API_URL, so the port has to reach the build through the vite
// config. Each case runs in its own process because the config writes
// process.env, which a second case in this one would inherit.
import { test, expect } from 'bun:test'
import { fileURLToPath } from 'node:url'

const CONFIG = fileURLToPath(new URL('../config/vite.config.js', import.meta.url))

async function originFor(env) {
  const script = `
    const config = await (await import(${JSON.stringify(CONFIG)})).default({ command: 'build', mode: 'production' })
    console.log(process.env.FRONTIER_PUBLIC_API_URL ?? '')
  `
  const base = { ...process.env }
  for (const k of ['FRONTIER_PUBLIC_API_URL', 'FRONTIER_PORT_BE', 'API_PORT']) delete base[k]
  const proc = Bun.spawn(['bun', '-e', script], { env: { ...base, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(err)
  return out.trim()
}

test('a branch checkout builds the site against its own API port', async () => {
  expect(await originFor({ FRONTIER_PORT_BE: '18110' })).toBe('http://localhost:18110')
})

test('API_PORT, what a drive sets, wins over the dev slot', async () => {
  expect(await originFor({ FRONTIER_PORT_BE: '18110', API_PORT: '17110' })).toBe('http://localhost:17110')
})

test('a stated FRONTIER_PUBLIC_API_URL is left alone', async () => {
  expect(await originFor({ FRONTIER_PORT_BE: '18110', FRONTIER_PUBLIC_API_URL: 'https://api.example.com' }))
    .toBe('https://api.example.com')
})
