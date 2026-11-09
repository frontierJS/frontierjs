// A fixed port is shared with every other drive, bench and parallel lane, and
// anything answering it 200s the readiness poll: the drive then reports on the
// wrong process. The OS names a port nothing holds.
import { createServer } from 'node:net'

// Every listener stays open until all n are named, so two names never repeat.
export async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, () => resolve(s))
  })))
  const ports = servers.map(s => s.address().port)
  await Promise.all(servers.map(s => new Promise(r => s.close(r))))
  return ports
}

export const freePort = async () => (await freePorts(1))[0]
