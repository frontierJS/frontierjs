// src/plugins/workbench-terminal.ts — a shell on this machine, over a socket.
//
// The Terminal tab of a workbench card, and the /terminal/ page: a real
// terminal (Bun's own PTY, no native addon) in the pin's folder, or in the
// operator's home folder when there is no pin, as their own account, streamed
// to xterm.js in the browser. Behind the workbench's refusal (LOCAL_MACHINE=1,
// never under NODE_ENV=production) and at ADMINISTRATOR like its service —
// this is the same power as a `claude -p` run with every permission, typed.
//
//   WS /ws/terminal/{pin}?cols=&rows=   the pin's shell
//   WS /ws/terminal?cols=&rows=         the home folder's shell
//     ← text   what the terminal wrote
//     → { i }  keystrokes, a paste
//     → { r }  [cols, rows] — the pane was resized
//
// Under /ws/ because both proxies already forward that prefix as a socket
// (web/config/vite.config.js, deploy/caddyfile.mjs) and no other.
//
// With tmux on PATH the shell is a tmux session named for the pin, or one of its own
// (domain/workbench/workbench-shell.ts), so a closed socket — a tab switch, a reload, a
// `bun --watch` restart — kills only the tmux CLIENT and the next socket
// reattaches to the same shell. Without tmux the shell dies with its socket.
//
// A browser socket is not held to the same-origin rule, so any page the
// operator visits could open this one with their cookie; an Origin that is not
// this machine is refused at the upgrade, before the credential is read.

import { homedir }               from 'node:os'
import { shellArgv }             from '../domain/workbench/workbench-shell.ts'
import type { App }              from '@frontierjs/junction'

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

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
}

type Proc = ReturnType<typeof Bun.spawn> & { terminal?: { write(d: string): void, resize(c: number, r: number): void } }

export function workbenchTerminal(app: App) {
  const handlers: Parameters<App['ws']>[1] = {
    async open(ctx) {
      const user = ctx.user as (typeof ctx.user & { isAdmin?: boolean }) | null
      if (!user) return ctx.close(4001, 'Sign in first')
      // Off-limits to a key for the reason the workbench service is (scopes.ts).
      if (user.authMethod === 'apiKey') return ctx.close(4003, 'An API key may not open a terminal')

      // The door grades its one member ADMINISTRATOR (auth.ts); a socket has no gate of its own.
      if (!user.isAdmin) return ctx.close(4003, 'The terminal is for the machine\'s owner')

      let shell = { id: null as string | null, path: homedir() }
      if (ctx.route.pin !== undefined) {
        const pin = app.workbench.getPin(ctx.route.pin)
        if (!pin) return ctx.close(4004, `No pinned checkout '${ctx.route.pin}'`)
        shell = pin
      }

      const cols  = clamp(ctx.query.cols, 2, 500, 80)
      const rows  = clamp(ctx.query.rows, 2, 200, 24)
      const argv  = shellArgv(shell.id, shell.path)

      // A UTF-8 character split across two reads must not become two U+FFFDs.
      const decoder = new TextDecoder()
      const proc = Bun.spawn(argv, {
        cwd: shell.path,
        env: { ...app.workbench.shellEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        terminal: {
          cols, rows,
          data(_t: unknown, bytes: Uint8Array) { ctx.send(decoder.decode(bytes, { stream: true })) },
        },
      } as Parameters<typeof Bun.spawn>[1]) as Proc
      ctx.locals.proc = proc
      proc.exited.then(code => ctx.close(1000, `exited ${code}`))
    },

    message(ctx, msg) {
      const proc = ctx.locals.proc as Proc | undefined
      if (!proc?.terminal) return
      let frame: { i?: unknown, r?: unknown }
      try { frame = JSON.parse(String(msg)) } catch { return }
      if (typeof frame.i === 'string') proc.terminal.write(frame.i)
      if (Array.isArray(frame.r)) proc.terminal.resize(clamp(frame.r[0], 2, 500, 80), clamp(frame.r[1], 2, 200, 24))
    },

    close(ctx) {
      // tmux: the client goes and the session stays for the next socket.
      ;(ctx.locals.proc as Proc | undefined)?.kill()
    },
  }
  const options: Parameters<App['ws']>[2] = {
    // Typing and a held key are many small frames; the default 100/s would
    // close the socket under a key repeat.
    limits:  { maxFramesPerSecond: 0, maxInFlight: 0 },
    upgrade: req => {
      const refused = originRefusal(req.headers.get('origin') ?? undefined)
      if (refused) return new Response(refused, { status: 403 })
    },
  }
  app.ws('/ws/terminal/{pin}', handlers, options)
  app.ws('/ws/terminal',       handlers, options)
}
