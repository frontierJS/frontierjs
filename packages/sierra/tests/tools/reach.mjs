// Which built chunks can a visitor actually reach? Roots are what the
// prerendered HTML references; edges are any chunk filename appearing inside a
// chunk (Vite's dynamic-import map is plain string literals).
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
const DIR = process.argv[2]
const A = join(DIR, 'assets')
const all = readdirSync(A).filter(f => f.endsWith('.js'))
const roots = new Set()
const htmls = []
;(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(d, e.name))
    else if (e.name.endsWith('.html')) htmls.push(join(d, e.name))
  }
})(DIR)
for (const h of htmls) {
  const html = readFileSync(h, 'utf8')
  for (const m of html.matchAll(/[A-Za-z0-9_.-]+\.js/g)) if (all.includes(m[0])) roots.add(m[0])
}
const seen = new Set(); const q = [...roots]
while (q.length) {
  const f = q.pop(); if (seen.has(f)) continue; seen.add(f)
  const src = readFileSync(join(A, f), 'utf8')
  for (const m of src.matchAll(/[A-Za-z0-9_.-]+\.js/g))
    if (all.includes(m[0]) && !seen.has(m[0])) q.push(m[0])
}
const kb = f => statSync(join(A, f)).size / 1024
const dead = all.filter(f => !seen.has(f))
const sum = list => list.reduce((n, f) => n + kb(f), 0).toFixed(0)
console.log('roots in HTML :', [...roots].join(', ') || '(none)')
console.log(`reachable     : ${seen.size} files, ${sum([...seen])} KB`)
console.log(`UNREACHABLE   : ${dead.length} files, ${sum(dead)} KB`)
for (const f of dead) console.log('   ', f, kb(f).toFixed(1) + ' KB')
