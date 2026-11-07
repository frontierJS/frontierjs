// src/services/servers/servers.service.ts
// The Servers screen (`domain/servers/servers.ts`): the machines this laptop's
// provider accounts list, live, beside its ssh hosts. No model of its own --
// the machines are the provider's -- and the one stored thing, a
// ProviderAccount, is written here through `asSystem()` once its token verified.
//
// Gated at ADMINISTRATOR like laptop: a write stores a credential. No answer
// carries a token; a member's read of ProviderAccount redacts it anyway.
//
//   GET  /servers  list    -> { fetchedAt, accounts: [{ id, label, provider, machines, error }], sshHosts }
//   POST /servers  add     { label, provider, token } verify with the provider, then store -> { id, label, provider, createdAt }
//   POST /servers  remove  id -> { id }

import { createService, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS }                       from '@frontierjs/litestone'
import { listServers, addAccount, removeAccount } from '../../domain/servers/servers.ts'

const db = (): any => $.db

export default createService({
  name: 'servers',

  methods: [
    { method: 'list',   read: true, gate: LEVELS.ADMINISTRATOR },
    // add calls the provider's verify, so a keyed retry must run it again.
    { method: 'add',    gate: LEVELS.ADMINISTRATOR },
    { method: 'remove', gate: LEVELS.ADMINISTRATOR },
  ],

  async list() {
    return listServers(db(), { sendFor: $.app.servers.sendFor })
  },

  async add() {
    const { label, provider, token } = ($.data ?? {}) as { label?: unknown, provider?: unknown, token?: unknown }
    const out = await addAccount(db(), { label, provider, token }, { sendFor: $.app.servers.sendFor })
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async remove() {
    const id = Number($.id)
    if (!Number.isInteger(id) || id < 1) throw new BadRequest('remove takes an account id')
    const out = await removeAccount(db(), id)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },
})
