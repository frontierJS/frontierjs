
import * as $runtime from '../src/runtime.js';
var $tpl0 = $runtime.template(`<div class="b mztntfp9zlo"><><></div>`, 0);
export default function PropLayout(__anchor, __props, __block) {
  $runtime.push_component();
  const $option = { props: __props };
  const $slots = $runtime.makeSlots(__block);
  const $$sig_children = $runtime.track($option.props?.children !== undefined ? $option.props.children : null, void 0, void 0, __block);
  const $$set_children = (v) => $runtime.set($$sig_children, v);
  $runtime.makeExternalProperty('children', $$sig_children, $$set_children);
  const $onMount   = $runtime.$onMount;
  const $onDestroy = $runtime.$onDestroy;
  const $onCleanup = $runtime.$onCleanup;
  {
    const $parentElement = $tpl0();
    var $_skip0 = $runtime.child($parentElement);
    var el0 = $runtime.sibling($_skip0);
    { const $$sf = $runtime.get($$sig_children); if ($$sf) $$sf(el0); }
    $runtime.append(__anchor, $parentElement);
  }
  $runtime.pop_component();
}