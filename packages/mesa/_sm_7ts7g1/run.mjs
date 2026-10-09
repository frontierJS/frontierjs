
import { compileSource, readSourceMarks, stripSourceMarks } from "/home/j/code/FRONTIER/frontierjs/packages/mesa/src/compiler.js"
import { buildSourceMap } from "/home/j/code/FRONTIER/frontierjs/packages/mesa/src/sourcemap.js"
import { writeFileSync, readFileSync } from 'fs'
import { Window } from "/home/j/code/FRONTIER/frontierjs/packages/mesa/node_modules/happy-dom/lib/index.js"
const w = new Window()
global.document = w.document; global.window = w
for (const k of ['ShadowRoot','HTMLElement','Element','Node','Event','CustomEvent','MutationObserver','DocumentFragment','Text','Comment']) global[k] = w[k]
const { mount, flushSync } = await import("/home/j/code/FRONTIER/frontierjs/packages/mesa/src/runtime.js")
const file = "/home/j/code/FRONTIER/frontierjs/packages/mesa/_sm_7ts7g1/Widget.mesa"
const src = readFileSync(file, 'utf8')
const ctx = await compileSource(src, { filename: file, dev: false, sourceMarks: true })
let js = ctx.result.replace(/'@frontierjs\/mesa\/runtime\.js'/g, "'/home/j/code/FRONTIER/frontierjs/packages/mesa/src/runtime.js'")
const marks = readSourceMarks(js)
js = stripSourceMarks(js)
const map = buildSourceMap(src, js, file, marks)
if (!map) { console.log('NO_MAP'); process.exit(0) }
const b64 = Buffer.from(JSON.stringify(map)).toString('base64')
writeFileSync("/home/j/code/FRONTIER/frontierjs/packages/mesa/_sm_7ts7g1/W.mjs", js + '\n//# sourceMappingURL=data:application/json;base64,' + b64 + '\n')
const C = (await import('file://' + "/home/j/code/FRONTIER/frontierjs/packages/mesa/_sm_7ts7g1/W.mjs")).default
const wrap = document.createElement('div'); document.body.appendChild(wrap)
const l = document.createElement('span'); wrap.appendChild(l)
try { mount(l, C, { props: {} }); flushSync(); console.log('NO_THROW') }
catch (e) { console.log(e.stack) }
