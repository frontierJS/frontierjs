// shared/crier.ts
// The crier's name and how long a cry stays up, which `Crier.mesa` draws and
// `api/src/crier.ts` speaks. The server half (a Member who says the lines)
// stays in `api/`; this file imports nothing, so the client can import the nick
// without pulling junction into the bundle.

/** The crier's nick. `api/src/keyless.ts` lists it among the voices no login can be. */
export const CRIER = 'crier'

/** How long a cry stays over the square, in ms. */
export const CRY_MS = 8000
