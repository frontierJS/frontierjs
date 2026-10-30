// shared/carousel.ts
// Targets riding a loop on the shared clock — the archery range's carousel
// (`web/src/lib/scene/stage.js` draws it, `world.ts` says what a bolt hits). The riders
// go up one column, over the top under its housing, down the other and back
// round under the bottom one, so where each is is a function of the wall clock
// alone, as a pacer's is (`pacer.ts`), and no screen is told.

/** What a scene says of a carousel; `cells` are a rider's solid cells from its top-left. */
export interface CarouselSpec {
  name: string
  /** The column the riders go up, by its left edge, and how far right of it the column they come down. */
  x: number, apart: number
  /** The rows a rider shows in, both included; above and below them it is under a housing. */
  top: number, bottom: number
  /** ms a row, and how many ride, evenly spaced round the loop. */
  ms: number, n: number
  cells: [number, number][]
}

export interface Rider { id: string, x: number, y: number }

const sizeOf = (c: CarouselSpec) => ({
  w: Math.max(...c.cells.map(([dx]) => dx)) + 1,
  h: Math.max(...c.cells.map(([, dy]) => dy)) + 1,
})

/**
 * Every rider `ms` into the clock, by its top-left — a rider part under a
 * housing included, since its rings are scored on the whole of it. One leg is
 * the rows from wholly under the bottom housing to wholly under the top one.
 */
export function ridersAt (c: CarouselSpec, ms = 0): Rider[] {
  const { h } = sizeOf(c)
  const leg = c.bottom - c.top + h + 1
  const step = Math.floor(ms / c.ms)
  return Array.from({ length: c.n }, (_, i) => {
    const s = (step + Math.floor(i * 2 * leg / c.n)) % (2 * leg)
    return s < leg
      ? { id: `${c.name}#${i}`, x: c.x, y: c.bottom + 1 - s }
      : { id: `${c.name}#${i}`, x: c.x + c.apart, y: c.top - h + (s - leg) }
  })
}

/** A rider's solid cells on the stage, the hidden ones included. */
export const cellsOf = (c: CarouselSpec, r: Rider): [number, number][] =>
  c.cells.map(([dx, dy]) => [r.x + dx, r.y + dy])

/** Whether a cell is inside the carousel's lane: both columns and the gap between, between the housings. */
export function inLane (c: CarouselSpec, x: number, y: number): boolean {
  return y >= c.top && y <= c.bottom && x >= c.x && x < c.x + c.apart + sizeOf(c).w
}

/** The rider showing on a lane cell `ms` into the clock, or null where the lane is empty. */
export function riderOn (c: CarouselSpec, x: number, y: number, ms = 0): Rider | null {
  if (!inLane(c, x, y)) return null
  return ridersAt(c, ms).find(r => c.cells.some(([dx, dy]) => r.x + dx === x && r.y + dy === y)) ?? null
}
