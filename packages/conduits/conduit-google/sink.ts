// sink.ts -- the Google sink: every module's stand-in on ONE listener.
//
// Each module lives in `sink/<module>.ts` as a `ModuleSink` that answers the
// paths it owns and returns null for the rest, so the drive registers every
// target against one port. Control endpoints are per module -- `/maps/_sink/*`,
// `/fcm/_sink/*` -- because the two arm different chaos with colliding names
// (`rateLimit`, `failNext`, `lost`); `/_sink/reset` clears them all.

import { mapsSink, type ModuleSink } from './sink/maps.ts'
import { fcmSink } from './sink/fcm.ts'

export { KNOWN_PLACES } from './sink/maps.ts'

export interface GoogleSinkOptions {
  port?:      number
  /** The one key the Maps APIs accept. */
  key?:       string
  /** The Firebase project the FCM module answers for. */
  projectId?: string
}

export function startGoogleSink(opts: GoogleSinkOptions = {}) {
  const maps = mapsSink({ key: opts.key })
  const fcm  = fcmSink({ projectId: opts.projectId })
  const modules: ModuleSink[] = [maps, fcm]

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      if (new URL(req.url).pathname === '/_sink/reset') { for (const m of modules) m.reset(); return Response.json({ ok: true }) }
      for (const m of modules) {
        const answer = await m.handle(req)
        if (answer) return answer
      }
      return Response.json({ error: { code: 404, message: `Method not found: ${req.method} ${new URL(req.url).pathname}`, status: 'NOT_FOUND', details: [] } }, { status: 404 })
    },
  })

  const url      = `http://127.0.0.1:${server.port}`
  const tokenUrl = `${url}/token`
  fcm.setTokenUrl(tokenUrl)

  return {
    port: server.port,
    url,
    /** Control for one module: `control(sink.maps)`, `control(sink.fcm)`. */
    maps: `${url}/maps`,
    fcm:  `${url}/fcm`,
    tokenUrl,
    serviceAccount: fcm.serviceAccount(),
    projectId:      fcm.projectId,
    stop() { for (const m of modules) m.stop(); server.stop(true) },
  }
}

if (import.meta.main) {
  const s = startGoogleSink({ port: Number(process.env.GOOGLE_SINK_PORT ?? 0) })
  console.log(`[google-sink] ${s.url}`)
}
