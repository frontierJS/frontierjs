"use strict";
// @frontierjs/conduit-postmark — Postmark over conduit.
//
// The second mail vendor, chosen for INBOUND: Postmark delivers a parsed
// message to a webhook, which `inbound-email.md` needs a provider for, and it
// is the second mailer `FJS-D684`'s `SendResult.id` ruling has to argue with
// (`MessageID`, a GUID, against Resend's `id`).
//
// Auth is a header, `X-Postmark-Server-Token`, so the `api_key` type fits.
// A send is not idempotent and Postmark honors no idempotency header: unkeyed,
// unreplayable, a lost response is `indeterminate`.
//
// Postmark SIGNS NOTHING. The inbound verifier is a constant-time compare of
// the Basic credential the app put in the webhook URL, plus an optional IP
// allow-list — it authenticates the URL, not the request (CONTRACT C8's
// third family). The README says so in its first paragraph.
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
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
exports.postmarkMailDialect = exports.POSTMARK_ADDRESS = exports.POSTMARK_TARGET = void 0;
exports.bindSend = bindSend;
exports.postmarkTarget = postmarkTarget;
exports.translate = translate;
exports.toPostmarkPayload = toPostmarkPayload;
exports.sendEmail = sendEmail;
exports.sendBatch = sendBatch;
exports.createPostmarkMailer = createPostmarkMailer;
exports.verifyPostmarkWebhook = verifyPostmarkWebhook;
exports.toReceivedMail = toReceivedMail;
exports.suppressionFor = suppressionFor;
var node_crypto_1 = require("node:crypto");
var mailbox_1 = require("@frontierjs/toolbelt/mailbox");
__exportStar(require("./types.ts"), exports);
exports.POSTMARK_TARGET = 'provider:postmark';
exports.POSTMARK_ADDRESS = 'https://api.postmarkapp.com';
function bindSend(conduit, target) {
    if (target === void 0) { target = exports.POSTMARK_TARGET; }
    return function (req) { return conduit.send(__assign({ target: target }, req)); };
}
function postmarkTarget(opts) {
    var _a, _b, _c;
    if (opts === void 0) { opts = {}; }
    return {
        id: (_a = opts.id) !== null && _a !== void 0 ? _a : exports.POSTMARK_TARGET, kind: 'provider', protocol: 'http', address: (_b = opts.address) !== null && _b !== void 0 ? _b : exports.POSTMARK_ADDRESS,
        auth: { type: 'api_key', header: 'X-Postmark-Server-Token', ref: (_c = opts.ref) !== null && _c !== void 0 ? _c : 'POSTMARK_SERVER_TOKEN' },
        registered_at: Date.now(), last_seen_at: null,
    };
}
function translate(error) {
    var _a;
    var body = null;
    try {
        body = typeof error.raw === 'string' ? JSON.parse(error.raw) : error.raw;
    }
    catch ( /* not JSON */_b) { /* not JSON */ }
    var base = __assign(__assign({ kind: error.kind, message: (_a = body === null || body === void 0 ? void 0 : body.Message) !== null && _a !== void 0 ? _a : error.message, retryable: error.retryable }, ((body === null || body === void 0 ? void 0 : body.ErrorCode) !== undefined ? { code: body.ErrorCode } : {})), (error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}));
    if (error.kind !== 'client_error')
        return base;
    if ((body === null || body === void 0 ? void 0 : body.ErrorCode) === 406)
        return __assign(__assign({}, base), { kind: 'suppressed', retryable: false });
    return __assign(__assign({}, base), { kind: 'refused', retryable: false });
}
// ─── Payload ─────────────────────────────────────────────────────────────
var list = function (v) { return v === undefined ? undefined : (Array.isArray(v) ? v : [v]).join(', '); };
var b64 = function (c) { return typeof c === 'string' ? c : Buffer.from(c instanceof ArrayBuffer ? new Uint8Array(c) : c).toString('base64'); };
function assertNoCrlf(v, what) { if (/[\r\n]/.test(v))
    throw new Error("postmark: ".concat(what, " contains a line break")); }
