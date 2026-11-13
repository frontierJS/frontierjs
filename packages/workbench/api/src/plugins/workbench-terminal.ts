// src/plugins/workbench-terminal.ts — a shell on this machine, over a socket.
//
// The Terminal tab of a workbench card, and the /terminal/ page: a shell in
// the pin's folder, or in the operator's home folder when there is no pin, as
// their own account (`@frontierjs/junction/terminal`, `FJS-D2125`). Behind the
// workbench's refusal (LOCAL_MACHINE=1, never under NODE_ENV=production) and
// at ADMINISTRATOR like its service — this is the same power as a `claude -p`
// run with every permission, typed.
//
//   WS /ws/terminal/{pin}?cols=&rows=   the pin's shell
//   WS /ws/terminal?cols=&rows=         the home folder's shell
//
// Under /ws/ because both proxies already forward that prefix as a socket
// (web/config/vite.config.js, deploy/caddyfile.mjs) and no other.
//
// A browser socket is not held to the same-origin rule, so any page the
// operator visits could open this one with their cookie; an Origin that is not
// this machine is refused at the upgrade, before the credential is read.

import { homedir }                   from 'node:os'
import { terminalSocket }            from '@frontierjs/junction/terminal'
import type { TerminalOptions }      from '@frontierjs/junction/terminal'
import { SOCKET, sessionOf }         from '../domain/workbench/workbench-shell.ts'
import type { App }                  from '@frontierjs/junction'

const ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'tauri.localhost'])

/** Why this Origin may not open a shell here, or null when it may. */
export function originRefusal(origin: string | undefined): string | null {
  if (!origin) return null   // not a browser: the bearer is the whole credential
  if (origin === 'tauri://localhost') return null
  try {
    if (ORIGIN_HOSTS.has(new URL(origin).hostname)) return null
  } catch {}
  return `a page on ${origin} may not open a terminal on this machine`
}

export function workbenchTerminal(app: App) {
  const pinOf = (route: Record<string, string>) => route.pin === undefined ? null : app.workbench.getPin(route.pin)

  const options: TerminalOptions = {
    refuse: {
      upgrade: req => originRefusal(req.headers.get('origin') ?? undefined),
      open(ctx) {
        const user = ctx.user as (typeof ctx.user & { isAdmin?: boolean }) | null
        if (!user) return { code: 4001, reason: 'Sign in first' }
        // Off-limits to a key for the reason the workbench service is (scopes.ts).
        if (user.authMethod === 'apiKey') return { code: 4003, reason: 'An API key may not open a terminal' }
        // The door grades its one member ADMINISTRATOR (auth.ts); a socket has no gate of its own.
        if (!user.isAdmin) return { code: 4003, reason: 'The terminal is for the machine\'s owner' }
        if (ctx.route.pin !== undefined && !pinOf(ctx.route)) return { code: 4004, reason: `No pinned checkout '${ctx.route.pin}'` }
        return null
      },
    },
    cwd:     ctx => pinOf(ctx.route)?.path ?? homedir(),
    session: ctx => sessionOf(pinOf(ctx.route)?.id ?? null),
    env:     () => app.workbench.shellEnv(),
    socket:  SOCKET,
  }
  terminalSocket(app, '/ws/terminal/{pin}', options)
  terminalSocket(app, '/ws/terminal',       options)
}
