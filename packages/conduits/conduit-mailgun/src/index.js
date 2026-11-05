"use strict";
// @frontierjs/conduit-mailgun — Mailgun over conduit.
//
// The third mail vendor, chosen for RAW MIME: a route whose forward URL ends
// in `mime` posts the whole RFC 5322 message as `body-mime` and parses nothing
// for us, so this is the connector that brings the MIME parser (`FJS-D784`,
// `FJS-D1091`) — `fromMime` in ./mime.ts, which a second raw-MIME vendor (SES)
// imports rather than writes.
//
// Auth is HTTP Basic, user `api`, so the built-in `basic` signer fits and the
// credential is the string `api:<key>`. A send is form-encoded and Mailgun
// collapses nothing under any header: unkeyed, unreplayable, a lost response is
// `indeterminate`, and the read that resolves it is `events()` filtered on a
// `v:` variable the caller set (C6).
//
// Two facts about the inbound half the dialect absorbs:
//   - The signature is HMAC-SHA256 over `timestamp + token` with the webhook
//     signing key, and covers NO byte of the body. Inside the window a captured
//     signature verifies over any body, so the window is tight and `token`,
//     random per request, is spent as a nonce through conduit's `seenNonce`.
//     That pair is all that stands behind the body.
//   - There is no delivery id. A retry is a new request with a new token, so
//     the dedupe key is the mail's own Message-ID AND the recipient — one mail
//     to two of our addresses is two deliveries — and a mail with no Message-ID
//     keys on a hash of its bytes, the last stable thing a retry repeats.
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
exports.mailgunMailDialect = exports.MAILGUN_WINDOW_S = exports.MAILGUN_EU_ADDRESS = exports.MAILGUN_ADDRESS = exports.MAILGUN_TARGET = exports.fromMime = void 0;
exports.bindSend = bindSend;
exports.mailgunTarget = mailgunTarget;
exports.translate = translate;
exports.toMailgunForm = toMailgunForm;
exports.sendEmail = sendEmail;
exports.events = events;
exports.createMailgunMailer = createMailgunMailer;
exports.verifyMailgunSignature = verifyMailgunSignature;
var node_crypto_1 = require("node:crypto");
var mime_ts_1 = require("./mime.ts");
__exportStar(require("./types.ts"), exports);
var mime_ts_2 = require("./mime.ts");
Object.defineProperty(exports, "fromMime", { enumerable: true, get: function () { return mime_ts_2.fromMime; } });
exports.MAILGUN_TARGET = 'provider:mailgun';
exports.MAILGUN_ADDRESS = 'https://api.mailgun.net';
exports.MAILGUN_EU_ADDRESS = 'https://api.eu.mailgun.net';
function bindSend(conduit, target) {
    if (target === void 0) { target = exports.MAILGUN_TARGET; }
    return function (req) { return conduit.send(__assign({ target: target }, req)); };
}
/** The credential under `ref` is `api:<key>` — Basic with the fixed user Mailgun reads. An EU account passes `address: MAILGUN_EU_ADDRESS`. */
function mailgunTarget(opts) {
    var _a, _b, _c;
    if (opts === void 0) { opts = {}; }
    return {
        id: (_a = opts.id) !== null && _a !== void 0 ? _a : exports.MAILGUN_TARGET, kind: 'provider', protocol: 'http', address: (_b = opts.address) !== null && _b !== void 0 ? _b : exports.MAILGUN_ADDRESS, encoding: 'form',
        auth: { type: 'signed', signer: 'basic', ref: (_c = opts.ref) !== null && _c !== void 0 ? _c : 'MAILGUN_API_KEY' },
        registered_at: Date.now(), last_seen_at: null,
    };
}
function translate(error, status) {
    var body = null;
    try {
        body = typeof error.raw === 'string' ? JSON.parse(error.raw) : error.raw;
    }
    catch ( /* the 401 is the word Forbidden */_a) { /* the 401 is the word Forbidden */ }
    var message = (body && typeof body === 'object' && body.message) || (typeof error.raw === 'string' && error.raw.trim()) || error.message;
    var base = __assign({ kind: error.kind, message: message, retryable: error.retryable }, (error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}));
    if (error.kind !== 'client_error')
        return base;
    if (status === 404)
        return __assign(__assign({}, base), { kind: 'gone', retryable: false });
    return __assign(__assign({}, base), { kind: 'refused', retryable: false });
}
// ─── Payload ─────────────────────────────────────────────────────────────
var list = function (v) { return v === undefined ? undefined : (Array.isArray(v) ? v : [v]).join(', '); };
function assertNoCrlf(v, what) { if (/[\r\n]/.test(v))
    throw new Error("mailgun: ".concat(what, " contains a line break")); }
