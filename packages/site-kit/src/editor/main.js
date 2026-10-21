// src/editor/main.js — the entry `site-kit build --preview` emits as
// `assets/fjs-editor.js` when the build names an editor (SITE_EDITOR). Every page
// carries its tag, which names basecamp's page for this site's draft.
import { mount } from '@frontierjs/mesa/runtime'
import Editor from './Editor.mesa'
import { siteOf } from './handoff.js'

const tag = document.querySelector('script[data-fjs-editor]')
if (tag) {
  const anchor = document.createComment('fjs-editor')
  document.body.append(anchor)
  mount(anchor, Editor, { props: { site: siteOf(tag.dataset.fjsEditor) } })
}
