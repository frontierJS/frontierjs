/**
 * @frontierjs/email-kit
 *
 * Mesa email component kit.
 * Table-based, CSS-inlined, Outlook-safe email components.
 *
 * Usage:
 *   // In a .mesa template
 *   import Email    from '@frontierjs/email-kit/components/Email.mesa'
 *   import Section  from '@frontierjs/email-kit/components/Section.mesa'
 *   import Button   from '@frontierjs/email-kit/components/Button.mesa'
 *
 *   // Server-side rendering
 *   import { renderEmail, renderEmailFile } from '@frontierjs/email-kit/render'
 */

// Component paths — for use as import references in Mesa templates.
// The actual .mesa files are in ./components/*.mesa
//
// Not `new URL(...).pathname`: on Windows the pathname of a file URL keeps a
// leading slash before the drive letter (`/C:/…`), which is not a path any fs
// call accepts.
//
// And not `fileURLToPath(new URL(rel, import.meta.url))` either, which is the
// obvious replacement and throws *The URL must be of scheme file* under this
// package's vitest environment: happy-dom installs its own global `URL`, and
// `fileURLToPath` rejects an instance of it. It takes a STRING, so the one
// spelling that is correct on every platform and in both environments is to
// resolve the directory once from `import.meta.url` and join.
import path              from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const here = (rel) => path.join(__dirname, rel)

export const components = {
  Email:     here('components/Email.mesa'),
  Section:   here('components/Section.mesa'),
  Row:       here('components/Row.mesa'),
  TwoCol:    here('components/TwoCol.mesa'),
  Column:    here('components/Column.mesa'),
  Spacer:    here('components/Spacer.mesa'),
  Heading:   here('components/Heading.mesa'),
  Text:      here('components/Text.mesa'),
  Button:    here('components/Button.mesa'),
  Image:     here('components/Image.mesa'),
  Link:      here('components/Link.mesa'),
  Divider:   here('components/Divider.mesa'),
  Card:      here('components/Card.mesa'),
  KeyValue:  here('components/KeyValue.mesa'),
  DataTable: here('components/DataTable.mesa'),
  Stars:     here('components/Stars.mesa'),
  Avatar:    here('components/Avatar.mesa'),
  Review:    here('components/Review.mesa'),
  Contact:   here('components/Contact.mesa'),
  Address:   here('components/Address.mesa'),
  Header:    here('components/Header.mesa'),
  Footer:    here('components/Footer.mesa'),
}

export const COMPONENTS_DIR = here('./components')
export const TEMPLATES_DIR  = here('./templates')
