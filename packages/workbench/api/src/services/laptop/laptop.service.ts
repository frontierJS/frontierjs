// src/services/laptop/laptop.service.ts
// What fli keeps on this laptop (`domain/laptop/laptop.ts`): its four roots and
// Workbench's own folder with sizes, and the verbs that give bytes back. No
// model: the files are the machine's, not this app's database.
//
// Gated at ADMINISTRATOR like the basecamps: a write deletes files. The client
// sends a catalog `name` or a lane number, never a path, and no file's contents
// leave here.
//
//   GET  /laptop         disk        every class (config, data, cache, state, workbench) with size, reclaimable and entries; the lanes; how long the walk took
//   POST /laptop         clear       { root, name } remove a cache entry fli rebuilds -> { freed }
//   POST /laptop         removeLane  { lane } remove an idle, clean lane -> { freed }
//   GET  /laptop         keys        every secret file with present/mode/owner/exposed, and the Frontier identity (names only) -> { keys, identity }
//   POST /laptop         fixMode     { label } chmod a listed secret to 600 (a directory 700) -> { label, mode }
//   GET  /laptop         globalEnv   the keys of ~/.config/fli/.env, values masked -> { path, keys }
//   POST /laptop         setGlobalEnv    { key, value } set one key through core/global-env.js -> { key }
//   POST /laptop         unsetGlobalEnv  { key } remove one key -> { key }
//   GET  /laptop         commands    the user's own fli commands -> [{ name, description, alias, filePath }]
//   GET  /laptop         ping        the ntfy topic Claude Code's Stop hook pings, from ~/.claude/ntfy-topic -> { path, topic, url }
//   POST /laptop         setPing     { topic } write it; empty removes the file and turns the ping off -> { path, topic, url }
//   GET  /laptop         services    every account fli signs in to: how, present or not (names only), setup pointer, vendor page, and the commands that use it
//   POST /laptop         probeService    { id } run that CLI service's login check -> { ok, who, ms }; the one verb that shells out, and only on a press
//   GET  /laptop         running     fli dev sessions with their ports and which answer, and the tree holds -> { sessions, holds }

import { createService, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS }                       from '@frontierjs/litestone'
import { disk, clear, removeLane }      from '../../domain/laptop/laptop.ts'
import { keys, fixMode }                from '../../domain/laptop/keys.ts'
import { globalEnv, setGlobalEnv, unsetGlobalEnv, commands } from '../../domain/laptop/settings.ts'
import { ping, setPing }                from '../../domain/laptop/ping.ts'
import { running }                      from '../../domain/laptop/running.ts'
import { servicesList, probeService }  from '../../domain/laptop/services.ts'

const READS  = ['disk', 'keys', 'globalEnv', 'commands', 'ping', 'running', 'services']
// probeService shells out to a CLI, so it is a write: a keyed retry must run it again.
const WRITES = ['clear', 'removeLane', 'fixMode', 'setGlobalEnv', 'unsetGlobalEnv', 'setPing', 'probeService']

export default createService({
  name: 'laptop',

  methods: [
    ...READS.map(method => ({ method, read: true, gate: LEVELS.ADMINISTRATOR })),
    ...WRITES.map(method => ({ method, gate: LEVELS.ADMINISTRATOR })),
  ],

  async disk() {
    return disk()
  },

  async clear() {
    const { root, name } = ($.data ?? {}) as { root?: unknown, name?: unknown }
    if (typeof root !== 'string' || typeof name !== 'string') throw new BadRequest('clear takes { root, name } as strings')
    const out = clear(root, name)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async keys() {
    return keys()
  },

  async fixMode() {
    const { label } = ($.data ?? {}) as { label?: unknown }
    if (typeof label !== 'string') throw new BadRequest('fixMode takes { label } as a string')
    const out = fixMode(label)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async globalEnv() {
    return globalEnv()
  },

  async setGlobalEnv() {
    const { key, value } = ($.data ?? {}) as { key?: unknown, value?: unknown }
    if (typeof key !== 'string' || typeof value !== 'string') throw new BadRequest('setGlobalEnv takes { key, value } as strings')
    const out = setGlobalEnv(key, value)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async unsetGlobalEnv() {
    const { key } = ($.data ?? {}) as { key?: unknown }
    if (typeof key !== 'string') throw new BadRequest('unsetGlobalEnv takes { key } as a string')
    const out = unsetGlobalEnv(key)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async commands() {
    return commands()
  },

  async ping() {
    return ping()
  },

  async setPing() {
    const { topic } = ($.data ?? {}) as { topic?: unknown }
    if (typeof topic !== 'string') throw new BadRequest('setPing takes { topic } as a string')
    const out = setPing(topic)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async running() {
    return running()
  },

  async services() {
    return servicesList()
  },

  async probeService() {
    const { id } = ($.data ?? {}) as { id?: unknown }
    if (typeof id !== 'string') throw new BadRequest('probeService takes { id } as a string')
    return probeService(id)
  },

  async removeLane() {
    const { lane } = ($.data ?? {}) as { lane?: unknown }
    if (typeof lane !== 'number' || !Number.isInteger(lane)) throw new BadRequest('removeLane takes { lane } as an integer')
    const out = await removeLane(lane)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

})
