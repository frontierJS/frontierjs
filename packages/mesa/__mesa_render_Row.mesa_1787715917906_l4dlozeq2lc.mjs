
import * as $$runtime from '@frontierjs/mesa/runtime.js';
var $$tpl0 = $$runtime.template(`<tr></tr>`, 0);
export default function Row(__anchor, __props, __block) {
  $$runtime.push_component();
  const $$option = { props: __props };
  const $$slots = $$runtime.makeSlots(__block);
  const $$sig_bgcolor = $$runtime.track($$option.props?.bgcolor !== undefined ? $$option.props.bgcolor : undefined, void 0, void 0, __block);
  const $$set_bgcolor = (v) => $$runtime.set($$sig_bgcolor, v);
  $$runtime.makeExternalProperty('bgcolor', $$sig_bgcolor, $$set_bgcolor);
  const $$sig_align = $$runtime.track($$option.props?.align !== undefined ? $$option.props.align : undefined, void 0, void 0, __block);
  const $$set_align = (v) => $$runtime.set($$sig_align, v);
  $$runtime.makeExternalProperty('align', $$sig_align, $$set_align);
  const $$sig_valign = $$runtime.track($$option.props?.valign !== undefined ? $$option.props.valign : 'top', void 0, void 0, __block);
  const $$set_valign = (v) => $$runtime.set($$sig_valign, v);
  $$runtime.makeExternalProperty('valign', $$sig_valign, $$set_valign);
  const $$onMount   = $$runtime.onMount;
  const $$onDestroy = $$runtime.onDestroy;
  const $$onCleanup = $$runtime.onCleanup;
  {
    const $$parentElement = $$tpl0();
    let el0 = $$parentElement;
    $$runtime.render((__prev) => {
      var __a = `${$$runtime.get($$sig_valign)}`;
      if (__prev.a !== __a) $$runtime.set_attribute(el0, 'valign', __prev.a = __a);
      var __b = `${$$runtime.get($$sig_bgcolor) ? `background-color:${$$runtime.get($$sig_bgcolor)};` : ''}${$$runtime.get($$sig_align) ? `text-align:${$$runtime.get($$sig_align)};` : ''}`;
      if (__prev.b !== __b) $$runtime.set_attribute(el0, 'style', __prev.b = __b);
    }, { a: null, b: null });
    $$runtime.addBlock(el0, $$runtime.attachNamedSlot(__block, 'default', null));
    $$runtime.append(__anchor, $$parentElement);
  }
  $$runtime.pop_component();
}