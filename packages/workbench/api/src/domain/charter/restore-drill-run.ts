// api/src/domain/charter/restore-drill-run.ts
// `bun restore-drill-run.ts <record>`: one restore drill as its own process, so
// a restart of the API cannot stop it between the retire and the install. This
// file binds `runDrill`'s deps to the real Basecamp, box and fli; the keys are
// read here and go nowhere but the Authorization header of a call to that hub.

import { readFileSync, writeFileSync }    from 'node:fs'
import { dirname, join }                  from 'node:path'
import { entryOf }                        from '../basecamps/basecamps.ts'
import { reinstallArgv }                  from '../basecamps/basecamps-reinstall.ts'
import { spawnFli }                       from '../basecamps/basecamps-create.ts'
import { deployRefusals, runDrill, type Deps, type Drill, type Probe } from './restore-drill.ts'

type Basecamp = {
  basecamp:    (origin: string, key: string, path: string, o?: { method?: string, body?: unknown, headers?: Record<string, string> }) => Promise<any>
  basecampAll: (origin: string, key: string, path: string) => Promise<Array<Record<string, any>>>
  asRootOn:    (host: string, script: string, what: string) => Promise<string>
}
type Registry = { readBasecamps: () => Record<string, { url: string, apiKey?: string, scopedKey?: string }> }

const PROBE_TIMEOUT_MS = 10_000

async function probe(hostname: string): Promise<Probe> {
  try {
    const res = await fetch(`https://${hostname}/`, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return { ok: res.status < 500, status: res.status, why: null }
  } catch (e) { return { ok: false, status: null, why: (e as Error).message } }
}

const file  = process.argv[2]
const drill = JSON.parse(readFileSync(file, 'utf8')) as Drill
drill.pid   = process.pid

const entry = await entryOf(drill.basecamp)
if (!entry?.apiKey || !entry.host) throw new Error(`Basecamp '${drill.basecamp}' lost its key or ssh Host`)
const { url, apiKey, host } = entry as { url: string, apiKey: string, host: string }

const { basecamp, basecampAll, asRootOn } = await import('@frontierjs/cli/core/basecamp.js') as unknown as Basecamp
const { readBasecamps } = await import('@frontierjs/cli/core/basecamps.js') as unknown as Registry
const gate = await deployRefusals()

// Each key is asked of a path any key may read; 403 is an authenticated key its scope stops.
async function keys() {
  const filed = Object.entries(readBasecamps()).filter(([, e]) => e.url === url)
    .flatMap(([name, e]) => [[name, e.apiKey], [`${name} (run key)`, e.scopedKey]] as const)
    .filter((k): k is readonly [string, string] => !!k[1])
  return Promise.all(filed.map(async ([name, key]) => {
    try {
      const res = await fetch(`${url}/apps?$limit=1`, { headers: { accept: 'application/json', authorization: `Bearer ${key}` } })
      return { name, status: res.status }
    } catch { return { name, status: null } }
  }))
}

const deps: Deps = {
  save:  d => writeFileSync(file, JSON.stringify(d, null, 2)),
  gate:  () => gate,
  read:  path => basecamp(url, apiKey, path),
  list:  path => basecampAll(url, apiKey, path),
  call:  (path, method, body) => basecamp(url, apiKey, path, { method: 'POST', body, headers: method ? { 'x-service-method': method } : {} }),
  keys,
  probe,
  box:   (script, what) => asRootOn(host, script, what),
  reinstall: plan => {
    const argv = reinstallArgv(drill.basecamp, host, { name: drill.basecamp, mode: 'restore', plan }) as string[]
    return spawnFli('restore-drill-reinstall', drill.basecamp, [...argv, '--approved'], { dir: join(dirname(dirname(file))) })
  },
  sleep: ms => new Promise(done => setTimeout(done, ms)),
  now:   () => Date.now(),
}

await runDrill(drill, deps)
process.exit(0)
