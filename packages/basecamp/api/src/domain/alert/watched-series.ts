// src/domain/alert/watched-series.ts — which series a workspace's rule may read.
//
// `MetricSeries` is `@@tenant(none)`: one table holds the hub's own process
// readings and every workspace's per-machine ones, told apart only by their
// labels. A rule names its series by `labelsKey`, a string its author types, so
// a lookup by that alone reads another workspace's machine (`FJS-3594`). Both
// readers are `asSystem()` — the evaluator is a cron with no principal — so no
// row policy can make this check, and it lives here for both of them.
//
// A label that names a row must name one in the rule's workspace. A label not
// in `OWNERS` refuses: a new labelled writer is unreadable by any rule until its
// owner is added, rather than readable by every workspace. A series with no
// labels is the hub's own process, a shared fact.
//
// A refused series answers as a missing one does, so a rule cannot be used to
// learn that another workspace's machine exists.

/** The label → the model whose row it names. Each carries `workspaceId`. */
const OWNERS: Record<string, string> = {
  serverId:  'server',
  monitorId: 'monitor',
}

/** The series `metricName` names, or null when there is none this workspace may read.
 *  `sys` is the system client: the metric models are `@@gate(8)`. */
export async function watchedSeries(sys: any, metricName: string, workspaceId: string) {
  const series = await sys.metricSeries.findFirst({ where: { labelsKey: metricName } })
  if (!series) return null

  for (const [label, value] of Object.entries((series.labels ?? {}) as Record<string, unknown>)) {
    const model = OWNERS[label]
    if (!model) return null
    if (!await sys[model].exists({ where: { id: String(value), workspaceId } })) return null
  }
  return series
}
