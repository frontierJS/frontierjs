# @frontierjs/email-kit

Email component kit for Mesa. Table-based, CSS-inlined, Outlook-safe.

Replaces MJML for transactional email built with the Frontier ecosystem.

## Install

```bash
npm install @frontierjs/email-kit @frontierjs/mesa
```

## Usage

### In a Mesa template

```mesa
<script module>
  export const subject = `Welcome, ${firstName}!`
</script>

<script>
  import Email    from '@frontierjs/email-kit/components/Email.mesa'
  import Section  from '@frontierjs/email-kit/components/Section.mesa'
  import Row      from '@frontierjs/email-kit/components/Row.mesa'
  import Column   from '@frontierjs/email-kit/components/Column.mesa'
  import Button   from '@frontierjs/email-kit/components/Button.mesa'
  import Card     from '@frontierjs/email-kit/components/Card.mesa'
  import KeyValue from '@frontierjs/email-kit/components/KeyValue.mesa'
  import Footer   from '@frontierjs/email-kit/components/Footer.mesa'

  export let firstName = 'Friend'
  export let planName  = 'Pro'
  export let amount    = '$49.00'
</script>

<Email preview="Your account is ready.">
  <Section bgcolor="#9fc612">
    <Row>
      <Column align="center" padding="32px 16px">
        <h1 style="color:#fff;font-family:Helvetica,Arial,sans-serif;">
          Welcome, {firstName}!
        </h1>
      </Column>
    </Row>
  </Section>

  <Section>
    <Row>
      <Column>
        <Card heading="Your Plan">
          <KeyValue label="Plan"   value="{planName}" />
          <KeyValue label="Amount" value="{amount}" bold={true} />
        </Card>
      </Column>
    </Row>
    <Button href="https://app.example.com" text="Go to Dashboard" />
  </Section>

  <Section bgcolor="#f4f4f4">
    <Footer
      company="Example Inc."
      unsubscribe="https://example.com/unsubscribe"
    />
  </Section>
</Email>
```

### Server-side rendering

```js
import { renderEmailFile } from '@frontierjs/email-kit/render'

const result = await renderEmailFile('./emails/WelcomeEmail.mesa', {
  data: {
    firstName: 'Alice',
    planName:  'Pro',
    amount:    '$49.00',
  }
})

// result.html     — complete <!DOCTYPE html> with all CSS inlined
// result.text     — plain-text fallback
// result.subject  — from export const subject in <script module>
// result.css      — collected CSS (pre-inlining, for debugging)

// Send via your email provider:
await sendgrid.send({
  to:      'alice@example.com',
  from:    'hello@example.com',
  subject: result.subject,
  html:    result.html,
  text:    result.text,
})
```

## Components

### Layout

| Component | Description |
|-----------|-------------|
| `Email`   | Full email document wrapper with preheader support |
| `Section` | Full-width table section |
| `Row`     | Single `<tr>` row |
| `TwoCol`  | Responsive two-column layout (stacks on mobile) |
| `Column`  | `<td>` cell |
| `Spacer`  | Vertical whitespace row |

### Content

| Component  | Description |
|------------|-------------|
| `Heading`  | Accent heading row |
| `Text`     | Paragraph with email-safe typography |
| `Button`   | CTA with Outlook VML fallback |
| `Image`    | Responsive image with fluid class |
| `Link`     | Inline anchor |
| `Divider`  | Table-cell horizontal rule |

### Blocks

| Component   | Description |
|-------------|-------------|
| `Card`      | Bordered card with optional heading |
| `KeyValue`  | Label/value pair row — the workhorse for data display |
| `DataTable` | Structured table with header row |
| `Review`    | Testimonial block with avatar, stars, body |
| `Stars`     | Inline SVG star rating (no external image) |
| `Avatar`    | Inline SVG letter circle |

### Structural

| Component | Description |
|-----------|-------------|
| `Header`  | Logo/brand header row |
| `Footer`  | Legal/unsubscribe footer |
| `Contact` | Name, email, phone, URL block |
| `Address` | Formatted address with Google Maps link |

## Templates

Starter templates live in `./templates/`:

- `WelcomeEmail.mesa` — onboarding/welcome email with hero, plan summary, testimonial

## How it works

Templates are standard Mesa components. `renderEmailFile` / `renderEmail` calls
`@frontierjs/mesa`'s `renderComponent` pipeline with `target: 'email'`:

1. Recursively compiles all `.mesa` imports
2. Executes components in a happy-dom virtual DOM
3. Collects all `<style>` block CSS across the tree
4. Inlines CSS into `style=""` attributes (CSS variables resolved, `@media` preserved in `<head>`)
5. Wraps in a complete `<!DOCTYPE html>` document with MSO/VML namespaces

## Email client compatibility

- **Outlook** — VML bulletproof buttons, MSO conditional comments, table layout
- **Gmail** — inlined styles (no `<style>` block in body)
- **Apple Mail** — full CSS support, responsive via `@media`
- **Mobile** — two-column layouts stack via `@media (max-width: 600px)`
