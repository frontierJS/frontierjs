/*
 * report.js — the Outpost's outbound half: what this machine tells Basecamp.
 *
 * Three calls, and they are exactly the three endpoints `FJS-349` found taking
 * no credential at all. Each is signed with the fleet secret, over the exact
 * bytes sent, by the same module basecamp verifies with — one definition, two
 * ends.
 *
 * PUSH rather than poll, on two clocks: the heartbeat is small and frequent
 * because `lastHeartbeatAt` is how basecamp decides a machine is reachable, and
 * the disk picture is expensive and slow-moving, so asking for it every thirty
 * seconds would spend the machine's IO on an answer nobody reads between
 * deploys.
 *
 * The FIRST heartbeat is the one that matters: it carries `outpost_url`, which
 * is what registers this machine as a Conduit target. Until it lands, every
 * command basecamp wants to send has nowhere to go — which is the state
 * `resolveExecutor` refuses a release in.
 */

import { signRequest } from '@frontierjs/toolbelt/signature'
import { createVitals } from './vitals.js'

export function createReporter(config, {
  inspector,
  fetch: doFetch = fetch,
  log            = console,
  vitals         = createVitals(),
} = {}) {

  /**
   * One signed POST. Every call below goes through it, because the signature is
   * over the BYTES: building the payload twice — once to sign, once to send —
   * is how the two drift by a key order and every request 401s.
   *
   * The method rides in `X-Service-Method`; junction answers 404 for
   * `/servers/:id/heartbeat`, which is a path nobody registered.
   */
  async function post(path, serviceMethod, body) {
    const payload = JSON.stringify(body)
    const res = await doFetch(`${config.basecampUrl}${path}`, {
      method:  'POST',
      headers: {
        'content-type':     'application/json',
        accept:             'application/json',
        'x-service-method': serviceMethod,
        ...(await signRequest({
        // `path` carries its own query when it has one, which `signRequest`
        // splits — one canonical string whether a caller holds them apart or
        // joined (`FJS-678`).
        secret: config.secret, method: 'POST', path, body: payload,
        timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
      })),
      },
      body: payload,
    })
    if (!res.ok) throw new Error(`${serviceMethod} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`)
    return res.json().catch(() => null)
  }

  /** What the machine feels like. `vitals` remembers the previous CPU sample —
   *  `/proc/stat` is cumulative, so a percentage is a delta and this reader has
   *  to live as long as the process does. */
  const health = () => vitals.read()

  return {
    async heartbeat() {
      return post(`/servers/${config.serverId}`, 'heartbeat', {
        outpost_version: config.version,
        outpost_url:     config.publicUrl,
        health:          await health(),
      })
    },

    async reportVolumes() {
      return post('/volumes', 'report', { server_id: config.serverId, volumes: await inspector.volumes() })
    },

    async reportDisk() {
      return post('/cleanup', 'report', { server_id: config.serverId, ...(await inspector.disk()) })
    },

    /** Both timers. Every tick is caught and logged rather than thrown: a
     *  control plane that is down for a minute must not take the Outpost with
     *  it — the machine still has containers to run, and the next tick is the
     *  recovery. */
    start() {
      const tick = (what, fn) => fn().catch(err => log.warn?.(`outpost: ${what} — ${err.message}`))

      tick('first heartbeat', () => this.heartbeat())
      tick('first report', async () => { await this.reportVolumes(); await this.reportDisk() })

      const beat = setInterval(() => tick('heartbeat', () => this.heartbeat()), config.heartbeatMs)
      const rep  = setInterval(() => tick('report', async () => {
        await this.reportVolumes()
        await this.reportDisk()
      }), config.reportMs)

      return () => { clearInterval(beat); clearInterval(rep) }
    },
  }
}
