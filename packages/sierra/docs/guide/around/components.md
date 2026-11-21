# Components with @frontierjs/ui

`@frontierjs/ui` is Mesa components over the css vocabulary: the keyboard, focus, ARIA and state that a stylesheet cannot give you. A component takes a tone and a treatment as props, so there is no color to carry, and `<Form>` reads a resource and writes its own fields.

```mesa
<script>
  import Alert from '@frontierjs/ui/components/feedback/Alert.mesa'
  import Form  from '@frontierjs/ui/components/forms/Form.mesa'
  import { leads } from '@/resources/Lead.mesa'
</script>

<Alert tone="warning" title="Heads up">Your trial ends Friday.</Alert>
<Form resource={leads} />
```

## What else it can do

- The kit covers forms, display, layout, overlay and feedback, from `Input` and `Select` to `Modal`, `Drawer`, `Tabs`, `Table` and `Toaster`
- `<Form resource={leads} />` generates a control for every writable column and puts each server error under its field
- `only` and `except` narrow the generated fields, and writing children means you write the form
- A foreign key becomes a picker whose rows come from the relation
- `autosave` makes a form save once the typing stops
- `Button` takes `tone` and `treatment` as separate props
- `data-confirm="Delete this order?"` on any element asks first, once `<ConfirmProvider />` is mounted
- Every component merges a `class` you pass and forwards attributes it does not declare, so most changes need no new component
- Write your own `.mesa` component when the kit has nothing that draws the thing, and style it with the same tones and treatments

**In depth:** [ui README § What's in the box](../../../../ui/README.md#whats-in-the-box), [§ Forms know what they are editing](../../../../ui/README.md#forms-know-what-they-are-editing)