function toMailgunForm(msg, defaults) {
    var _a, _b, _c, _e, _f;
    var from = (_a = msg.from) !== null && _a !== void 0 ? _a : defaults.from;
    var to = list(msg.to);
    if (!to)
        throw new Error('mailgun: at least one recipient is required');
    if (!msg.html && !msg.text)
        throw new Error('mailgun: html or text body is required');
    if ((_b = msg.attachments) === null || _b === void 0 ? void 0 : _b.length)
        throw new Error('mailgun: an attachment is not sent — a target has one body encoding and this one is form, and a file needs multipart');
    for (var _i = 0, _g = Object.entries({ from: from, to: to, subject: msg.subject }); _i < _g.length; _i++) {
        var _h = _g[_i], what = _h[0], v = _h[1];
        assertNoCrlf(v, what);
    }
    var form = { from: from, to: to, subject: msg.subject };
    var cc = list(msg.cc);
    if (cc)
        form.cc = cc;
    var bcc = list(msg.bcc);
    if (bcc)
        form.bcc = bcc;
    if (msg.text)
        form.text = msg.text;
    if (msg.html)
        form.html = msg.html;
    var replyTo = (_c = msg.replyTo) !== null && _c !== void 0 ? _c : defaults.replyTo;
    if (replyTo) {
        assertNoCrlf(replyTo, 'replyTo');
        form['h:Reply-To'] = replyTo;
    }
    for (var _j = 0, _k = Object.entries((_e = msg.headers) !== null && _e !== void 0 ? _e : {}); _j < _k.length; _j++) {
        var _l = _k[_j], k = _l[0], v = _l[1];
        assertNoCrlf(k, 'header name');
        assertNoCrlf(v, "headers.".concat(k));
        form["h:".concat(k)] = v;
    }
    var tags = Object.entries((_f = msg.tags) !== null && _f !== void 0 ? _f : {});
    if (tags.length)
        form['o:tag'] = "".concat(tags[0][0], ":").concat(tags[0][1]);
    for (var _m = 0, tags_1 = tags; _m < tags_1.length; _m++) {
        var _o = tags_1[_m], k = _o[0], v = _o[1];
        assertNoCrlf(k, 'tag name');
        assertNoCrlf(v, "tags.".concat(k));
        form["v:".concat(k)] = v;
    }
    return form;
}
var domainPath = function (domain, rest) { return "/v3/".concat(encodeURIComponent(domain), "/").concat(rest); };
/** Unkeyed and unreplayable: a retried send is a second email. A lost response is resolved by `events()`. */
function sendEmail(send, domain, form) {
    return __awaiter(this, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, send({ method: 'POST', path: domainPath(domain, 'messages'), body: form })];
                case 1:
                    r = _a.sent();
                    if (r.error)
                        return [2 /*return*/, { error: translate(r.error, r.meta.status) }];
                    return [2 /*return*/, { id: r.data.id, message: r.data.message }];
            }
        });
    });
}
/**
 * The read that resolves a lost send (C6): Mailgun collapses nothing, so a
 * caller that set a `v:` variable asks here whether a mail carrying it was
 * `accepted`. `query` is Mailgun's own filter grammar, passed through.
 */
