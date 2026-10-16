// src/core/workbench-terminal.ts — a shell in a pinned checkout, over a socket.
//
// The Terminal tab of a workbench card: a real terminal (Bun's own PTY, no
// native addon) in the pin's folder, as the operator's own account, streamed
// to xterm.js in the browser. Behind the workbench's refusal (LOCAL_MACHINE=1,
// never under NODE_ENV=production) and at ADMINISTRATOR like its service —
// this is the same power as a `claude -p` run with every permission, typed.
//
//   WS /ws/terminal/{pin}?workspace=&cols=&rows=
//     ← text   what the terminal wrote
//     → { i }  keystrokes, a paste
//     → { r }  [cols, rows] — the pane was resized
//
// Under /ws/ because both proxies already forward that prefix as a socket
// (web/config/vite.config.js, deploy/caddyfile.mjs) and no other.
//
// With tmux on PATH the shell is a tmux session named for the pin
// (core/workbench-shell.ts), so a closed socket — a tab switch, a reload, a
// `bun --watch` restart — kills only the tmux CLIENT and the next socket
// reattaches to the same shell. Without tmux the shell dies with its socket.
//
// A browser socket is not held to the same-origin rule, so any page the
// operator visits could open this one with their cookie; an Origin that is not
// this machine is refused at the upgrade, before the credential is read.

import { LEVELS }                from '@frontierjs/litestone'
import { localMachineRefusal }   from './env.ts'
import { basecampGateLevel }     from './gate.ts'
import { shellArgv }             from './workbench-shell.ts'
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
  app.ws('/ws/terminal/{pin}', {
    async open(ctx) {
      const refused = localMachineRefusal()
      if (refused) return ctx.close(4004, `The terminal is ${refused}`)

      const user = ctx.user as (typeof ctx.user & { isSystemAdmin?: boolean, status?: string }) | null
      if (!user) return ctx.close(4001, 'Sign in first')
      // Off-limits to a key for the reason the workbench service is (scopes.ts).
      if (user.authMethod === 'apiKey') return ctx.close(4003, 'An API key may not open a terminal')

      const workspaceId = String(ctx.query.workspace ?? '')
      const member = workspaceId
        ? await app.db!.asSystem().workspaceMember.findFirst({ where: { workspaceId, userId: user.userId }, select: { role: true } })
        : null
      const level = basecampGateLevel({ ...user, workspaceId, memberRole: member?.role })
      if (level < LEVELS.ADMINISTRATOR) return ctx.close(4003, 'The terminal is for a workspace administrator')

      const pin = app.workbench.getPin(ctx.route.pin)
      if (!pin) return ctx.close(4004, `No pinned checkout '${ctx.route.pin}'`)

      const cols  = clamp(ctx.query.cols, 2, 500, 80)
      const rows  = clamp(ctx.query.rows, 2, 200, 24)
      const argv  = shellArgv(pin.id, pin.path)

      // A UTF-8 character split across two reads must not become two U+FFFDs.
      const decoder = new TextDecoder()
      const proc = Bun.spawn(argv, {
        cwd: pin.path,
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
  }, {
    // Typing and a held key are many small frames; the default 100/s would
    // close the socket under a key repeat.
    limits:  { maxFramesPerSecond: 0, maxInFlight: 0 },
    upgrade: req => {
      const refused = originRefusal(req.headers.get('origin') ?? undefined)
      if (refused) return new Response(refused, { status: 403 })
    },
  })
}
