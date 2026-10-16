import { cases } from './cases.mjs'
const s = await cases[1].open()
const svc = s.app.service('items')
const t = async (label, fn, n = 5000) => {
  for (let i = 0; i < n/10; i++) await fn(i)
  const t0 = performance.now(); for (let i = 0; i < n; i++) await fn(i)
  console.log(label.padEnd(24), ((performance.now() - t0) / n * 1000).toFixed(1), 'µs')
}
for (let k = 0; k < 2; k++) {
await t('litestone findUnique', i => s.app.db?.item?.findUnique?.({ where: { id: (i % 1000) + 1 } }) ?? null)
await t('service get (internal)', i => svc.get((i % 1000) + 1))
await t('http get', i => s.app.http.fetch(new Request('http://localhost/items/' + ((i % 1000) + 1))).then(r => r.text()))
await t('http ping', i => s.app.http.fetch(new Request('http://localhost/ping')).then(r => r.text()))
await t('new Request+URL only', i => new URL(new Request('http://localhost/ping').url))
}
await s.close()
