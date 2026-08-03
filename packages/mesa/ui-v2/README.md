# Mesa UI Kit

Component library for Mesa. Tailwind CSS. No third-party dependencies.

---

## Structure

```
mesa-ui/
├── utils.js                         # nameToLabel(), uid()
├── stores/
│   ├── alertStore.js                # Global alert state (plain JS)
│   └── toastStore.js                # Toast queue (plain JS)
└── components/
    ├── forms/
    │   ├── Field.mesa               # ★ Foundation — label + slot + hint + error
    │   ├── Label.mesa               # Standalone label with badge + help icon
    │   ├── Button.mesa              # variant/size/loading/icon
    │   ├── Input.mesa               # Text input, self-wraps in Field when label set
    │   ├── Textarea.mesa            # Multiline, optional autogrow
    │   ├── Select.mesa              # Native select, flat or grouped options
    │   ├── Checkbox.mesa            # Single checkbox with label + description
    │   ├── RadioGroup.mesa          # Card-style radio group
    │   ├── Switch.mesa              # Toggle, sm/md/lg sizes
    │   └── Fieldset.mesa            # Groups related fields with legend
    ├── overlay/
    │   ├── Modal.mesa               # Dialog, focus trap, footer snippet
    │   ├── Drawer.mesa              # Side panel, any edge, footer snippet
    │   ├── Tooltip.mesa             # Hover label, 4 placements
    │   └── Popover.mesa             # Click panel, smart viewport positioning
    ├── layout/
    │   ├── Card.mesa                # Container with header/footer snippets
    │   ├── Accordion.mesa           # Context provider for AccordionItems
    │   ├── AccordionItem.mesa       # CSS grid height animation, no JS
    │   ├── Tabs.mesa                # Context provider, manages activeId
    │   ├── TabList.mesa             # Tab button strip, keyboard nav
    │   ├── Tab.mesa                 # Individual tab button
    │   └── TabPanel.mesa            # Content region
    └── feedback/
        ├── Alert.mesa               # Inline alert banner (info/success/warning/error)
        ├── AlertProvider.mesa       # Global floating alert from alertStore
        ├── Spinner.mesa             # Loading indicator, 5 sizes
        ├── Toast.mesa               # Individual toast (used by Toaster)
        └── Toaster.mesa             # Toast stack from toastStore, 6 positions
```

---

## Form system

The kit has three layers. They all compose the same primitives.

### Layer 1 — Field + Label (primitives)

```mesa
<Field label="Email" name="email" required hint="We never share this" {errors}>
  <Input type="email" bind:value={email} />
</Field>
```

### Layer 2 — Shorthand label prop (most common)

Every input composites Field internally when `label` is passed:

```mesa
<Input  label="Email"   name="email"   type="email"  bind:value={email}   {errors} />
<Select label="Country" name="country" options={countries}  bind:value={country} {errors} />
<Textarea label="Bio"   name="bio"     rows={4}      bind:value={bio}     {errors} />
```

### Layer 3 — Fieldset groups

```mesa
<Fieldset legend="Shipping address" description="Where to send your order">
  <div class="grid grid-cols-2 gap-4">
    <Input label="First name" name="first" bind:value={first} {errors} />
    <Input label="Last name"  name="last"  bind:value={last}  {errors} />
  </div>
  <Input  label="Street"  name="street"  bind:value={street}  {errors} />
  <Select label="Country" name="country" options={countries}  bind:value={country} {errors} />
</Fieldset>
```

### Server error maps

