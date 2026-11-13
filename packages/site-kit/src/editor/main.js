// src/editor/main.js — the entry `site-kit build --preview` emits as
// `assets/fjs-editor.js` when the build names an editor (SITE_EDITOR). Every page
// carries its tag, which names basecamp's page for this site's draft.
//
// The editor renders in a shadow root carrying its own copy of the kit, so a
// site's stylesheet cannot reach it: in the page's DOM, ksite's surface color
// band read the panel's surface-body and turned its words white (FJS-4269). The
// host carries data-fjs-editor-ui because a page-level listener sees an event
// from inside the root as the host's.
import { mount } from '@frontierjs/mesa/runtime'
import kit from '@frontierjs/css?inline'
import Editor from './Editor.mesa'
import { siteOf } from './handoff.js'

// The host inherits the page's font, color and line-height; `all` resets them,
// and custom properties, which it leaves, the kit seals at :host.
const HOST = ':host { all: initial }'

function shadowFor() {
  const host = document.createElement('fjs-editor')
  host.setAttribute('data-fjs-editor-ui', '')
  document.body.append(host)
  const root = host.attachShadow({ mode: 'open' })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(`${kit}\n${HOST}`)
  root.adoptedStyleSheets = [sheet]
  return root
}

const tag = document.querySelector('script[data-fjs-editor]')
if (tag) {
  const root = shadowFor()
  const anchor = document.createComment('fjs-editor')
  root.append(anchor)
  mount(anchor, Editor, { root, props: { site: siteOf(tag.dataset.fjsEditor) } })
}
