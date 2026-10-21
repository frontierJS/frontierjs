// config/editor.js — the owner's editor in a draft's preview (`FJS-D1225`,
// `FJS-D1358`). Only `site-kit build --preview` with an editor URL adds it, so a
// release never carries it: production refuses a stamped dist anyway
// (`FJS-D1221`), and the editor rides on the stamped build.
//
// The entry is emitted under a fixed name, `assets/fjs-editor.js`, because the
// tag that loads it is written into Sierra's document before the bundle
// exists. Under `assets/`, because Sierra's prune keeps only the chunks a page
// names there and what they import; anywhere else its shared chunk is deleted.
// An unhashed name is revalidated on every view, which a preview can afford.
// It also states `build.minify` (`editorBuild`): with every route static Sierra
// skips minifying a bundle it expects no page to reach, and refuses one that is.

import { fileURLToPath } from 'node:url'

const ENTRY = 'virtual:site-kit/editor'
const FILE  = 'assets/fjs-editor.js'
const MAIN  = fileURLToPath(new URL('../src/editor/main.js', import.meta.url))

const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * The editor's script tag, for `document.bodyEnd`, or '' with no editor.
 * @param {string | undefined} editor — basecamp's page for this site's draft
 * @param {string} [base]
 */
export function editorTag(editor, base = '/') {
  if (!editor) return ''
  if (!/^https?:\/\//.test(editor)) throw new Error(`[site-kit] the editor is basecamp's page for this draft, an http(s) address — got ${JSON.stringify(editor)}`)
  return `<script type="module" src="${attr(base.replace(/\/$/, '') + '/' + FILE)}" data-fjs-editor="${attr(editor)}"></script>`
}

/** @returns {import('vite').Plugin} */
export function siteEditor() {
  return {
    name: 'site-kit:editor',
    apply: 'build',
    resolveId(id) { if (id === ENTRY) return MAIN },
    buildStart() { this.emitFile({ type: 'chunk', id: ENTRY, fileName: FILE }) },
  }
}

/** What the build states when it carries the editor: its chunks ship, so they are minified. */
export const editorBuild = (build = {}) => ({ ...build, minify: build.minify ?? true })
