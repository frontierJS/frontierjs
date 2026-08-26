
import * as $$runtime from '@frontierjs/mesa/runtime.js';
var $$tpl0 = $$runtime.template(`<tr><td style="padding:0;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;"><tr><td><span></span><a> </a><span></span></td></tr></table></td></tr>`, 0);
export default function Button(__anchor, __props, __block) {
  $$runtime.push_component();
  const $$option = { props: __props };
  const $$slots = $$runtime.makeSlots(__block);
  const $$sig_href = $$runtime.track($$option.props?.href !== undefined ? $$option.props.href : '', void 0, void 0, __block);
  const $$set_href = (v) => $$runtime.set($$sig_href, v);
  $$runtime.makeExternalProperty('href', $$sig_href, $$set_href);
  const $$sig_text = $$runtime.track($$option.props?.text !== undefined ? $$option.props.text : '', void 0, void 0, __block);
  const $$set_text = (v) => $$runtime.set($$sig_text, v);
  $$runtime.makeExternalProperty('text', $$sig_text, $$set_text);
  const $$sig_bgcolor = $$runtime.track($$option.props?.bgcolor !== undefined ? $$option.props.bgcolor : '#9fc612', void 0, void 0, __block);
  const $$set_bgcolor = (v) => $$runtime.set($$sig_bgcolor, v);
  $$runtime.makeExternalProperty('bgcolor', $$sig_bgcolor, $$set_bgcolor);
  const $$sig_color = $$runtime.track($$option.props?.color !== undefined ? $$option.props.color : '#ffffff', void 0, void 0, __block);
  const $$set_color = (v) => $$runtime.set($$sig_color, v);
  $$runtime.makeExternalProperty('color', $$sig_color, $$set_color);
  const $$sig_target = $$runtime.track($$option.props?.target !== undefined ? $$option.props.target : '_blank', void 0, void 0, __block);
  const $$set_target = (v) => $$runtime.set($$sig_target, v);
  $$runtime.makeExternalProperty('target', $$sig_target, $$set_target);
  const $$sig_align = $$runtime.track($$option.props?.align !== undefined ? $$option.props.align : 'center', void 0, void 0, __block);
  const $$set_align = (v) => $$runtime.set($$sig_align, v);
  $$runtime.makeExternalProperty('align', $$sig_align, $$set_align);
  const $$sig_padding = $$runtime.track($$option.props?.padding !== undefined ? $$option.props.padding : '16px', void 0, void 0, __block);
  const $$set_padding = (v) => $$runtime.set($$sig_padding, v);
  $$runtime.makeExternalProperty('padding', $$sig_padding, $$set_padding);
  const $$sig_radius = $$runtime.track($$option.props?.radius !== undefined ? $$option.props.radius : 4, void 0, void 0, __block);
  const $$set_radius = (v) => $$runtime.set($$sig_radius, v);
  $$runtime.makeExternalProperty('radius', $$sig_radius, $$set_radius);
  const $$sig_size = $$runtime.track($$option.props?.size !== undefined ? $$option.props.size : 14, void 0, void 0, __block);
  const $$set_size = (v) => $$runtime.set($$sig_size, v);
  $$runtime.makeExternalProperty('size', $$sig_size, $$set_size);
  const $$sig_weight = $$runtime.track($$option.props?.weight !== undefined ? $$option.props.weight : 700, void 0, void 0, __block);
  const $$set_weight = (v) => $$runtime.set($$sig_weight, v);
  $$runtime.makeExternalProperty('weight', $$sig_weight, $$set_weight);
  const $$onMount   = $$runtime.onMount;
  const $$onDestroy = $$runtime.onDestroy;
  const $$onCleanup = $$runtime.onCleanup;
  const msoHTML = $$runtime.trackDerived(() => (`<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${$$runtime.get($$sig_href)}" style="height:44px;v-text-anchor:middle;width:200px;" arcsize="${Math.round($$runtime.get($$sig_radius) * 2)}%" stroke="f" fillcolor="${$$runtime.get($$sig_bgcolor)}">
<w:anchorlock/>
<center style="color:${$$runtime.get($$sig_color)};font-family:Helvetica,Arial,sans-serif;font-size:${$$runtime.get($$sig_size)}px;font-weight:${$$runtime.get($$sig_weight)};">${$$runtime.get($$sig_text)}</center>
</v:roundrect>
<![endif]--><!--[if !mso]><!-->`), void 0, void 0, __block);
  const msoClose = `<!--<![endif]-->`;
  {
    const $$parentElement = $$tpl0();
    var el0 = $$runtime.child($$parentElement, true);
    var el1 = $$runtime.child(el0, true);
    var $$t0 = $$runtime.child(el1);
    var el2 = $$runtime.child($$t0, true);
    var el3 = $$runtime.child(el2, true);
    var el4 = $$runtime.sibling(el3);
    var el5 = $$runtime.child(el4, true);
    $$runtime.pop(el4);
    var el6 = $$runtime.sibling(el4);
    $$runtime.set_attribute(el6, 'data-mso-close', encodeURIComponent(msoClose));
    $$runtime.render((__prev) => {
      var __a = `${$$runtime.get($$sig_align)}`;
      if (__prev.a !== __a) $$runtime.set_attribute(el0, 'align', __prev.a = __a);
      var __b = `${$$runtime.get($$sig_align)}`;
      if (__prev.b !== __b) $$runtime.set_attribute(el1, 'align', __prev.b = __b);
      var __c = `padding:${$$runtime.get($$sig_padding)};`;
      if (__prev.c !== __c) $$runtime.set_attribute(el2, 'style', __prev.c = __c);
      var __d = encodeURIComponent($$runtime.get(msoHTML));
      if (__prev.d !== __d) $$runtime.set_attribute(el3, 'data-mso', __prev.d = __d);
      var __e = $$runtime.get($$sig_href);
      if (__prev.e !== __e) $$runtime.set_attribute(el4, 'href', __prev.e = __e);
      var __f = $$runtime.get($$sig_target);
      if (__prev.f !== __f) $$runtime.set_attribute(el4, 'target', __prev.f = __f);
      var __g = `display:inline-block;background-color:${$$runtime.get($$sig_bgcolor)};color:${$$runtime.get($$sig_color)};font-family:Helvetica,Arial,sans-serif;font-size:${$$runtime.get($$sig_size)}px;font-weight:${$$runtime.get($$sig_weight)};letter-spacing:1.5px;line-height:1;text-decoration:none;text-align:center;padding:12px 28px;border-radius:${$$runtime.get($$sig_radius)}px;mso-padding-alt:0;-webkit-text-size-adjust:none;`;
      if (__prev.g !== __g) $$runtime.set_attribute(el4, 'style', __prev.g = __g);
      var __h = `${$$runtime.get($$sig_text)}`;
      if (__prev.h !== __h) $$runtime.set_text(el5, __prev.h = __h);
    }, { a: null, b: null, c: null, d: null, e: null, f: null, g: null, h: ' ' });
    $$runtime.append(__anchor, $$parentElement);
  }
  $$runtime.pop_component();
}