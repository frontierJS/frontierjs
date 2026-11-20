// src/domain/local/lathe.ts — open a folder in Lathe, the owner's editor, on this machine.
//
// The workbench's Open and the prototypes page's Open both land here, so a
// prototype opens without being pinned first.

import { spawn }      from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir }    from 'node:os'
import { join }       from 'node:path'

// The API may run without ~/.local/bin on its PATH, where Lathe's installer
// writes its launcher, so a bare `lathe` lookup alone would refuse a laptop
// that has it.
export function latheBin(): string | null {
  const local = join(homedir(), '.local', 'bin', 'lathe')
  return Bun.which('lathe') ?? (existsSync(local) ? local : null)
}

/** Opens `path` in a detached Lathe, or says why it cannot. */
export function openInLathe(path: string): { opened: string } | { refused: string } {
  const bin = latheBin()
  if (!bin) return { refused: 'lathe is not on PATH — install it with desktop/deploy/install.mjs' }
  // An 'error' event with no listener throws on the API's own loop.
  const child = spawn(bin, [path], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
  return { opened: path }
}