function toPostmarkPayload(msg, defaults) {
    var _a, _b, _c, _e, _f, _g;
    var from = (_a = msg.from) !== null && _a !== void 0 ? _a : defaults.from;
    var to = list(msg.to);
    if (!to)
        throw new Error('postmark: at least one recipient is required');
    if (!msg.html && !msg.text)
        throw new Error('postmark: html or text body is required');
    for (var _i = 0, _h = Object.entries({ from: from, to: to, subject: msg.subject }); _i < _h.length; _i++) {
        var _j = _h[_i], what = _j[0], v = _j[1];
        assertNoCrlf(v, what);
    }
    for (var _k = 0, _l = Object.entries((_b = msg.headers) !== null && _b !== void 0 ? _b : {}); _k < _l.length; _k++) {
        var _m = _l[_k], k = _m[0], v = _m[1];
        assertNoCrlf(k, 'header name');
        assertNoCrlf(v, "headers.".concat(k));
    }
    // Postmark takes ONE tag; the rest of the map goes to Metadata so nothing is dropped.
    var tags = Object.entries((_c = msg.tags) !== null && _c !== void 0 ? _c : {});
    return __assign(__assign(__assign(__assign(__assign(__assign(__assign(__assign(__assign({ From: from, To: to, Subject: msg.subject }, (msg.html ? { HtmlBody: msg.html } : {})), (msg.text ? { TextBody: msg.text } : {})), (((_e = msg.replyTo) !== null && _e !== void 0 ? _e : defaults.replyTo) ? { ReplyTo: (_f = msg.replyTo) !== null && _f !== void 0 ? _f : defaults.replyTo } : {})), (msg.cc ? { Cc: list(msg.cc) } : {})), (msg.bcc ? { Bcc: list(msg.bcc) } : {})), (msg.headers ? { Headers: Object.entries(msg.headers).map(function (_a) {
            var Name = _a[0], Value = _a[1];
            return ({ Name: Name, Value: Value });
        }) } : {})), (tags.length ? { Tag: "".concat(tags[0][0], ":").concat(tags[0][1]), Metadata: Object.fromEntries(tags) } : {})), (((_g = msg.attachments) === null || _g === void 0 ? void 0 : _g.length) ? { Attachments: msg.attachments.map(function (a) { var _a; return (__assign({ Name: a.filename, Content: b64(a.content), ContentType: (_a = a.type) !== null && _a !== void 0 ? _a : 'application/octet-stream' }, (a.cid ? { ContentID: "cid:".concat(a.cid) } : {}))); }) } : {})), (defaults.stream ? { MessageStream: defaults.stream } : {}));
}
function sendEmail(send, email) {
    return __awaiter(this, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, send({ method: 'POST', path: '/email', body: email })];
                case 1:
                    r = _a.sent();
                    if (r.error)
                        return [2 /*return*/, { error: translate(r.error) }];
                    return [2 /*return*/, { id: r.data.MessageID }];
            }
        });
    });
}
/** A batch answers 200 with a PER-MESSAGE status: one bad address does not
 *  fail the rest, and `ErrorCode: 0` is the only success. */
function sendBatch(send, emails) {
    return __awaiter(this, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (emails.length > 500)
                        return [2 /*return*/, { error: { kind: 'refused', message: 'Postmark takes at most 500 messages per batch', retryable: false } }];
                    return [4 /*yield*/, send({ method: 'POST', path: '/email/batch', body: emails })];
                case 1:
                    r = _a.sent();
                    if (r.error)
                        return [2 /*return*/, { error: translate(r.error) }];
                    return [2 /*return*/, { results: r.data.map(function (x) { return x.ErrorCode === 0 ? { id: x.MessageID } : { error: { kind: x.ErrorCode === 406 ? 'suppressed' : 'refused', code: x.ErrorCode, message: x.Message, retryable: false } }; }) }];
            }
        });
    });
}
function createPostmarkMailer(send, defaults) {
    var raise = function (f) { throw Object.assign(new Error("Postmark: ".concat(f.kind, " \u2014 ").concat(f.message)), { kind: f.kind, retryable: f.retryable }); };
    return {
        send: function (message) {
            return __awaiter(this, void 0, void 0, function () {
                var r;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, sendEmail(send, toPostmarkPayload(message, defaults))];
                        case 1:
                            r = _a.sent();
                            if (r.error)
                                raise(r.error);
                            return [2 /*return*/, { id: r.id, message: 'sent' }];
                    }
                });
            });
        },
        batch: function (messages) {
            return __awaiter(this, void 0, void 0, function () {
                var r;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, sendBatch(send, messages.map(function (m) { return toPostmarkPayload(m, defaults); }))];
                        case 1:
                            r = _a.sent();
                            if (r.error)
                                raise(r.error);
                            return [2 /*return*/, r.results.map(function (x) { return 'id' in x ? { id: x.id, message: 'sent' } : { id: '', message: "failed: ".concat(x.error.message) }; })];
                    }
                });
            });
        },
    };
}
var same = function (a, b) { var x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && (0, node_crypto_1.timingSafeEqual)(x, y); };
/**
 * Postmark signs nothing, so this authenticates the URL: the Basic credential
 * the app embedded in the webhook address, compared constant-time, and an
 * optional allow-list of Postmark's sending addresses. It takes `ip` and
 * `authorization` as inputs because a verifier reads no request.
 */
