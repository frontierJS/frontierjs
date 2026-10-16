// src/core/workbench-shell.ts — which shell a pin's Terminal tab attaches to.
//
// One spelling of the tmux session, read by the socket that attaches to it
// (core/workbench-terminal.ts) and by Unpin and Archive, which end it: a shell
// left running in a worktree Archive removed sits in a folder that is gone.
//
// The tmux server is basecamp's own (`-L basecamp`): the operator's
// ~/.tmux.conf still applies, but the `default-terminal` set here does not
// reach their other sessions — and without it tmux hands the shell TERM=screen,
// eight colors. `tmux -L basecamp attach -t basecamp-<pin>` reaches the same
// shell from a real terminal.

const SOCKET = 'basecamp'

// tmux refuses `.` and `:` in a session name; a pin id is a slug, so this is
// a guard rather than a translation.
const sessionOf = (pinId: string) => `basecamp-${pinId.replace(/[^A-Za-z0-9_-]/g, '_')}`

/** The argv a Terminal socket spawns: tmux attached-or-created when tmux is
 *  on PATH, so the shell outlives the socket; a login shell when it is not. */
export function shellArgv(pinId: string, cwd: string): string[] {
  const tmux = Bun.which('tmux')
  if (!tmux) return [process.env.SHELL || '/bin/bash', '-l']
  return [tmux, '-L', SOCKET, 'start-server', ';', 'set-option', '-s', 'default-terminal', 'tmux-256color', ';',
          'new-session', '-A', '-s', sessionOf(pinId), '-c', cwd]
}

/** End a pin's shell, if it has one. Quiet when there is none or no tmux. */
export function endShell(pinId: string): void {
  const tmux = Bun.which('tmux')
  if (tmux) Bun.spawnSync([tmux, '-L', SOCKET, 'kill-session', '-t', sessionOf(pinId)], { stdout: 'ignore', stderr: 'ignore' })
}
