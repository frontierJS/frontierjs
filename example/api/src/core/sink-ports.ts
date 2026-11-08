// Where the API and its sinks listen — one answer for every file that needs it.
//
// 8110 is dev/be/project-1, derived and never chosen (packages/cli/core/ports.js).
// A sink is the API's port plus its service digit: 8111 mail, 8112 psp, 8113 idp,
// 8114 stripe, 8119 push — and 7111–7119 beside a drive's 7110.
//
// Following the API port is the whole point. `fli dev` and `fli prove` hand a
// second checkout its port as FRONTIER_PORT_BE only; sinks left on their dev
// literals collide with the main checkout's API, and the lane's API exits on
// "port already answering" before its own port ever answers (`FJS-3236`).

/** `API_PORT` is what a drive sets for the API it starts; FRONTIER_PORT_BE is what `fli dev` hands a branch. */
export const API_PORT = Number(process.env.API_PORT ?? process.env.FRONTIER_PORT_BE ?? 8110)

/** A sink's port: its own variable when stated, otherwise the API's port plus `service`. */
export const sinkPort = (service: number, env: string): number =>
  Number(process.env[env] ?? API_PORT + service)
