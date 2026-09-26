/*
 * src/client/main.ts — an app's CLI as a process, from its `cli/` surface.
 *
 * `cli/src/main.js` is the whole of an app's entry:
 *
 *   import config   from '../config/cli.config.js'
 *   import { main } from '@frontierjs/mcp/client'
 *   await main({ ...config, routes: new URL('./routes/', import.meta.url) })
 *
 * The config says what only the app knows — its name (whose config and cache
 * directories these are), the header its tenant travels in (`FJS-D399`), and
 * the endpoint a first `login` defaults to. The environment still overrides a
 * profile for one run, which is how a script or a CI job passes a key:
 *   FJS_MCP_URL · FJS_TOKEN · FJS_TENANT · FJS_PROFILE · FJS_CLI_TRACE
 */

import { readFileSync }          from 'node:fs'
import { run }                   from './run.ts'
import { configPath, fileStore } from './profiles.ts'
import { cacheDir, fileCache }   from './cache.ts'
import { loadRoutes, type Route } from './routes.ts'

export interface CliConfig {
  /** The program's name — `basecamp` — and so where its profiles and cache live. */
  name?:         string
  /** The header this app reads its tenant from, where it has one. */
  tenantHeader?: string
  /** The endpoint `login` uses when none is given. */
  url?:          string
  /** `cli/src/routes/`, or routes already loaded. */
  routes?:       string | URL | Route[]
}

export async function main(config: CliConfig = {}, argv = process.argv.slice(2)): Promise<never> {
  const env  = process.env
  const name = config.name || env.FJS_APP || 'frontierjs'
  let routes: Route[]
  try {
    routes = Array.isArray(config.routes) ? config.routes
      : config.routes ? await loadRoutes(config.routes) : []
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`)
    process.exit(1)
  }

  const code = await run(argv, {
    url:          env.FJS_MCP_URL || undefined,
    token:        env.FJS_TOKEN || undefined,
    name,
    tenantHeader: config.tenantHeader || env.FJS_TENANT_HEADER || undefined,
    tenant:       env.FJS_TENANT || undefined,
    profile:      env.FJS_PROFILE || undefined,
    defaultUrl:   config.url,
    store:        fileStore(configPath(name)),
    cache:        fileCache(cacheDir(name)),
    routes,
    trace:        env.FJS_CLI_TRACE ? line => process.stderr.write(`· ${line}\n`) : undefined,
    out:          text => process.stdout.write(text + '\n'),
    err:          text => process.stderr.write(text + '\n'),
    readFile:     path => readFileSync(path, 'utf8'),
    readStdin:    () => readFileSync(0, 'utf8'),
    // With nothing piped, `login --api-key -` would wait on a silent terminal for an EOF.
    readSecret:   process.stdin.isTTY ? askHidden : undefined,
  })
  process.exit(code)
}

/** One line from the terminal, not echoed. Ctrl-C leaves the way it would anywhere else. */
function askHidden(prompt: string): Promise<string> {
  const stdin = process.stdin
  process.stderr.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  return new Promise(resolve => {
    let text = ''
    const done = (answer: string) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
      resolve(answer)
    }
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(text)
        if (ch === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130) }
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1)
        else if (ch >= ' ') text += ch
      }
    }
    stdin.on('data', onData)
  })
}
