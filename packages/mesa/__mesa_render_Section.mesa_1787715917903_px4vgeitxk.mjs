
import * as $$runtime from '@frontierjs/mesa/runtime.js';
var $$tpl0 = $$runtime.template(`<><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tbody></tbody></table><>`, 1);
var $$tpl1 = $$runtime.template(`
<tr><td>&nbsp;</td></tr>
`, 0);
export default function Section(__anchor, __props, __block) {
  $$runtime.push_component();
  const $$option = { props: __props };
  const $$slots = $$runtime.makeSlots(__block);
  const $$sig_bgcolor = $$runtime.track($$option.props?.bgcolor !== undefined ? $$option.props.bgcolor : undefined, void 0, void 0, __block);
  const $$set_bgcolor = (v) => $$runtime.set($$sig_bgcolor, v);
  $$runtime.makeExternalProperty('bgcolor', $$sig_bgcolor, $$set_bgcolor);
  const $$sig_padding = $$runtime.track($$option.props?.padding !== undefined ? $$option.props.padding : undefined, void 0, void 0, __block);
  const $$set_padding = (v) => $$runtime.set($$sig_padding, v);
  $$runtime.makeExternalProperty('padding', $$sig_padding, $$set_padding);
  const $$sig_align = $$runtime.track($$option.props?.align !== undefined ? $$option.props.align : 'center', void 0, void 0, __block);
  const $$set_align = (v) => $$runtime.set($$sig_align, v);
  $$runtime.makeExternalProperty('align', $$sig_align, $$set_align);
  const $$onMount   = $$runtime.onMount;
  const $$onDestroy = $$runtime.onDestroy;
  const $$onCleanup = $$runtime.onCleanup;
  {
    const $$parentElement = $$tpl0();
    var $$_skip0 = $$runtime.child($$parentElement);
    var el1 = $$runtime.sibling($$_skip0);
    var el2 = $$runtime.child(el1, true);
    $$runtime.pop(el1);
    var el4 = $$runtime.sibling(el1);
    $$runtime.ifBlock(el1, () => ($$runtime.get($$sig_padding)) ? 0 : null, [$$runtime.makeBlock($$tpl1, ($$parentElement) => {
        var $$_skip0 = $$runtime.child($$parentElement);
        var $$t0 = $$runtime.sibling($$_skip0);
        var el0 = $$runtime.child($$t0, true);
        $$runtime.render((__prev) => {
          var __a = `font-size:0;line-height:0;height:${typeof $$runtime.get($$sig_padding) === 'number' ? $$runtime.get($$sig_padding) : 24}px;`;
          if (__prev.a !== __a) $$runtime.set_attribute(el0, 'style', __prev.a = __a);
        }, { a: null });
      })]
    );
    $$runtime.render((__prev) => {
      var __a = `${$$runtime.get($$sig_align)}`;
      if (__prev.a !== __a) $$runtime.set_attribute(el1, 'align', __prev.a = __a);
      var __b = `border-collapse:collapse;${$$runtime.get($$sig_bgcolor) ? `background-color:${$$runtime.get($$sig_bgcolor)};` : ''}`;
      if (__prev.b !== __b) $$runtime.set_attribute(el1, 'style', __prev.b = __b);
    }, { a: null, b: null });
    $$runtime.addBlock(el2, $$runtime.attachNamedSlot(__block, 'default', null));
    $$runtime.ifBlock(el4, () => ($$runtime.get($$sig_padding)) ? 0 : null, [$$runtime.makeBlock($$tpl1, ($$parentElement) => {
        var $$_skip0 = $$runtime.child($$parentElement);
        var $$t0 = $$runtime.sibling($$_skip0);
        var el3 = $$runtime.child($$t0, true);
        $$runtime.render((__prev) => {
          var __a = `font-size:0;line-height:0;height:${typeof $$runtime.get($$sig_padding) === 'number' ? $$runtime.get($$sig_padding) : 24}px;`;
          if (__prev.a !== __a) $$runtime.set_attribute(el3, 'style', __prev.a = __a);
        }, { a: null });
      })]
    );
    $$runtime.append(__anchor, $$parentElement);
  }
  $$runtime.pop_component();
}