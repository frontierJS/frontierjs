
import * as $$runtime from '@frontierjs/mesa/runtime.js';
var $$tpl0 = $$runtime.template(`<><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" class="mfnyxejpfyw"><tbody class="mfnyxejpfyw"><tr class="mfnyxejpfyw"><td align="center" style="padding:24px 0;" class="mfnyxejpfyw"><table role="presentation" cellspacing="0" cellpadding="0" border="0" class="email-container mfnyxejpfyw"><tbody class="mfnyxejpfyw"><tr class="mfnyxejpfyw"><td class="mfnyxejpfyw"></td></tr></tbody></table></td></tr></tbody></table>`, 1);
var $$tpl1 = $$runtime.template(`
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;" class="mfnyxejpfyw"> </div>
`, 0);

// Named exports from <script module> are real ES module exports.
  // Consumers can set these via data props; renderComponent captures them.
  // Example: renderComponent(src, { data: { subject: 'Hello' } })
  // and the template uses: export const subject = data.subject ?? 'No subject'

export default function Email(__anchor, __props, __block) {
  $$runtime.push_component();
  const $$option = { props: __props };
  const $$slots = $$runtime.makeSlots(__block);
  const $$sig_subject = $$runtime.track($$option.props?.subject !== undefined ? $$option.props.subject : '', void 0, void 0, __block);
  const $$set_subject = (v) => $$runtime.set($$sig_subject, v);
  $$runtime.makeExternalProperty('subject', $$sig_subject, $$set_subject);
  const $$sig_preview = $$runtime.track($$option.props?.preview !== undefined ? $$option.props.preview : '', void 0, void 0, __block);
  const $$set_preview = (v) => $$runtime.set($$sig_preview, v);
  $$runtime.makeExternalProperty('preview', $$sig_preview, $$set_preview);
  const $$sig_bgcolor = $$runtime.track($$option.props?.bgcolor !== undefined ? $$option.props.bgcolor : '#f4f4f4', void 0, void 0, __block);
  const $$set_bgcolor = (v) => $$runtime.set($$sig_bgcolor, v);
  $$runtime.makeExternalProperty('bgcolor', $$sig_bgcolor, $$set_bgcolor);
  const $$sig_width = $$runtime.track($$option.props?.width !== undefined ? $$option.props.width : 600, void 0, void 0, __block);
  const $$set_width = (v) => $$runtime.set($$sig_width, v);
  $$runtime.makeExternalProperty('width', $$sig_width, $$set_width);
  const $$sig_fontFamily = $$runtime.track($$option.props?.fontFamily !== undefined ? $$option.props.fontFamily : 'Helvetica, Arial, sans-serif', void 0, void 0, __block);
  const $$set_fontFamily = (v) => $$runtime.set($$sig_fontFamily, v);
  $$runtime.makeExternalProperty('fontFamily', $$sig_fontFamily, $$set_fontFamily);
  const $$onMount   = $$runtime.onMount;
  const $$onDestroy = $$runtime.onDestroy;
  const $$onCleanup = $$runtime.onCleanup;
  {
    const $$parentElement = $$tpl0();
    var $$_skip0 = $$runtime.child($$parentElement);
    var el1 = $$runtime.sibling($$_skip0);
    var $$t0 = $$runtime.child(el1);
    var $$t1 = $$runtime.child($$t0);
    var $$t2 = $$runtime.child($$t1);
    var el2 = $$runtime.child($$t2, true);
    var $$t3 = $$runtime.child(el2);
    var $$t4 = $$runtime.child($$t3);
    var el3 = $$runtime.child($$t4, true);
    $$runtime.ifBlock(el1, () => ($$runtime.get($$sig_preview)) ? 0 : null, [$$runtime.makeBlock($$tpl1, ($$parentElement) => {
        var $$_skip0 = $$runtime.child($$parentElement);
        var $$t0 = $$runtime.sibling($$_skip0);
        var el0 = $$runtime.child($$t0, true);
        $$runtime.bindText(el0, () => (`
  ${$$runtime.get($$sig_preview)}&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;
`));
      })]
    );
    $$runtime.render((__prev) => {
      var __a = `margin:0;padding:0;background-color:${$$runtime.get($$sig_bgcolor)};`;
      if (__prev.a !== __a) $$runtime.set_attribute(el1, 'style', __prev.a = __a);
      var __b = `${$$runtime.get($$sig_width)}`;
      if (__prev.b !== __b) $$runtime.set_attribute(el2, 'width', __prev.b = __b);
      var __c = `max-width:${$$runtime.get($$sig_width)}px;background-color:#ffffff;border-radius:4px;overflow:hidden;`;
      if (__prev.c !== __c) $$runtime.set_attribute(el2, 'style', __prev.c = __c);
      var __d = `font-family:${$$runtime.get($$sig_fontFamily)};font-size:16px;color:#444444;`;
      if (__prev.d !== __d) $$runtime.set_attribute(el3, 'style', __prev.d = __d);
    }, { a: null, b: null, c: null, d: null });
    $$runtime.addBlock(el3, $$runtime.attachNamedSlot(__block, 'default', null));
    $$runtime.append(__anchor, $$parentElement);
  }
  $$runtime.pop_component();
}