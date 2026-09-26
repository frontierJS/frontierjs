/*
 * store.js — plain shared state, as VISION §5 writes it: an exported object and
 * nothing Mesa-aware. `Stored.mesa` reads it with no `$:`, which is the shape
 * the devtools panel marks static (`FJS-1340`).
 */
export const shelf = { count: 3 }
