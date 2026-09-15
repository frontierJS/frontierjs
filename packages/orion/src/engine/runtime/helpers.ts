import type { ExecutionContext, ExecutionRecord } from "./context"

// ─────────────────────────────────────────────
// BUILD RECORD
// Converts a completed ExecutionContext into an immutable ExecutionRecord.
// ─────────────────────────────────────────────

const SLOW_NODE_THRESHOLD_MS = 1000

export function buildRecord(ctx: ExecutionContext): ExecutionRecord {
  const nodeTimings: Record<string, number> = {}
  const slowNodes:   string[] = []

  for (const [id, state] of Object.entries(ctx.nodeStates)) {
    if (state.startedAt && state.endedAt) {
      const ms = state.endedAt - state.startedAt
      nodeTimings[id] = ms
      if (ms > SLOW_NODE_THRESHOLD_MS) slowNodes.push(id)
    }
  }

  return {
    executionId:  ctx.executionId,
    flowId:       ctx.flowId,
    version:      ctx.version,
    status:       ctx.status,
    trigger:      ctx.trigger,
    startedAt:    ctx.startedAt,
    endedAt:      ctx.endedAt ?? Date.now(),
    durationMs:   (ctx.endedAt ?? Date.now()) - ctx.startedAt,
    nodeStates:   ctx.nodeStates,
    nodeTimings,
    slowNodes,
    error:        ctx.error,
    finalContext: { ...ctx.nodes },
  }
}
