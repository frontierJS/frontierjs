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

export const components = {
  Email:     new URL('./components/Email.mesa',     import.meta.url).pathname,
  Section:   new URL('./components/Section.mesa',   import.meta.url).pathname,
  Row:       new URL('./components/Row.mesa',        import.meta.url).pathname,
  TwoCol:    new URL('./components/TwoCol.mesa',     import.meta.url).pathname,
  Column:    new URL('./components/Column.mesa',     import.meta.url).pathname,
  Spacer:    new URL('./components/Spacer.mesa',     import.meta.url).pathname,
  Heading:   new URL('./components/Heading.mesa',    import.meta.url).pathname,
  Text:      new URL('./components/Text.mesa',       import.meta.url).pathname,
  Button:    new URL('./components/Button.mesa',     import.meta.url).pathname,
  Image:     new URL('./components/Image.mesa',      import.meta.url).pathname,
  Link:      new URL('./components/Link.mesa',       import.meta.url).pathname,
  Divider:   new URL('./components/Divider.mesa',    import.meta.url).pathname,
  Card:      new URL('./components/Card.mesa',       import.meta.url).pathname,
  KeyValue:  new URL('./components/KeyValue.mesa',   import.meta.url).pathname,
  DataTable: new URL('./components/DataTable.mesa',  import.meta.url).pathname,
  Stars:     new URL('./components/Stars.mesa',      import.meta.url).pathname,
  Avatar:    new URL('./components/Avatar.mesa',     import.meta.url).pathname,
  Review:    new URL('./components/Review.mesa',     import.meta.url).pathname,
  Contact:   new URL('./components/Contact.mesa',    import.meta.url).pathname,
  Address:   new URL('./components/Address.mesa',    import.meta.url).pathname,
  Header:    new URL('./components/Header.mesa',     import.meta.url).pathname,
  Footer:    new URL('./components/Footer.mesa',     import.meta.url).pathname,
}

export const COMPONENTS_DIR = new URL('./components', import.meta.url).pathname
export const TEMPLATES_DIR  = new URL('./templates',  import.meta.url).pathname
