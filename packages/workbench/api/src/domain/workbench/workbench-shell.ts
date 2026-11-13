// src/domain/workbench/workbench-shell.ts — which shell a Terminal socket attaches to.
//
// One spelling of the tmux session, read by the socket that attaches to it
// (plugins/workbench-terminal.ts) and by Unpin and Archive, which end it: a shell
// left running in a worktree Archive removed sits in a folder that is gone.
// `tmux -L workbench attach -t workbench-<pin>` reaches the same shell from a
// real terminal.

import { endShell as end } from '@frontierjs/junction/terminal'

/** Workbench's own tmux server, so its sessions are not the operator's. */
export const SOCKET = 'workbench'

// The /terminal/ page's shell belongs to no pin and takes the bare name,
// which no `workbench-<pin>` can collide with.
export const sessionOf = (pinId: string | null) => pinId ? `workbench-${pinId}` : SOCKET

/** End a pin's shell, if it has one. Quiet when there is none or no tmux. */
export function endShell(pinId: string): void {
  end(SOCKET, sessionOf(pinId))
}
