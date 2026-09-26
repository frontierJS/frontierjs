/*
 * src/client/routes.ts — the commands an app writes by hand (`FJS-D396`).
 *
 * A file under `cli/src/routes/<service>/<method>.{js,ts}` is the command
 * `<service> <method>`: it ADDS one the tool list does not carry — a composite,
 * a summary, a local step — or REPLACES the derived command of the same name.
 * The path is the name, the way a file under `web/src/routes/` is a page.
 *
 * **A route declares the tools it `uses`, and may call no others.** That list
 * is what keeps a route honest in both directions:
 *   - at run time a route whose tools are not all in the caller's list is not
 *     offered, exactly like a derived command — from the client, a tool that no
 *     longer exists and one this standing is not offered are the same absence;
 *   - `checkRoutes` against the app's list at its top standing refuses a route
 *     naming a tool that is GONE, by name. That is the half of `FJS-D396`'s
 *     start-up refusal a client can actually decide, and the app's own drive is
 *     where it runs, so a route outliving the method it replaced fails a test.
 *
 * Flags are the same as a derived command's: `input` is a JSON Schema and goes
 * through `argv.ts`, so `--help` and every refusal read the same.
 */

import { readdirSync, statSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import type { ToolListing } from './argv.ts'

export interface RouteContext {
  /** The command line after `<service> <method>`, parsed against `input`. */
  args:  Record<string, unknown>
  /** Call one of the declared tools; answers its data, or throws the app's refusal. */
  call:  (tool: string, args?: Record<string, unknown>) => Promise<unknown>
  out:   (text: string) => void
  err:   (text: string) => void
  /** `--json` was asked for: write one JSON document to `out`. */
  json:  boolean
}

export interface RouteDefinition {
  description: string
  /** Every tool the route calls, by tool name (`servers_find`). */
  uses:        string[]
  /** The route's own flags, as a JSON Schema object. */
  input?:      Record<string, unknown>
  /** Answers an exit code; nothing is 0. */
  run(ctx: RouteContext): Promise<number | void> | number | void
}

export interface Route extends RouteDefinition {
  service: string
  method:  string
  /** Where it came from, for a message that names the file. */
  file:    string
}

/** Typed identity: `export default defineCommand({ … })`. */
export function defineCommand(def: RouteDefinition): RouteDefinition {
  return def
}

/** A refusal from the app, surfaced to a route as a throw it may catch. */
export class CallRefused extends Error {
  constructor(readonly tool: string, message: string) {
    super(message)
    this.name = 'CallRefused'
  }
}

const EXT = new Set(['.js', '.mjs', '.ts'])

/**
 * Every route under a directory: `<service>/<method>.{js,mjs,ts}`, and nothing
 * at the top level — a command is always two words.
 */
export async function loadRoutes(dir: string | URL): Promise<Route[]> {
  const root = typeof dir === 'string' ? dir : fileURLToPath(dir)
  const out: Route[] = []
  let services: string[]
  try { services = readdirSync(root) } catch { return [] }

  for (const service of services.sort()) {
    const sdir = join(root, service)
    if (!statSync(sdir).isDirectory()) {
      if (EXT.has(extname(service)))
        throw new Error(`${join(root, service)}: a route is <service>/<method>, so it cannot sit at the top of routes/`)
      continue
    }
    for (const f of readdirSync(sdir).sort()) {
      if (!EXT.has(extname(f)) || f.includes('.test.') || f.includes('.spec.')) continue
      const file = join(sdir, f)
      const mod  = await import(pathToFileURL(file).href)
      const def  = mod.default as RouteDefinition | undefined
      if (!def || typeof def.run !== 'function' || !Array.isArray(def.uses))
        throw new Error(`${file}: the default export is not a command — export default defineCommand({ description, uses, run })`)
      out.push({ ...def, service, method: basename(f, extname(f)), file })
    }
  }
  return out
}

/** Whether a route can be offered to a caller holding this list. */
export function routeOffered(route: Route, tools: ToolListing[]): boolean {
  const names = new Set(tools.map(t => t.name))
  return route.uses.every(u => names.has(u))
}

/**
 * Every route that names a tool the app does not have, graded against the
 * list at the app's TOP standing — a narrower list would report a route as
 * stale for a tool that is merely not offered there.
 */
export function checkRoutes(routes: Route[], tools: ToolListing[]): string[] {
  const names = new Set(tools.map(t => t.name))
  const problems: string[] = []
  for (const r of routes) {
    for (const u of r.uses)
      if (!names.has(u)) problems.push(`${r.service} ${r.method} (${r.file}) uses ${u}, which the app no longer offers at any standing`)
  }
  return problems
}
