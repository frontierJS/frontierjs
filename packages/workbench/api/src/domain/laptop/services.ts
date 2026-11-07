// api/src/domain/laptop/services.ts
// The accounts fli signs in to (`core/services.js`) as the Services tab shows
// them: how each is signed in to, whether it is, and which fli commands use it.
//
// Presence is a name and a boolean. A key is `present` or not and its value
// never leaves `listGlobal`'s caller; a probe answers only `who` -- the account
// name or email its binary printed -- because `gh auth status` prints the first
// characters of the token and the page must never hold them. `core/services.js`
// scrubs that text; `who` is clipped here as well, so a reader that matched too
// much still cannot carry a paragraph out.
//
// The commands are derived from the registry, which needs `global.fliRoot` and
// `global.projectRoot`. They are set for the one build and put back, since the
// Workbench API is not the fli process and other code in it must not see them.
// The registry is built once; a command added while the API runs shows after a restart.

import { dirname, resolve }                                     from 'node:path'
import { fileURLToPath }                                        from 'node:url'
import { BadRequest, NotFound }                                 from '@frontierjs/junction'
import { listGlobal }                                           from '@frontierjs/cli/core/global-env.js'
import { commandsUsing, probeService as probe, services, servicesReport } from '@frontierjs/cli/core/services.js'
import type { Where }                                           from './laptop.ts'

export type SignIn =
  | { kind: 'env',  keys: Array<{ key: string, present: boolean }> }
  | { kind: 'file', entry: string }
  | { kind: 'cli',  bin: string, installed: boolean, login: string }
export type Service = {
  id: string, name: string, signIn: SignIn, present: boolean,
  setup: string | null, vendor: { url: string, note: string } | null,
  commands: Array<{ name: string, description: string }>,
}
export type Probe = { ok: boolean, who: string | null, ms: number }

type Env = Record<string, string | undefined>
export type Options = Where & { env?: Env }

type Row = {
  id: string, name: string, namespaces: string[], setup: string | null, also: string[],
  signIn: { kind: 'env' | 'file' | 'cli', keys?: string[], entry?: string, path?: string, bin?: string, login?: string },
  vendor?: { url: string, note?: string },
}
const catalog = services as unknown as Row[]
const pinned  = (home?: string) => home === undefined ? {} : { home }

// ─── the registry, once ──────────────────────────────────────────────────────

type Command = { name: string, description: string }
let registry: Promise<unknown> | null = null

function build() {
  const cli  = resolve(dirname(fileURLToPath(import.meta.resolve('@frontierjs/cli/core/paths.js'))), '..')
  const g    = globalThis as unknown as { fliRoot?: string, projectRoot?: string }
  const held = { fliRoot: g.fliRoot, projectRoot: g.projectRoot }
  g.fliRoot = cli
  // A root with no `cli/src/routes` under it, so no project's own commands are listed as fli's.
  g.projectRoot = cli
  return import('@frontierjs/cli/core/registry.js')
    .then(m => (m as { buildRegistry: () => unknown }).buildRegistry())
    .finally(() => { g.fliRoot = held.fliRoot; g.projectRoot = held.projectRoot })
}

async function usedBy(row: Row): Promise<Command[]> {
  registry ??= build()
  return commandsUsing(row as never, await registry as never)
    .map((c: { title: string, description: string }) => ({ name: c.title, description: c.description }))
}

// ─── the list ────────────────────────────────────────────────────────────────

/** Every service with its sign-in, presence, setup pointer, vendor page and the commands that use it. */
export async function servicesList({ home, env }: Options = {}): Promise<Service[]> {
  const live  = env ?? process.env
  const held  = new Set(listGlobal(pinned(home)).filter((e: { value: string }) => e.value).map((e: { key: string }) => e.key))
  const have  = (key: string) => held.has(key) || Boolean(live[key])
  const state = new Map((servicesReport({ home, probe: false, env: live as never } as never) as Array<{ id: string, present: boolean }>).map(r => [r.id, r.present]))

  return Promise.all(catalog.map(async (s): Promise<Service> => {
    const { kind } = s.signIn
    const present  = state.get(s.id) ?? false
    const signIn: SignIn =
      kind === 'env'  ? { kind, keys: (s.signIn.keys ?? []).map(key => ({ key, present: have(key) })) }
    : kind === 'file' ? { kind, entry: s.signIn.entry ?? s.signIn.path ?? '' }
    :                   { kind: 'cli', bin: s.signIn.bin ?? '', installed: present, login: s.signIn.login ?? '' }
    return {
      id: s.id, name: s.name, signIn, present,
      setup:  s.setup,
      vendor: s.vendor?.url ? { url: s.vendor.url, note: s.vendor.note ?? '' } : null,
      commands: await usedBy(s),
    }
  }))
}

/** Which service names each global-env key, for Settings' "Used by". */
export function keyOwners(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const s of catalog) for (const key of [...(s.signIn.keys ?? []), ...s.also]) (out[key] ??= []).push(s.name)
  return out
}

/** Run one CLI service's probe. Only the account name leaves; never the binary's output. */
export function probeService(id: string, { env }: Options = {}): Probe {
  const row = catalog.find(s => s.id === id)
  if (!row)                    throw new NotFound(`No service '${id}'`)
  if (row.signIn.kind !== 'cli') throw new BadRequest(`${row.name} signs in by ${row.signIn.kind}; there is no login to check`)
  const out = probe(row as never, env ? { env: env as never } : {}) as Probe
  return { ok: out.ok, who: out.who ? out.who.slice(0, 80) : null, ms: out.ms }
}
