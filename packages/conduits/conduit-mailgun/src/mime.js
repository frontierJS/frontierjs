"use strict";
// src/mime.ts — raw RFC 5322 bytes to one `ReceivedMail`.
//
// The parser `FJS-D784` said the first raw-MIME vendor would bring. Mailgun's
// `mime` route hands over the whole message and nothing parsed; SES does the
// same, and a second raw-MIME connector imports `fromMime` from this package
// rather than writing one (until two askers move it). Nothing of Mailgun's is
// in here: the envelope is an argument, because it is the one fact the bytes
// do not carry.
//
// postal-mime does the decoding — encoded words, quoted-printable, base64,
// charsets, nested multiparts — and this file decides what of it is a
// `ReceivedMail`:
//   - `from` is one mailbox string as a header writes it, by
//     `@frontierjs/toolbelt/mailbox`, so junction's `assertMailbox` splits it.
//   - headers keep the sender's own spelling, EXCEPT the three an app reads
//     to thread a reply, pinned to the spelling Postmark's dialect already
//     produces (`Message-ID`, `In-Reply-To`, `References`): an app reading
//     `headers['Message-ID']` straight must get the same answer from every
//     dialect. A header that repeats (`Received`) is joined with `, `.
//   - every part that is not the body is an attachment, inline images
//     included, with `cid` for one the HTML draws — junction's
//     `MailAttachment` read back.
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fromMime = fromMime;
var postal_mime_1 = require("postal-mime");
var mailbox_1 = require("@frontierjs/toolbelt/mailbox");
var PINNED = { 'message-id': 'Message-ID', 'in-reply-to': 'In-Reply-To', references: 'References' };
function mailboxes(list) {
    return (list !== null && list !== void 0 ? list : []).flatMap(function (a) { return a.group ? a.group.map(function (m) { return (0, mailbox_1.formatMailbox)(m.address, m.name); }) : a.address ? [(0, mailbox_1.formatMailbox)(a.address, a.name)] : []; });
}
var bytes = function (c) {
    return typeof c === 'string' ? new TextEncoder().encode(c) : c instanceof Uint8Array ? c : new Uint8Array(c);
};
/** The message as a `ReceivedMail`, or null for bytes that are not one — no recipient, nothing to parse, no sender anywhere. */
function fromMime(raw, envelope) {
    return __awaiter(this, void 0, void 0, function () {
        var recipient, mail, fromAddress, headers, _i, _a, h, name_1, value, attachments, to, cc;
        var _b, _c, _d, _e, _f, _g, _h, _j;
        return __generator(this, function (_k) {
            switch (_k.label) {
                case 0:
                    recipient = String((_b = envelope === null || envelope === void 0 ? void 0 : envelope.recipient) !== null && _b !== void 0 ? _b : '').trim();
                    if (!recipient || raw === null || raw === undefined)
                        return [2 /*return*/, null];
                    if (typeof raw === 'string' ? !raw.trim() : raw.byteLength === 0)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, postal_mime_1.default.parse(raw, { attachmentEncoding: 'arraybuffer' })];
                case 1:
                    mail = _k.sent();
                    fromAddress = ((_e = (_d = (_c = mail.from) === null || _c === void 0 ? void 0 : _c.address) !== null && _d !== void 0 ? _d : envelope.sender) !== null && _e !== void 0 ? _e : '').trim();
                    if (!fromAddress)
                        return [2 /*return*/, null];
                    headers = {};
                    for (_i = 0, _a = mail.headers; _i < _a.length; _i++) {
                        h = _a[_i];
                        name_1 = (_g = (_f = PINNED[h.key]) !== null && _f !== void 0 ? _f : h.originalKey) !== null && _g !== void 0 ? _g : h.key;
                        value = (0, postal_mime_1.decodeWords)(h.value).replace(/\s*\r?\n\s*/g, ' ').trim();
                        headers[name_1] = name_1 in headers ? "".concat(headers[name_1], ", ").concat(value) : value;
                    }
                    attachments = mail.attachments.map(function (a) { return (__assign({ filename: a.filename || 'attachment', content: bytes(a.content), type: a.mimeType || 'application/octet-stream' }, (a.contentId ? { cid: a.contentId.replace(/^<|>$/g, '') } : {}))); });
                    to = mailboxes(mail.to);
                    cc = mailboxes(mail.cc);
                    return [2 /*return*/, __assign(__assign(__assign(__assign({ recipient: recipient, to: to.length ? to : recipient, from: (0, mailbox_1.formatMailbox)(fromAddress, (_h = mail.from) === null || _h === void 0 ? void 0 : _h.name), subject: (_j = mail.subject) !== null && _j !== void 0 ? _j : '' }, (cc.length ? { cc: cc } : {})), (mail.text !== undefined ? { text: mail.text } : {})), (mail.html !== undefined ? { html: mail.html } : {})), { headers: headers, attachments: attachments })];
            }
        });
    });
}
