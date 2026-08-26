
import * as $$runtime from '@frontierjs/mesa/runtime.js';
var $$tpl0 = $$runtime.template(`<td></td>`, 0);
export default function Column(__anchor, __props, __block) {
  $$runtime.push_component();
  const $$option = { props: __props };
  const $$slots = $$runtime.makeSlots(__block);
  const $$sig_width = $$runtime.track($$option.props?.width !== undefined ? $$option.props.width : undefined, void 0, void 0, __block);
  const $$set_width = (v) => $$runtime.set($$sig_width, v);
  $$runtime.makeExternalProperty('width', $$sig_width, $$set_width);
  const $$sig_bgcolor = $$runtime.track($$option.props?.bgcolor !== undefined ? $$option.props.bgcolor : undefined, void 0, void 0, __block);
  const $$set_bgcolor = (v) => $$runtime.set($$sig_bgcolor, v);
  $$runtime.makeExternalProperty('bgcolor', $$sig_bgcolor, $$set_bgcolor);
  const $$sig_padding = $$runtime.track($$option.props?.padding !== undefined ? $$option.props.padding : '0 16px', void 0, void 0, __block);
  const $$set_padding = (v) => $$runtime.set($$sig_padding, v);
  $$runtime.makeExternalProperty('padding', $$sig_padding, $$set_padding);
  const $$sig_valign = $$runtime.track($$option.props?.valign !== undefined ? $$option.props.valign : 'top', void 0, void 0, __block);
  const $$set_valign = (v) => $$runtime.set($$sig_valign, v);
  $$runtime.makeExternalProperty('valign', $$sig_valign, $$set_valign);
  const $$sig_align = $$runtime.track($$option.props?.align !== undefined ? $$option.props.align : 'left', void 0, void 0, __block);
  const $$set_align = (v) => $$runtime.set($$sig_align, v);
  $$runtime.makeExternalProperty('align', $$sig_align, $$set_align);
  const $$sig_colspan = $$runtime.track($$option.props?.colspan !== undefined ? $$option.props.colspan : undefined, void 0, void 0, __block);
  const $$set_colspan = (v) => $$runtime.set($$sig_colspan, v);
  $$runtime.makeExternalProperty('colspan', $$sig_colspan, $$set_colspan);
  const $$onMount   = $$runtime.onMount;
  const $$onDestroy = $$runtime.onDestroy;
  const $$onCleanup = $$runtime.onCleanup;
  {
    const $$parentElement = $$tpl0();
    let el0 = $$parentElement;
    $$runtime.render((__prev) => {
      var __a = `${$$runtime.get($$sig_align)}`;
      if (__prev.a !== __a) $$runtime.set_attribute(el0, 'align', __prev.a = __a);
      var __b = `${$$runtime.get($$sig_valign)}`;
      if (__prev.b !== __b) $$runtime.set_attribute(el0, 'valign', __prev.b = __b);
      var __c = `${$$runtime.get($$sig_colspan)}`;
      if (__prev.c !== __c) $$runtime.set_attribute(el0, 'colspan', __prev.c = __c);
    }, { a: null, b: null, c: null });
    $$runtime.bindAttribute(el0, 'style', () => (`
    font-family:Helvetica,Arial,sans-serif;
    font-size:16px;
    vertical-align:${$$runtime.get($$sig_valign)};
    text-align:${$$runtime.get($$sig_align)};
    padding:${$$runtime.get($$sig_padding)};
    ${$$runtime.get($$sig_width)   ? `width:${$$runtime.get($$sig_width)};`                      : ''}
    ${$$runtime.get($$sig_bgcolor) ? `background-color:${$$runtime.get($$sig_bgcolor)};`         : ''}
  `));
    $$runtime.addBlock(el0, $$runtime.attachNamedSlot(__block, 'default', null));
    $$runtime.append(__anchor, $$parentElement);
  }
  $$runtime.pop_component();
}