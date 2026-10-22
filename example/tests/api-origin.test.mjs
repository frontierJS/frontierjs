// FJS-3454: widgets, extension and desktop follow the API port a checkout was
// handed, as the site does (site/test/api-origin.test.mjs).
//
// `fli dev` hands a branch its API port only as FRONTIER_PORT_BE, so a surface
// that falls back to a literal 8110 builds against the parent's API. Each case
// is its own process because the configs write process.env.
import { test, expect } from 'bun:test'
import { fileURLToPath } from 'node:url'

const at = rel => fileURLToPath(new URL(rel, import.meta.url))

const READERS = {
  // widgets build and dev both import this config; the origin reaches
  // import.meta.env through process.env.
  widgets:   `await import(${JSON.stringify(at('../widgets/config/sierra.config.js'))}); console.log(process.env.FRONTIER_PUBLIC_API_URL ?? '')`,
  extension: `console.log((await import(${JSON.stringify(at('../extension/config/jetty.config.js'))})).default.junction.url)`,
  desktop:   `console.log((await import(${JSON.stringify(at('../desktop/config/desktop.config.js'))})).default.api)`,
}

async function originFor(surface, env) {
  const base = { ...process.env }
  for (const k of ['FRONTIER_PUBLIC_API_URL', 'FRONTIER_PORT_BE', 'API_PORT']) delete base[k]
  const proc = Bun.spawn(['bun', '-e', READERS[surface]], { env: { ...base, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(err)
  return out.trim()
}

for (const surface of Object.keys(READERS)) {
  test(`${surface}: a branch checkout builds against its own API port`, async () => {
    expect(await originFor(surface, { FRONTIER_PORT_BE: '18110' })).toBe('http://localhost:18110')
  })

  test(`${surface}: API_PORT, what a drive sets, wins over the dev slot`, async () => {
    expect(await originFor(surface, { FRONTIER_PORT_BE: '18110', API_PORT: '17110' })).toBe('http://localhost:17110')
  })

  test(`${surface}: a stated FRONTIER_PUBLIC_API_URL is left alone`, async () => {
    expect(await originFor(surface, { FRONTIER_PORT_BE: '18110', FRONTIER_PUBLIC_API_URL: 'https://api.example.com' }))
      .toBe('https://api.example.com')
  })
}
