# email-kit — package map

**`@frontierjs/email-kit`** — table-based email components compiled by Mesa with
`target: 'email'`. An MJML replacement, in the framework's own language.

`bun run test` — the runner is **vitest**.

---

## Layout

```
index.js       public API
render.js      the email render path — target: 'email', inlining, wrapper
components/    Email (the document) · Header · Footer · Section · Row · Column ·
               TwoCol · Card · Heading · Text · Button · Link · Image · Divider ·
               Spacer · DataTable · KeyValue · Address · Contact · Avatar ·
               Review · Stars
templates/     WelcomeEmail.mesa
docs/          Outlook conditional-comment handling — read before touching it
```

---

## What bites here

- **A consumer outside this package must be able to import a component.** That
  was broken and nobody noticed until `example/` put an order-confirmation
  template in the *app* — an in-package test proves nothing about the export map.
- **Its suite was failing for a long time while the status table said green**,
  because of a stale path into mesa. Run it, do not read about it.
- **Outlook conditional comments are fragile** — the `docs/` note is the only
  record of why the markup is shaped the way it is.
- **Never opened in a real mail client.** Every claim about rendering is a claim
  about HTML, not about Outlook or Gmail. Say so when reporting.

## Proving a change

`bun run test`, then `example`: `bun run verify:notify` — it renders a real
template and posts it to a real server. `bun run email:preview` in `example/`
renders one to look at.
