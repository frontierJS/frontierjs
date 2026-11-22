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
//
// The files Capture wrote (`domain/capture/files.ts`), in the folder `config` names.
// A file is named by its basename alone; a slash, `..` or a link out of the folder is a 400.
// Open and Share run on THIS machine (`xdg-open`, `capture share`). The bytes for a tag are
// GET /capture-file/{name} (`captureFileRoute`), a raw route: a service answers JSON only.
//
//   GET  /capture  files     the media in save_dir, newest first, a call's or recording's transcript with it -> { dir, exists, files: [{ name, kind, mime, size, modifiedAt, transcript, sidecars }] }
//   POST /capture  open      { name } the file in the default program -> { opened }
//   POST /capture  reveal    { name } the file selected in the file manager, else its folder opened -> { revealed, how }
//   POST /capture  share     { name } `capture share <file>`: uploads it and copies the link on this machine -> { url }
//   POST /capture  removeFile { name } the file and its .txt/.vtt, deleted for good -> { removed: [name] }

import { createService, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS }                       from '@frontierjs/litestone'
import { captureConfig, resetCaptureConfig, setCaptureConfig, type Patch } from '../../domain/capture/config.ts'
import { connecting, startConnect, testShare }                                from '../../domain/capture/connect.ts'
import { captureFiles, openCaptureFile, removeCaptureFile, revealCaptureFile, shareCaptureFile } from '../../domain/capture/files.ts'

const nameOf = (data: unknown) => (typeof data === 'object' && data !== null ? (data as { name?: unknown }).name : undefined)

function answer<T extends object>(out: T | { refused: string }): T {
  if ('refused' in out) throw new BadRequest(out.refused)
  return out
}

export default createService({
  name: 'capture',

  methods: [
    { method: 'config',    read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'setConfig',             gate: LEVELS.ADMINISTRATOR },
    { method: 'resetConfig',           gate: LEVELS.ADMINISTRATOR },
    { method: 'connect',               gate: LEVELS.ADMINISTRATOR },
    { method: 'test',      read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'files',     read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'open',                  gate: LEVELS.ADMINISTRATOR },
    { method: 'reveal',                gate: LEVELS.ADMINISTRATOR },
    { method: 'share',                 gate: LEVELS.ADMINISTRATOR },
    { method: 'removeFile',            gate: LEVELS.ADMINISTRATOR },
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

  async files() {
    return captureFiles()
  },

  async open() {
    return answer(await openCaptureFile(nameOf($.data)))
  },

  async reveal() {
    return answer(await revealCaptureFile(nameOf($.data)))
  },

  // Refused up front when no share server is saved, so the page says so before a spawn does.
  async share() {
    if (!captureConfig().shareOn) throw new BadRequest('No share server is set up. Connect one in Capture settings first.')
    return answer(await shareCaptureFile(nameOf($.data)))
  },

  // Not `remove`: that is the CRUD verb, which the pipeline grades as a delete by id.
  async removeFile() {
    return answer(removeCaptureFile(nameOf($.data)))
  },

  async resetConfig() {
    const out = resetCaptureConfig()
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

})