function events(send_1, domain_1) {
    return __awaiter(this, arguments, void 0, function (send, domain, query) {
        var r;
        var _a;
        if (query === void 0) { query = {}; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, send({ method: 'GET', path: domainPath(domain, 'events'), query: query })];
                case 1:
                    r = _b.sent();
                    if (r.error)
                        return [2 /*return*/, { error: translate(r.error, r.meta.status) }];
                    return [2 /*return*/, { items: (_a = r.data.items) !== null && _a !== void 0 ? _a : [] }];
            }
        });
    });
}
/** Junction's `IMail` by structure. A refusal is thrown with the failure's fields on the error. */
function createMailgunMailer(send, domain, defaults) {
    var _this = this;
    var one = function (msg) { return __awaiter(_this, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, sendEmail(send, domain, toMailgunForm(msg, defaults))];
                case 1:
                    r = _a.sent();
                    if (r.error)
                        throw Object.assign(new Error("mailgun: ".concat(r.error.message)), r.error);
                    return [2 /*return*/, { id: r.id, message: 'sent' }];
            }
        });
    }); };
    return {
        send: one,
        batch: function (messages) {
            return __awaiter(this, void 0, void 0, function () { var out, _i, messages_1, m, _a, _b; return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        out = [];
                        _i = 0, messages_1 = messages;
                        _c.label = 1;
                    case 1:
                        if (!(_i < messages_1.length)) return [3 /*break*/, 4];
                        m = messages_1[_i];
                        _b = (_a = out).push;
                        return [4 /*yield*/, one(m)];
                    case 2:
                        _b.apply(_a, [_c.sent()]);
                        _c.label = 3;
                    case 3:
                        _i++;
                        return [3 /*break*/, 1];
                    case 4: return [2 /*return*/, out];
                }
            }); });
        },
    };
}
// ─── The webhook signature ───────────────────────────────────────────────
/** How far a signed timestamp may be from now, either way. A retry is re-signed, so the window costs no delivery. */
exports.MAILGUN_WINDOW_S = 300;
/**
 * Pure (C8). Freshness before any crypto; the compare is constant-time with
 * the length checked first; `seenNonce` spends the token so a captured request
 * is refused inside the window it would otherwise verify in. The reason is for
 * the log and never the response.
 */
function verifyMailgunSignature(opts) {
    var _a, _b, _c, _e, _f, _g, _h, _j;
    var window = (_a = opts.windowSeconds) !== null && _a !== void 0 ? _a : exports.MAILGUN_WINDOW_S;
    if (!opts.key)
        return { ok: false, reason: 'no signing key' };
    var timestamp = String((_c = (_b = opts.fields) === null || _b === void 0 ? void 0 : _b.timestamp) !== null && _c !== void 0 ? _c : ''), token = String((_f = (_e = opts.fields) === null || _e === void 0 ? void 0 : _e.token) !== null && _f !== void 0 ? _f : ''), signature = String((_h = (_g = opts.fields) === null || _g === void 0 ? void 0 : _g.signature) !== null && _h !== void 0 ? _h : '');
    if (!timestamp || !token || !signature)
        return { ok: false, reason: 'unsigned: timestamp, token and signature are required' };
    var ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(opts.now - ts) > window)
        return { ok: false, reason: "timestamp ".concat(timestamp, " is outside the ").concat(window, "s window") };
    var expected = Buffer.from((0, node_crypto_1.createHmac)('sha256', opts.key).update(timestamp + token).digest('hex'));
    var given = Buffer.from(signature.toLowerCase());
    if (given.length !== expected.length || !(0, node_crypto_1.timingSafeEqual)(given, expected))
        return { ok: false, reason: 'signature does not match' };
    if ((_j = opts.seenNonce) === null || _j === void 0 ? void 0 : _j.call(opts, token, 2 * window))
        return { ok: false, reason: 'token already seen' };
    return { ok: true };
}
// ─── The dialect ─────────────────────────────────────────────────────────
var form = function (d) { return (d.body && typeof d.body === 'object' ? d.body : {}); };
var sha256 = function (s) { return (0, node_crypto_1.createHash)('sha256').update(s).digest('hex'); };
/** What `app.conduit.receive({ provider: 'mailgun', path, dialect, credential, apply })` takes; the credential is the webhook signing key. */
exports.mailgunMailDialect = {
    verify: function (d, key, ctx) { return verifyMailgunSignature({ fields: form(d), key: key, now: ctx.now, seenNonce: ctx.seenNonce }); },
    parse: function (d) {
        return __awaiter(this, void 0, void 0, function () {
            var f, raw, mail;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        f = form(d);
                        raw = f['body-mime'];
                        if (typeof raw !== 'string' || !raw || !f.recipient)
                            return [2 /*return*/, null];
                        return [4 /*yield*/, (0, mime_ts_1.fromMime)(raw, { recipient: f.recipient, sender: f.sender })];
                    case 1:
                        mail = _a.sent();
                        if (!mail)
                            return [2 /*return*/, null];
                        return [2 /*return*/, { id: mail.headers['Message-ID'] || "sha256:".concat(sha256(raw)), type: 'mail', payload: mail }];
                }
            });
        });
    },
    dedupeKey: function (_d, ev) { return "".concat(ev.payload.recipient.trim().toLowerCase(), " ").concat(ev.id); },
};
