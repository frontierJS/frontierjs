// web/src/lib/controls.js — the form controls this console contributes,
// imported by main.js before any route renders: a generated form picks its
// control when it is built.
//
// `command` on App and Blueprint is argv, which the kit's tag input mangles
// (see ArgvInput.mesa). Claimed by name AND by array, because `Job.command` is
// a shell line in a plain String and keeps the kit's text box.
import { registerControl }     from '@frontierjs/sierra/resource'
import { registerFormControl } from '@frontierjs/ui/controls'
import ArgvInput from '../components/ArgvInput.mesa'

registerControl('argv', (rule, { field }) => (field === 'command' && rule.type === 'array' ? 'argv' : null))
registerFormControl('argv', ArgvInput)
