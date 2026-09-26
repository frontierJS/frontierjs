/*
 * devtools-cause — `__dev` answers *why did this update*, read back off the
 * graph that ran it (`FJS-1324`).
 *
 * A panel that lies about an edge is silent: it draws a plausible arrow and
 * nothing on the page disagrees. So this reads the answer back and compares it
 * to what the fixture's source says must be true — `doubled` reads `count`,
 * the render reads `doubled`, and the click is the only write that starts
 * anything. The second chain crosses a write an EFFECT made, which is the
 * shape a stuck binding usually has: the value is right one hop up and nobody
 * can see which hop broke.
 *
 * The fixture is mounted as a DEV build, since only a dev build registers
 * anything; the rest of this drive runs production output.
 */
export const name = 'devtools reads the cause of an update back'
export const covers = ['devtools-cause']

// The fixture's own component, its signal ids by name, and the graph of each.
const READ = `
  const dev = window.__MESA_DEV__;
  const snap = dev.snapshot();
  const comp = snap.components.filter((c) => c.name === 'devtools_cause').pop();
  const ids = {};
  for (const s of snap.signals) if (s.componentId === comp.id) ids[s.name] = s.id;
  const graph = {};
  for (const n in ids) graph[n] = dev.graph(ids[n]);
  return { comp: comp.id, ids, graph };
`

export async function run(t) {
  await t.mount('devtools-cause', {}, { dev: true })

  const { comp, ids, graph } = await t.evaluate(READ)
  t.is(Object.keys(ids).sort().join(','), 'count,doubled,seen', 'the dev build registered all three')

  t.is(graph.doubled.dependencies.map((d) => d.name).join(','), 'count',
    'a derivation lists what it reads, off its own _deps')
  t.is(graph.count.dependencies.length, 0, 'and a plain let reads nothing')

  const countSubs = graph.count.dependents
  t.is(countSubs.length === 1 && countSubs[0].kind === 'derived' && countSubs[0].name === 'doubled', true,
    'count has one dependent, and it is the doubled derivation')

  const kinds = graph.doubled.dependents.map((d) => d.kind).sort().join(',')
  t.is(kinds, 'block,effect', 'doubled is read by the render and by the $: block')
  const render = graph.doubled.dependents.find((d) => d.kind === 'block')
  t.is(render.componentId, comp, 'and each node names the component it lives in')
  t.is(graph.seen.dependents.some((d) => d.nodeId === render.nodeId), true,
    'the same render reads seen, and it is the same node id from both sides')

  const before = await t.evaluate(`return window.__MESA_DEV__._runs.length;`)

  await t.clickAt('#bump')
  await t.eventually(`document.querySelector('#doubled').textContent`, '2', 'the derivation rendered')
  await t.eventually(`document.querySelector('#seen').textContent`, '2', 'and the effect wrote seen')

  const runs = await t.evaluate(
    `return { v: window.__MESA_DEV__._runs.slice(${before}).filter((r) => r.nodeId === ${render.nodeId}) };`
  ).then((r) => r.v)
  const chains = runs.map((r) => r.cause.map((c) => c.write ? `write ${c.name}=${c.value}` : `${c.kind} ${c.name ?? ''}`.trim()))

  t.is(chains.some((c) => c.join(' <- ') === 'derived doubled <- write count=1'), true,
    'one run of the render names its cause: doubled, woken by the write to count')
  t.is(chains.some((c) => c.join(' <- ') === 'write seen=2 <- effect <- derived doubled <- write count=1'), true,
    'and one names the chain through the effect that wrote seen, back to the same click')

  const why = await t.evaluate(`return window.__MESA_DEV__.why(${render.nodeId});`)
  t.is(why?.nodeId, render.nodeId, 'why() answers that node\'s latest run')

  const log = await t.evaluate(`return { v: window.__MESA_DEV__._log.slice(-2) };`).then((r) => r.v)
  const countWrite = log.find((e) => e.name === 'count')
  t.is(countWrite?.woke.map((n) => n.name).join(','), 'doubled',
    'the write to count lists what it woke, read off its _subs as it notified them')
  t.is(log.find((e) => e.name === 'seen')?.by?.kind, 'effect',
    'and the write to seen says an effect made it')

  const pending = await t.evaluate(`return window.__MESA_DEV__.graph(${ids.count}).dependents[0].pending;`)
  t.is(pending, false, 'nothing is left pending once the flush has settled')
}
