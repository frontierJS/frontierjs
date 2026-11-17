// src/services/capture/capture.service.ts
// Capture's settings (`domain/capture/config.ts`): the Rust screenshot tool's
// `~/.config/capture/config.toml`. No model: the file is Capture's, not this
// app's database.
//
// Gated at ADMINISTRATOR like the laptop: the file holds the share key, and a
// write changes what the tool uploads and where. The key never leaves -- a read
// carries `webKeySet` and a masked hint, and a write that omits `webKey` keeps it.
//
//   GET  /capture  config     every setting as Capture would load it (defaults for a missing file) -> ConfigView
//   POST /capture  setConfig  { ...fields } the named fields only; refused whole if any value is one Capture would refuse -> ConfigView
//   POST /capture  resetConfig  every setting to Capture's defaults, keeping the share URL and key -> ConfigView
//   POST /capture  connect    start a key hand-back from the share app (`domain/capture/connect.ts`) -> { url }
//   GET  /capture  test       ask the share app whose key the saved one is -> { ok, part, message, email? }

import { createService, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS }                       from '@frontierjs/litestone'
import { captureConfig, resetCaptureConfig, setCaptureConfig, type Patch } from '../../domain/capture/config.ts'
import { connecting, startConnect, testShare }                                from '../../domain/capture/connect.ts'

export default createService({
  name: 'capture',

  methods: [
    { method: 'config',    read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'setConfig',             gate: LEVELS.ADMINISTRATOR },
    { method: 'resetConfig',           gate: LEVELS.ADMINISTRATOR },
    { method: 'connect',               gate: LEVELS.ADMINISTRATOR },
    { method: 'test',      read: true, gate: LEVELS.ADMINISTRATOR },
  ],

  // `connecting` is the screen's cue to keep asking while the browser is away.
  async config() {
    return { ...captureConfig(), connecting: connecting() }
  },

  async setConfig() {
    const patch = $.data
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new BadRequest('setConfig takes an object of settings')
    const out = setCaptureConfig(patch as Patch)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async connect() {
    // The bound port, which is not 5501 under a drive.
    const out = startConnect({ port: ($.app as any).http?.port ?? null })
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async test() {
    return testShare()
  },

  async resetConfig() {
    const out = resetCaptureConfig()
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

})
