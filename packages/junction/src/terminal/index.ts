// terminal/index.ts — a shell on this machine, over a raw socket (`FJS-D2125`).
//
// The server half of an integrated terminal: Bun's own PTY (no native addon),
// streamed to xterm.js in the page (`@frontierjs/ui/components/display/Terminal.mesa`).
//
//   ← text               what the terminal wrote
//   → { i }              keystrokes, a paste
//   → { r: [cols, rows] } the pane was resized
//   ?cols=&rows=         the size at the upgrade
//
// This is the same power as the operator's own login shell, so a mount names
// its refusal or does not mount: a forgotten check is a shell for whoever can
// reach the port, and nothing downstream would notice.
//
// With tmux on PATH the shell is a tmux session on the app's own tmux server
// (`-L <socket>`), so a closed socket — a tab switch, a reload, a `bun --watch`
// restart — kills only the tmux CLIENT and the next socket reattaches to the
// same shell. The operator's ~/.tmux.conf still applies, but the
// `default-terminal` set here does not reach their other sessions; without it
// tmux hands the shell TERM=screen, eight colors. Without tmux the shell dies
// with its socket.

import type { WsContext, WsHandlerSet } from '../transport/types.ts'
import type { WsRouteOptions }          from '../transport/http.ts'

/** What `refuse.open` answers to close a socket it will not give a shell. */
export interface TerminalRefusal { code: number, reason: string }

type Awaitable<T> = T | Promise<T>

export interface TerminalOptions {
  /**
   * Who may not have a shell. `upgrade` runs before the socket is accepted —
   * a string is a 403 with that body, a Response goes out as is; `open` runs
   * once it is, with the session read — a refusal closes it with its code.
   * Null or undefined lets the caller through. At least one is required.
   */
  refuse:  {
    upgrade?: (req: Request) => string | Response | null | undefined
    open?:    (ctx: WsContext) => Awaitable<TerminalRefusal | null | undefined>
  }
  /** The folder the shell starts in. Runs after `refuse.open` let the socket through. */
  cwd:     (ctx: WsContext) => string
  /** The tmux session the socket attaches to; one per shell that should outlive its socket. */
  session: (ctx: WsContext) => string
  /** The child's environment, before TERM and COLORTERM are set. */
  env:     (ctx: WsContext) => Record<string, string | undefined>
  /** The tmux server's name (`tmux -L <socket>`), so the app's sessions are not the operator's. */
  socket?: string
}

interface AppWs { ws(path: string, handlers: WsHandlerSet, opts?: WsRouteOptions): unknown }

type Pty = ReturnType<typeof Bun.spawn> & { terminal?: { write(d: string): void, resize(c: number, r: number): void } }

const DEFAULT_SOCKET = 'frontier'

export const clampCols = (n: unknown) => clamp(n, 2, 500, 80)
export const clampRows = (n: unknown) => clamp(n, 2, 200, 24)

function clamp(n: unknown, lo: number, hi: number, fallback: number) {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
}

// tmux refuses `.` and `:` in a session name.
const safe = (session: string) => session.replace(/[^A-Za-z0-9_-]/g, '_')

/** The argv a socket spawns: tmux attached-or-created when tmux is on PATH, a login shell when it is not. */
export function shellArgv(socket: string, session: string, cwd: string): string[] {
  const tmux = Bun.which('tmux')
  if (!tmux) return [process.env.SHELL || '/bin/bash', '-l']
  return [tmux, '-L', socket, 'start-server', ';', 'set-option', '-s', 'default-terminal', 'tmux-256color', ';',
          'new-session', '-A', '-s', safe(session), '-c', cwd]
}

/** End a session's shell, if it has one — a shell left in a folder that is gone. Quiet when there is none or no tmux. */
export function endShell(socket: string, session: string): void {
  const tmux = Bun.which('tmux')
  if (tmux) Bun.spawnSync([tmux, '-L', socket, 'kill-session', '-t', safe(session)], { stdout: 'ignore', stderr: 'ignore' })
}

/** Mount a terminal socket at `path`. Throws when `refuse` names no check. */
export function terminalSocket(app: AppWs, path: string, opts: TerminalOptions): void {
  const refuse = opts?.refuse
  if (!refuse || (typeof refuse.upgrade !== 'function' && typeof refuse.open !== 'function'))
    throw new Error(`terminalSocket('${path}'): \`refuse\` must name an upgrade or an open check — a shell on this machine has no permissive default`)
  const socket = opts.socket || DEFAULT_SOCKET

  const handlers: WsHandlerSet = {
    async open(ctx) {
      const no = await refuse.open?.(ctx)
      if (no) return ctx.close(no.code, no.reason)
      const cwd = opts.cwd(ctx)
      // A UTF-8 character split across two reads must not become two U+FFFDs.
      const decoder = new TextDecoder()
      const proc = Bun.spawn(shellArgv(socket, opts.session(ctx), cwd), {
        cwd,
        env: { ...opts.env(ctx), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        terminal: {
          cols: clampCols(ctx.query.cols),
          rows: clampRows(ctx.query.rows),
          data(_t: unknown, bytes: Uint8Array) { ctx.send(decoder.decode(bytes, { stream: true })) },
        },
      } as Parameters<typeof Bun.spawn>[1]) as Pty
      ctx.locals.proc = proc
      proc.exited.then(code => ctx.close(1000, `exited ${code}`))
    },

    message(ctx, msg) {
      const proc = ctx.locals.proc as Pty | undefined
      if (!proc?.terminal) return
      let frame: { i?: unknown, r?: unknown }
      try { frame = JSON.parse(String(msg)) } catch { return }
      if (!frame || typeof frame !== 'object') return
      if (typeof frame.i === 'string') proc.terminal.write(frame.i)
      if (Array.isArray(frame.r)) proc.terminal.resize(clampCols(frame.r[0]), clampRows(frame.r[1]))
    },

    close(ctx) {
      // tmux: the client goes and the session stays for the next socket.
      ;(ctx.locals.proc as Pty | undefined)?.kill()
    },
  }

  app.ws(path, handlers, {
    // Typing and a held key are many small frames; the default 100/s would
    // close the socket under a key repeat.
    limits:  { maxFramesPerSecond: 0, maxInFlight: 0 },
    upgrade: req => {
      const no = refuse.upgrade?.(req)
      if (typeof no === 'string') return new Response(no, { status: 403 })
      if (no) return no
    },
  })
}
