// src/walk-in.js — this client walking into one room, on either target.
//
// The token is `#sign-in`'s answer: a terminal's is the one `fli haven` handed
// over as HAVEN_TOKEN, a browser's is a login it signs itself. Without one the
// socket is anonymous, and presence tracks no anonymous connection, so the
// room would show nobody, this figure included — so a missing one throws, and
// the route says why on the screen rather than drawing an empty room.
//
// The server joins a socket to the room its upgrade names (`/ws?room=`), and a
// service call cannot move it (`FJS-2834`), so a door is the socket cycled
// with another query. The query is set BEFORE the token: a client with no
// socket yet then opens one, asking for this room, rather than opening one for
// the square and cycling it straight away.
import { getClient } from '@frontierjs/sierra/resource'
import { sessionToken } from '#sign-in'

/** Ask the socket for this room and adopt this client's session. Throws, saying why, when there is none. */
export async function walkIn(slug) {
  const client = getClient()
  if (!client) throw new Error('Nobody walked in: this build names no Haven server.')
  const token = await sessionToken()
  client.setSocketQuery({ room: slug })
  if (client.token !== token) client.setToken(token)
}
