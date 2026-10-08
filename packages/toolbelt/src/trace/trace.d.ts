/*
 * trace.d.ts — the kit's types, hand-written.
 *
 * Junction and conduit are TypeScript and both read this kit, so it needs a
 * declaration or it is a TS7016 in their builds.
 */

/** A parsed `traceparent`: the trace, the caller's span, and the sampled flag. */
export interface Traceparent {
  trace_id:  string
  parent_id: string
  sampled:   boolean
}

/** The header read, or null where it is absent or malformed. */
export function parseTraceparent(header: string | undefined | null): Traceparent | null