Pass your server-returned error object as `errors`. Field resolves `errors[name]`
automatically. Replace the object (don't mutate) for reactivity:

```js
// On server response:
errors = { email: 'Already taken', street: 'Required' }
// Reset:
errors = {}
```

### Removable fields (dynamic form rows)

```mesa
<Input
  label="API key"
  name="key"
  bind:value={key}
  removable
  on:removeKey={() => keys = keys.filter(k => k !== key)}
/>
```

### Label badges

```mesa
<Input label="Email"       name="email"  badge="Required"  ... />
<Input label="Middle name" name="middle" badge="Optional"  ... />
<Input label="Invite code" name="code"   badge="Beta"      ... />
```

---

## Button

```mesa
<!-- Variants -->
<Button>Primary</Button>
<Button variant="secondary">Secondary</Button>
<Button variant="ghost">Ghost</Button>
<Button variant="danger">Danger</Button>
<Button variant="outline">Outline</Button>
<Button variant="link" href="/docs">Link</Button>

<!-- Sizes -->
<Button size="xs">Extra small</Button>
<Button size="lg">Large</Button>

<!-- Loading -->
<Button loading={saving}>Save changes</Button>

<!-- Icon-only (square) -->
<Button icon variant="ghost"><IconTrash /></Button>

<!-- With leading/trailing icon snippets -->
<Button>
  {#snippet leading()}<IconPlus />{/snippet}
  Add item
</Button>
```

---

## Overlay components

### Modal

```mesa
<script>
  let open = false
</script>

<Button onclick={() => open = true}>Open modal</Button>

<Modal bind:open title="Confirm" size="sm">
  <p>Are you sure you want to delete this?</p>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => open = false}>Cancel</Button>
    <Button variant="danger" onclick={handleDelete}>Delete</Button>
  {/snippet}
</Modal>
```

### Drawer

```mesa
<Drawer bind:open title="Settings" side="right">
  <p>Drawer content</p>

  {#snippet footer()}
    <Button onclick={save}>Save</Button>
  {/snippet}
</Drawer>
```

`side` is an `export var` (snapshot at mount). The slide animation direction is
computed once — the drawer side cannot change after mounting.

### Tooltip

```mesa
<Tooltip label="Copied to clipboard!" placement="top">
  <Button variant="ghost" icon onclick={copy}><IconCopy /></Button>
</Tooltip>
```

### Popover

```mesa
<Popover placement="bottom-start">
  {#snippet trigger()}
    <Button variant="outline">Options ▾</Button>
  {/snippet}
  {#snippet content()}
    <div class="flex flex-col p-1">
      <button class="px-3 py-2 text-sm text-left hover:bg-gray-100 rounded-lg">Edit</button>
      <button class="px-3 py-2 text-sm text-left hover:bg-gray-100 rounded-lg text-red-600">Delete</button>
    </div>
  {/snippet}
</Popover>
```

---

## Layout components

### Card

```mesa
<Card>
  {#snippet header()}
    <h3 class="font-semibold text-gray-900">Team members</h3>
  {/snippet}

  <p>Card body content</p>

  {#snippet footer()}
    <Button size="sm">Invite member</Button>
  {/snippet}
</Card>
```

### Accordion

```mesa
<Accordion multiple={false} defaultOpen={['faq-1']}>
  <AccordionItem id="faq-1" label="What is Mesa?">
    Mesa is a reactive UI language with compiler-detected state.
  </AccordionItem>
  <AccordionItem id="faq-2" label="How does reactivity work?">
    Top-level let/const/var declarations drive the reactive graph.
  </AccordionItem>
</Accordion>
```

Panel animation uses CSS `grid-template-rows: 0fr → 1fr` — zero JavaScript.

### Tabs

```mesa
<Tabs bind:activeId={tab}>
  <TabList variant="underline">
    <Tab id="general">General</Tab>
    <Tab id="security">Security</Tab>
    <Tab id="billing">Billing</Tab>
  </TabList>

  <TabPanel id="general"  class="pt-6"><GeneralSettings  /></TabPanel>
  <TabPanel id="security" class="pt-6"><SecuritySettings /></TabPanel>
  <TabPanel id="billing"  class="pt-6" unmount><BillingSettings  /></TabPanel>
</Tabs>
```

`TabList variant` options: `underline` | `pills` | `boxed`

`TabPanel unmount` — destroys DOM on hide (use for expensive panels with async setup).
Default: CSS `hidden` attribute — panel stays mounted.

Arrow key navigation is handled by TabList and cycles through registered tabs.

---

## Feedback components

### Inline Alert

```mesa
<Alert type="error" title="Save failed" dismissible on:close={() => showErr = false}>
  Please check your connection and try again.
</Alert>

<Alert type="success">Your changes have been saved.</Alert>
```

### Global Alert (floating)

Mount `AlertProvider` once near the app root:

```mesa
<!-- App.mesa -->
<AlertProvider />
```

Trigger from anywhere:

```js
import { alert } from '../stores/alertStore.js'

alert.success('File uploaded!')
alert.error('Upload failed.', 0)      // 0 = persistent, no auto-dismiss
alert.warning('Session expires soon')
```

### Toaster

Mount `Toaster` once near the app root:

```mesa
<!-- App.mesa -->
<Toaster position="bottom-right" />
<AlertProvider />
```

Trigger from anywhere:

```js
import { toasts } from '../stores/toastStore.js'

toasts.success('Changes saved')
toasts.error('Failed to save')
const id = toasts.add('Custom', 'info', 5000)
toasts.remove(id)   // programmatic dismiss
```

### Spinner

```mesa
<Spinner />
<Spinner size="lg" color="gray" />
<Spinner size="sm" color="white" label="Uploading file…" />
<Spinner size="md" color="current" />   <!-- inherits text color from parent -->
```

---

## Switch vs Checkbox vs RadioGroup

| Component    | Use when                                         | Value type |
|--------------|--------------------------------------------------|------------|
| `Switch`     | Binary toggle — immediate effect (dark mode, notifications) | boolean |
| `Checkbox`   | Form option — effect on submit (agree to terms, select features) | boolean |
| `RadioGroup` | Single selection from 2–6 labelled options      | any scalar |

---

## Design notes

**`export var` for geometry** — Drawer's `side` and Toast's `duration` use `export var`
(non-reactive prop). This is intentional: these values drive one-time computations
at mount (animation direction, CSS animation duration) that should never re-derive.

**Immutable error replacement** — always replace the errors object, never mutate:
```js
// ✓ correct
errors = { ...errors, email: 'Required' }
errors = {}

// ✗ wrong — mutations are invisible to Mesa's reactive graph
errors.email = 'Required'
delete errors.email
```

**Context for compound components** — Tabs and Accordion use `$context` instead of
Svelte's writable stores. `const` consumers (Tab, TabPanel, AccordionItem) always
track the provider. No store API needed.

**`$onCleanup` for side effects** — scroll lock in Modal/Drawer uses `$: open, () => {}`
with `$onCleanup` to guarantee cleanup before the next run and on destroy.
The lock is never left dangling even if the component is destroyed while open.