function verifyPostmarkWebhook(opts) {
    var _a, _b, _c;
    if (!opts.credential)
        return { ok: false, reason: 'no webhook credential is configured on this side' };
    if (!((_a = opts.authorization) === null || _a === void 0 ? void 0 : _a.startsWith('Basic ')))
        return { ok: false, reason: 'no Basic credential on the request' };
    var presented = '';
    try {
        presented = Buffer.from(opts.authorization.slice(6), 'base64').toString('utf8');
    }
    catch (_e) {
        return { ok: false, reason: 'credential is not base64' };
    }
    if (!same(presented, opts.credential))
        return { ok: false, reason: 'credential does not match' };
    if (((_b = opts.allowIps) === null || _b === void 0 ? void 0 : _b.length) && !(opts.ip && opts.allowIps.includes(opts.ip)))
        return { ok: false, reason: "source ".concat((_c = opts.ip) !== null && _c !== void 0 ? _c : '(unknown)', " is not a Postmark address") };
    try {
        var event_1 = JSON.parse(opts.rawBody);
        if (!event_1 || typeof event_1 !== 'object')
            return { ok: false, reason: 'body is not a Postmark payload' };
        return { ok: true, event: event_1 };
    }
    catch (_f) {
        return { ok: false, reason: 'body is not JSON' };
    }
}
// ─── The mail dialect ─────────────────────────────────────────────────────
// What `app.conduit.receive()` takes for Postmark's inbound webhook (FJS-D899,
// FJS-D1091): verify is the URL credential above, parse is the rename from
// Postmark's PascalCase to `ReceivedMail`, and the dedupe key is Postmark's own
// `MessageID` — its id for the DELIVERY, which a retry repeats. The mail's own
// Message-ID is a header like any other, under `headers`. No IP allow-list here:
// a `Delivery` carries no peer address, so an app that wants one grades it at
// the route. A bounce posted at the same path is not a mail and is ignored.
/** Postmark's parsed message as a `ReceivedMail`, or null for a body that is not one. */
function toReceivedMail(b) {
    var _a, _b, _c, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
    if (!b || typeof b !== 'object' || !b.MessageID || typeof b.To !== 'string')
        return null;
    var recipient = ((_f = (_e = (_a = b.OriginalRecipient) !== null && _a !== void 0 ? _a : (_c = (_b = b.ToFull) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.Email) !== null && _e !== void 0 ? _e : b.To.split(',')[0]) !== null && _f !== void 0 ? _f : '').trim();
    if (!recipient)
        return null;
    var fromEmail = ((_j = (_h = (_g = b.FromFull) === null || _g === void 0 ? void 0 : _g.Email) !== null && _h !== void 0 ? _h : b.From) !== null && _j !== void 0 ? _j : '').trim();
    if (!fromEmail)
        return null;
    var headers = Object.fromEntries(((_k = b.Headers) !== null && _k !== void 0 ? _k : []).filter(function (h) { return h === null || h === void 0 ? void 0 : h.Name; }).map(function (h) { var _a; return [h.Name, (_a = h.Value) !== null && _a !== void 0 ? _a : '']; }));
    var attachments = ((_l = b.Attachments) !== null && _l !== void 0 ? _l : []).map(function (a) {
        var _a;
        return (__assign({ filename: a.Name || 'attachment', content: new Uint8Array(Buffer.from((_a = a.Content) !== null && _a !== void 0 ? _a : '', 'base64')), type: a.ContentType || 'application/octet-stream' }, (a.ContentID ? { cid: a.ContentID.replace(/^cid:/, '').replace(/^<|>$/g, '') } : {})));
    });
    return __assign(__assign(__assign(__assign({ recipient: recipient, to: b.To, from: (0, mailbox_1.formatMailbox)(fromEmail, (_o = (_m = b.FromFull) === null || _m === void 0 ? void 0 : _m.Name) !== null && _o !== void 0 ? _o : b.FromName), subject: (_p = b.Subject) !== null && _p !== void 0 ? _p : '' }, (b.Cc ? { cc: b.Cc } : {})), (b.TextBody !== undefined ? { text: b.TextBody } : {})), (b.HtmlBody !== undefined ? { html: b.HtmlBody } : {})), { headers: headers, attachments: attachments });
}
exports.postmarkMailDialect = {
    verify: function (d, cred) {
        var v = verifyPostmarkWebhook({ rawBody: d.rawBody, authorization: d.headers.authorization, credential: cred });
        return v.ok ? { ok: true } : { ok: false, reason: v.reason };
    },
    parse: function (d) {
        var b = d.body;
        if (!b || typeof b !== 'object' || 'RecordType' in b)
            return null;
        var mail = toReceivedMail(b);
        return mail ? { id: b.MessageID, type: 'mail', payload: mail } : null;
    },
    dedupeKey: function (_d, ev) { return ev.id; },
};
/** The suppression a bounce asks for, or null. `Inactive` is Postmark's own verdict. */
function suppressionFor(b) {
    if (b.RecordType === 'SpamComplaint')
        return { email: b.Email, reason: 'complaint' };
    if (b.RecordType === 'Bounce' && b.Inactive)
        return { email: b.Email, reason: 'bounce', detail: b.Description };
    return null;
}
