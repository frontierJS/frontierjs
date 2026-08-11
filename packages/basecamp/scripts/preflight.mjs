// scripts/preflight.mjs — run before `bun run dev`.
//
// Both dev servers fail badly rather than loudly when their port is taken:
//
//   • `bun --watch` prints EADDRINUSE and then KEEPS WATCHING, so the process
//     stays alive and any wrapper waiting on it waits forever.
//   • Vite used to hop to the next free port; strictPort in the vite config
//     stops that, but only after you have already been confused once.
//
// The worst version of this is a stale server from an earlier run: it still
// owns the port AND still holds the old database open — including one that was
// deleted, since an unlinked SQLite file lives on while a handle is open. The
// new server never starts, every request is answered by the ghost, and
// `db:reset` looks like it did nothing. That happened; this exists so it does
// not happen twice.

import net from 'node:net'

const PORTS = [
  { port: 8120, who: 'API   (bun run api)' },
  { port: 8020, who: 'web   (bun run web)' },
]

function check({ port, who }) {
  return new Promise(resolve => {
    const probe = net.createServer()
    probe.once('error', err => resolve(err.code === 'EADDRINUSE' ? { port, who } : null))
    probe.once('listening', () => probe.close(() => resolve(null)))
    // 0.0.0.0, matching what the API binds — a listener on 127.0.0.1 alone
    // would not collide with one bound to the wildcard address and vice versa.
    probe.listen(port, '0.0.0.0')
  })
}

const taken = (await Promise.all(PORTS.map(check))).filter(Boolean)

if (taken.length) {
  console.error('\n  Port already in use:\n')
  for (const t of taken) console.error(`    ${t.port}  ${t.who}`)
  console.error('\n  Most likely a dev server from an earlier run. Stop it with:\n')
  console.error('    bun run stop\n')
  console.error('  A stale API also holds the old database open, so `bun run db:reset`')
  console.error('  will appear to do nothing while it is still running.\n')
  process.exit(1)
}
