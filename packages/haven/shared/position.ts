// shared/position.ts
// A cell on a scene. The art is the client's, so the server bounds the
// coordinates and nothing finer (`MAX_CELL`, `api/src/rooms.ts`). Here rather
// than in `rooms.ts` because `facing`, `bolt`, `memory` and `hearing` name it
// and run on both sides, and shared code imports nothing from `api/`.

export type Position = { x: number, y: number }
