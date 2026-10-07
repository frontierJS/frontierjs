// web/test/lib/session.mjs — the URL a drive imports the session from, in-page.
//
// The screens import `@frontierjs/sierra/junction`, and a page cannot resolve
// a bare specifier, so a drive names the file Vite serves for it. It has to be
// that exact URL: any other spelling of the same file is a second module
// instance, a second `session` object, and a sign-in the screens never see.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const SESSION_MODULE = '/@fs' + join(HERE, '../../../../packages/sierra/src/junction/index.js')
