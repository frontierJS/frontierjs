// editor/vite.config.js — the scene editor, served by `fli haven:scenes` (or
// `bun run scenes`) beside Haven the way Studio is served beside an app:
// a tool on this machine, never a Haven route, so no stranger is served it and
// the terminal never has to draw it.
//
// The page reads and writes the scene FILES through `/__scenes`, because a
// save is the file's own text with the edits spliced in (`source.js`) and only
// this server can write the tree. A save writes a scene file Vite is serving,
// so Vite swaps the editor onto the module as saved — a hot update, not a
// reload: the page's script runs again over the new module.
//
// 5507 is the global block's `havenScenes` (cli core/ports.js), beside
// Haven's API and browser Haven. A drive points `SCENES_DIR` at a copy of
// `scenes/` with `pieces/` and `components/` beside it, so a save it makes
// never touches the tree, and the page evaluates the copy — a save swaps it
// there too. `@/` is the surface's `src/` as it is for Haven's own build;
// under a copy it is the copy's parent, so a copied scene's `@/components/`
// and `@/pieces/` are the copy's.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { defineConfig } from 'vite'
import mesa from '@frontierjs/mesa/vite'

const HERE   = dirname(fileURLToPath(import.meta.url))
const PORT   = Number(process.env.PORT ?? 5507)
const SCENES = resolve(process.env.SCENES_DIR ?? join(HERE, '../web/src/scenes'))
const SRC    = dirname(SCENES)
const PIECES = join(SRC, 'pieces')

// A scene is a component, PascalCase; `.frame.txt` beside it is its picture.
// Any other name is refused rather than resolved, so a request cannot write
// outside the directory.
const SCENE_FILE = /^[A-Z][A-Za-z0-9]*\.mesa$/

// The scene components and piece modules the page evaluates (`modules.js`),
// from `SCENES` rather than a glob, which can only name a path written in the
// source.
const MODULES = 'virtual:haven-scenes'

function modulesOf(dir, keep) {
  return readdirSync(dir).filter(keep).sort().map((f) => JSON.stringify(join(dir, f)))
}

function scenesApi() {
  return {
    name: 'haven-scenes',
    resolveId: (id) => (id === MODULES ? `\0${MODULES}` : null),
    load(id) {
      if (id !== `\0${MODULES}`) return null
      const scenes = modulesOf(SCENES, (f) => SCENE_FILE.test(f))
      const pieces = modulesOf(PIECES, (f) => f.endsWith('.js') && f !== 'index.js')
      const imports = [...scenes, ...pieces].map((f, i) => `import * as m${i} from ${f}`)
      const table = (list, from) => `{ ${list.map((f, i) => `${f}: m${i + from}`).join(', ')} }`
      return `${imports.join('\n')}\nexport const sceneModules = ${table(scenes, 0)}\nexport const pieceModules = ${table(pieces, scenes.length)}\n`
    },
    configureServer(server) {
      server.middlewares.use('/__scenes', async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(body))
        }
        const file = decodeURIComponent((req.url ?? '/').slice(1).split('?')[0])
        try {
          if (req.method === 'GET' && file === '') {
            const files = readdirSync(SCENES).filter((f) => SCENE_FILE.test(f)).sort()
            return send(200, files.map((f) => ({ file: f, source: readFileSync(join(SCENES, f), 'utf8') })))
          }
          if (!SCENE_FILE.test(file)) return send(400, { error: `'${file}' is not a scene file name` })
          if (req.method === 'PUT') {
            let body = ''
            for await (const chunk of req) body += chunk
            writeFileSync(join(SCENES, file), body)
            return send(200, { file, bytes: Buffer.byteLength(body) })
          }
          return send(405, { error: `${req.method} is not answered here` })
        } catch (e) {
          send(500, { error: e.message })
        }
      })
    },
  }
}

export default defineConfig({
  root:    HERE,
  plugins: [mesa(), scenesApi()],
  resolve: { alias: { '@': SRC } },
  define:  { 'import.meta.env.HAVEN_WEATHER': JSON.stringify(process.env.HAVEN_WEATHER ?? null) },
  // The stage, the cell module and the components are the browser Haven's own
  // (`web/src/`), and the pieces and scenes beside them; all live above this
  // root, or in the copy a drive points at.
  server:  { port: PORT, strictPort: true, fs: { allow: [resolve(HERE, '..'), SRC] } },
})
