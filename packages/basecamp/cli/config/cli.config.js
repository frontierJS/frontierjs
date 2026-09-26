// cli/config/cli.config.js — what only this app knows about its own CLI.
//
// The rest is derived: the commands are `/mcp`'s tool list at the signed-in
// key's standing, and the hand-written ones are files under `cli/src/routes/`.

export default {
  // The program's name, and so where its profiles (`~/.config/basecamp/`) and
  // its command cache (`~/.cache/basecamp/`) live.
  name:         'basecamp',
  // `resolveWorkspaceId` (api/src/core/hooks.ts) reads the workspace off this
  // header. Without it every member is a bare sign-in and the list is almost
  // empty, which reads exactly like a broken key (`FJS-D399`).
  tenantHeader: 'x-workspace-id',
  // Where a first `login` goes when it is given no `--url`: the dev API.
  url:          'http://localhost:8120/mcp',
}
