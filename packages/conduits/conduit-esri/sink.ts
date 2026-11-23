// sink.ts — Esri World Imagery and USGS NAIP, standing in for both. One server,
// the two real tile paths (`/arcgis/rest/services/<service>/MapServer/tile/z/y/x`).
// Esri's path takes `?token=`; a wrong or absent token answers a 200 whose body
// is `{ error: { code: 498 | 499 } }`, as ArcGIS REST does. NAIP takes no key.
// Tiles at (z=3, y=2, x=1) are a PNG and (z=4, y=5, x=6) a JPEG, byte patterns
// that survive only a body passed through untouched; every other tile is a 404.
// Chaos: `{ json200 }` (a 200 JSON body where a tile should be), `{ markup200 }`,
// `{ unauthorized }` (a 401), `{ failNext }` (a 500), `{ echoKey }` (a vendor body
// that quotes the request URL, token and all, on a 404).

export interface EsriSinkOptions { port?: number; key?: string }

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 256 }, (_, i) => i), 0xff, 0x00, 0xfe])
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 256 }, (_, i) => 255 - i), 0xff, 0xd9])

export function startEsriSink(opts: EsriSinkOptions = {}) {
  const KEY = opts.key ?? 'AAPK_dev'
  const seen: { path: string; query: string; headers: Record<string, string> }[] = []
  const armed = { json200: false, markup200: false, unauthorized: false, failNext: false, echoKey: false }
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/_sink/seen')  return Response.json({ requests: seen })
      if (url.pathname === '/_sink/reset') { seen.length = 0; Object.assign(armed, { json200: false, markup200: false, unauthorized: false, failNext: false, echoKey: false }); return Response.json({ ok: true }) }
      if (url.pathname === '/_sink/arm')   { Object.assign(armed, await req.json()); return Response.json({ ok: true }) }
      seen.push({ path: url.pathname, query: url.search, headers: Object.fromEntries(req.headers) })

      const m = /^\/arcgis\/rest\/services\/(World_Imagery|USGSImageryOnly)\/MapServer\/tile\/(\d+)\/(\d+)\/(\d+)$/.exec(url.pathname)
      if (!m) return new Response('<html>Error: Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } })
      const [, service, z, y, x] = m
      if (service === 'World_Imagery') {
        const token = url.searchParams.get('token')
        if (!token) return json({ error: { code: 499, message: 'Token Required', details: [] } })
        if (token !== KEY) return json({ error: { code: 498, message: 'Invalid token.', details: [] } })
      }
      if (armed.unauthorized) return json({ error: 'nope' }, 401)
      if (armed.failNext) { armed.failNext = false; return json({ error: 'internal' }, 500) }
      if (armed.json200) return json({ error: { code: 400, message: 'Unable to complete operation.', details: [] } })
      if (armed.markup200) return new Response('<html><body>sign in</body></html>', { headers: { 'content-type': 'text/html' } })
      if (z === '3' && y === '2' && x === '1') return new Response(PNG, { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400', etag: '"png1"' } })
      if (z === '4' && y === '5' && x === '6') return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })
      if (armed.echoKey) return new Response(`Error: Not Found ${url.pathname}${url.search}`, { status: 404, headers: { 'content-type': 'text/plain' } })
      return new Response('<html>Error: Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } })
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, key: KEY, stop() { server.stop(true) } }
}
if (import.meta.main) console.log(`[esri-sink] ${startEsriSink({ port: Number(process.env.ESRI_SINK_PORT ?? 0) }).url}`)
