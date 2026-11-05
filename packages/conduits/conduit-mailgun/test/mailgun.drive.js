"use strict";
// test/mailgun.drive.ts — the connector against the sink. No fixture.
// What only this drive asks: an INBOUND message arrives as raw MIME and is
// parsed here — encoded words, quoted-printable, an inline part with a cid —
// the signature covers `timestamp + token` and nothing else, so a replayed
// token is refused and a retry re-signed with a new token is a duplicate by
// Message-ID; a mail with no Message-ID dedupes on its bytes, per recipient.
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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
Object.defineProperty(exports, "__esModule", { value: true });
var conduit_1 = require("@frontierjs/conduit");
var node_crypto_1 = require("node:crypto");
var testing_1 = require("@frontierjs/conduit/testing");
var sink_ts_1 = require("../sink.ts");
var index_ts_1 = require("../src/index.ts");
var _o = (0, testing_1.results)(), got = _o.got, t = _o.t;
var DOMAIN = 'shop.example';
var inbox = [];
var seenKeys = [];
var spent = new Set();
var nowS = function () { return Math.floor(Date.now() / 1000); };
// The app's receiver, by hand: verify, dedupe on recipient + Message-ID, parse the bytes.
var signingKey = '';
var receiver = Bun.serve({
    port: 0,
    fetch: function (req) {
        return __awaiter(this, void 0, void 0, function () {
            var f, _a, _b, _c, v, mail, key;
            var _d, _e, _f;
            return __generator(this, function (_g) {
                switch (_g.label) {
                    case 0:
                        _b = (_a = Object).fromEntries;
                        _c = [[]];
                        return [4 /*yield*/, req.formData()];
                    case 1:
                        f = _b.apply(_a, [__spreadArray.apply(void 0, _c.concat([(_g.sent()), true])).map(function (_a) {
                                var k = _a[0], v = _a[1];
                                return [k, String(v)];
                            })]);
                        v = (0, index_ts_1.verifyMailgunSignature)({ fields: f, key: signingKey, now: nowS(), seenNonce: function (tok) { return spent.has(tok) ? true : (spent.add(tok), false); } });
                        if (!v.ok)
                            return [2 /*return*/, Response.json({ error: v.reason }, { status: 401 })];
                        return [4 /*yield*/, (0, index_ts_1.fromMime)(f['body-mime'], { recipient: f.recipient, sender: f.sender })];
                    case 2:
                        mail = _g.sent();
                        if (!mail)
                            return [2 /*return*/, Response.json({ ok: true, ignored: true })];
                        key = "".concat(f.recipient, " ").concat(mail.headers['Message-ID']);
                        if (seenKeys.includes(key))
                            return [2 /*return*/, Response.json({ ok: true, duplicate: true })];
                        seenKeys.push(key);
                        inbox.push({ subject: mail.subject, from: mail.from, text: ((_d = mail.text) !== null && _d !== void 0 ? _d : '').trim(), inReplyTo: (_e = mail.headers['In-Reply-To']) !== null && _e !== void 0 ? _e : null,
                            attachments: (_f = mail.attachments) === null || _f === void 0 ? void 0 : _f.map(function (a) { var _a; return ({ filename: a.filename, type: a.type, bytes: a.content.length, cid: (_a = a.cid) !== null && _a !== void 0 ? _a : null }); }) });
                        return [2 /*return*/, Response.json({ ok: true })];
                }
            });
        });
    },
});
var sink = (0, sink_ts_1.startMailgunSink)({ hookUrl: "http://127.0.0.1:".concat(receiver.port, "/mail/mailgun/mime") }), ctl = (0, testing_1.control)(sink.url);
signingKey = sink.signingKey;
var conduit = (0, conduit_1.createConduit)(__assign({ credentials: (0, conduit_1.createStaticResolver)({ MAILGUN_API_KEY: "api:".concat(sink.key), MAILGUN_SIGNING_KEY: sink.signingKey }) }, testing_1.DRIVE_RESILIENCE));
await conduit.register((0, index_ts_1.mailgunTarget)({ address: sink.url }));
var send = (0, index_ts_1.bindSend)(conduit);
var seen = function () { return ctl.seen(); };
var settle = function () { return new Promise(function (r) { return setTimeout(r, 60); }); };
var signed = function (fields, o) {
    var _a, _b, _c;
    if (o === void 0) { o = {}; }
    var timestamp = String((_a = o.timestamp) !== null && _a !== void 0 ? _a : nowS()), token = (_b = o.token) !== null && _b !== void 0 ? _b : (0, node_crypto_1.randomBytes)(25).toString('hex');
    return __assign(__assign({}, fields), { timestamp: timestamp, token: token, signature: (0, node_crypto_1.createHmac)('sha256', (_c = o.key) !== null && _c !== void 0 ? _c : sink.signingKey).update(timestamp + token).digest('hex') });
};
try {
    var form = (0, index_ts_1.toMailgunForm)({ to: ['a@example.com', 'b@example.com'], subject: 'Hi', text: 'hello', replyTo: 'support+t0k3n@shop.example', headers: { 'X-Order': '42' }, tags: { kind: 'receipt', order: '42' } }, { from: 'Shop <no-reply@shop.example>' });
    var one = await (0, index_ts_1.sendEmail)(send, DOMAIN, form);
    var wire = (await seen()).requests[0], p = new URLSearchParams(wire.body);
    t('send.succeeds', { ok: !one.error, idShape: /^<[^@]+@shop\.example>$/.test((_a = one.id) !== null && _a !== void 0 ? _a : ''), basic: wire.headers.authorization === "Basic ".concat(Buffer.from("api:".concat(sink.key)).toString('base64')),
        contentType: wire.headers['content-type'], to: p.get('to'), replyTo: p.get('h:Reply-To'), header: p.get('h:X-Order'), tag: p.get('o:tag'), variables: [p.get('v:kind'), p.get('v:order')] });
    t('send.badAddressIsRefused', { kind: (_b = (await (0, index_ts_1.sendEmail)(send, DOMAIN, __assign(__assign({}, form), { to: 'not an address' }))).error) === null || _b === void 0 ? void 0 : _b.kind, message: (_c = (await (0, index_ts_1.sendEmail)(send, DOMAIN, __assign(__assign({}, form), { to: 'not an address' }))).error) === null || _c === void 0 ? void 0 : _c.message });
    t('send.unknownDomainIsGone', { kind: (_d = (await (0, index_ts_1.sendEmail)(send, 'nobody.example', form)).error) === null || _d === void 0 ? void 0 : _d.kind });
    var local = '';
    try {
        (0, index_ts_1.toMailgunForm)({ to: 'a@example.com', subject: 's', text: 't', attachments: [{ filename: 'f', content: 'AQ==' }] }, { from: 'x@shop.example' });
    }
    catch (e) {
        local = e.message;
    }
    t('send.attachmentRefusedBeforeSend', { refused: /not sent/.test(local), attempts: (await seen()).requests.length });
    await ctl.reset();
    await ctl.arm({ lost: true });
    var lost = await (0, index_ts_1.sendEmail)(send, DOMAIN, __assign(__assign({}, form), { 'v:order': '77' }));
    var after = await seen();
    t('lostResponse.notReplayed', { kind: (_e = lost.error) === null || _e === void 0 ? void 0 : _e.kind, retryable: (_f = lost.error) === null || _f === void 0 ? void 0 : _f.retryable, emailsSent: after.sent.length, attempts: after.requests.length });
    var resolved = await (0, index_ts_1.events)(send, DOMAIN, { event: 'accepted', order: '77' });
    t('lostResponse.resolvedByEvents', { landed: (_g = resolved.items) === null || _g === void 0 ? void 0 : _g.length, variable: (_k = (_j = (_h = resolved.items) === null || _h === void 0 ? void 0 : _h[0]) === null || _j === void 0 ? void 0 : _j['user-variables']) === null || _k === void 0 ? void 0 : _k.order });
    await ctl.reset();
    await ctl.arm({ rateLimit: { retryAfter: 1 } });
    var rl = await (0, index_ts_1.sendEmail)(send, DOMAIN, form);
    t('rateLimited.handedToCaller', { kind: (_l = rl.error) === null || _l === void 0 ? void 0 : _l.kind, retryAfterMs: (_m = rl.error) === null || _m === void 0 ? void 0 : _m.retryAfterMs });
    var mailer = (0, index_ts_1.createMailgunMailer)(send, DOMAIN, { from: 'no-reply@shop.example' });
    var r = await mailer.send({ to: 'd@example.com', subject: 's', text: 't' });
    var thrown = {};
    try {
        await mailer.send({ to: 'not an address', subject: 's', text: 't' });
    }
    catch (e) {
        thrown = e;
    }
    t('imail.sendsAndThrowsReadably', { sent: r.message, thrownKind: thrown.kind });
    // Inbound: raw MIME, delivered twice (re-signed), processed once; the hard parts of the bytes decoded.
    await ctl.reset();
    await ctl.arm({ deliverTwice: true });
    await fetch("".concat(sink.url, "/_sink/inbound"), { method: 'POST', body: JSON.stringify({
            from: 'zoe@example.org', fromName: 'Zoë, Customer', to: 'support+t0k3n@inbound.shop.example', subject: 'Ré: Help — ünïcode', text: 'Merci — ça marche ✓\nligne deux',
            messageId: '<m1@example.org>', inReplyTo: '<sent-1@shop.example>',
            attachments: [{ name: 'résumé.pdf', type: 'application/pdf', base64: 'AQID' }, { name: 'logo.png', type: 'image/png', base64: 'AQI=', cid: 'logo' }],
        }) });
    await settle();
    var ev = (await seen()).events;
    t('inbound.rawMimeDeliveredTwiceProcessedOnce', { deliveries: ev.length, answered: ev.map(function (e) { return e.status; }), inbox: inbox });
    var base = { recipient: 'x@inbound.shop.example', sender: 'a@example.org', 'body-mime': 'From: a@example.org\r\nSubject: s\r\n\r\nhi' };
    var nonces_1 = new Set();
    var seenNonce = function (tok) { return nonces_1.has(tok) ? true : (nonces_1.add(tok), false); };
    var replayed = signed(base);
    t('verify.signature', {
        right: (0, index_ts_1.verifyMailgunSignature)({ fields: signed(base), key: sink.signingKey, now: nowS() }).ok,
        wrongKey: (0, index_ts_1.verifyMailgunSignature)({ fields: signed(base, { key: 'key-somebody-else' }), key: sink.signingKey, now: nowS() }).ok,
        stale: (0, index_ts_1.verifyMailgunSignature)({ fields: signed(base, { timestamp: nowS() - 301 }), key: sink.signingKey, now: nowS() }).ok,
        unsigned: (0, index_ts_1.verifyMailgunSignature)({ fields: {}, key: sink.signingKey, now: nowS() }).ok,
        once: (0, index_ts_1.verifyMailgunSignature)({ fields: replayed, key: sink.signingKey, now: nowS(), seenNonce: seenNonce }).ok,
        replayed: (0, index_ts_1.verifyMailgunSignature)({ fields: replayed, key: sink.signingKey, now: nowS(), seenNonce: seenNonce }).ok,
    });
    // The dialect through conduit's own order (FJS-D899): applied once, the re-signed retry a duplicate, a wrong key one 401,
    // a signed form that carries no mail ignored, and the mail arrives as ReceivedMail.
    var landed_1 = [];
    conduit.receive({
        provider: 'mailgun', path: '/mail/mailgun/mime', dialect: index_ts_1.mailgunMailDialect, credential: 'MAILGUN_SIGNING_KEY',
        apply: function (ev) { var _a, _b; landed_1.push({ id: ev.id, recipient: ev.payload.recipient, from: ev.payload.from, to: ev.payload.to, inReplyTo: (_a = ev.payload.headers['In-Reply-To']) !== null && _a !== void 0 ? _a : null, text: (_b = ev.payload.text) === null || _b === void 0 ? void 0 : _b.trim() }); return 'applied'; },
    });
    var delivery = function (fields) { return ({ method: 'POST', path: '/mail/mailgun/mime', query: '', route: {}, headers: {}, rawBody: '', body: fields }); };
    var mime = ['From: Ada <ada@example.org>', 'To: Support <support+t0k3n@inbound.shop.example>', 'Subject: Re: Help', 'Message-Id: <m2@example.org>', 'In-Reply-To: <sent-2@shop.example>', '', 'thanks'].join('\r\n');
    var fields = { recipient: 'support+t0k3n@inbound.shop.example', sender: 'ada@example.org', 'body-mime': mime };
    var first = await conduit.accept('/mail/mailgun/mime', delivery(signed(fields)), nowS());
    var again = await conduit.accept('/mail/mailgun/mime', delivery(signed(fields)), nowS());
    var wrong = await conduit.accept('/mail/mailgun/mime', delivery(signed(fields, { key: 'key-somebody-else' })), nowS());
    var noMail = await conduit.accept('/mail/mailgun/mime', delivery(signed({ recipient: fields.recipient, sender: fields.sender })), nowS());
    t('dialect.conduitOrder', { first: first.result, again: again.result, wrong: wrong.status, noMail: noMail.result, landed: __spreadArray([], landed_1, true) });
    // No Message-ID: the bytes are the key, and a second recipient of the same bytes is its own delivery.
    var bare = { recipient: 'one@inbound.shop.example', sender: 'bob@example.org', 'body-mime': 'From: bob@example.org\r\nSubject: no id\r\n\r\nhi' };
    var b1 = await conduit.accept('/mail/mailgun/mime', delivery(signed(bare)), nowS());
    var b2 = await conduit.accept('/mail/mailgun/mime', delivery(signed(bare)), nowS());
    var b3 = await conduit.accept('/mail/mailgun/mime', delivery(signed(__assign(__assign({}, bare), { recipient: 'two@inbound.shop.example' }))), nowS());
    t('dialect.noMessageIdKeysOnBytes', { first: b1.result, again: b2.result, otherRecipient: b3.result, idShape: /^sha256:[0-9a-f]{64}$/.test(landed_1.at(-1).id) });
    var envelope = { recipient: 'x@inbound.shop.example' };
    var headerless = await (0, index_ts_1.fromMime)('Subject: no from\r\n\r\nbody', __assign(__assign({}, envelope), { sender: 'bounce@example.org' }));
    t('mime.whatIsNotAMail', {
        empty: await (0, index_ts_1.fromMime)('', envelope),
        noRecipient: await (0, index_ts_1.fromMime)('From: a@b.example\r\n\r\nx', { recipient: '' }),
        noSenderAtAll: await (0, index_ts_1.fromMime)('Subject: s\r\n\r\nx', envelope),
        envelopeSender: headerless === null || headerless === void 0 ? void 0 : headerless.from,
        toFallsBack: headerless === null || headerless === void 0 ? void 0 : headerless.to,
    });
}
catch (e) {
    console.error('\nThe drive threw:', e.stack);
    got.__threw = String(e.message);
}
finally {
    sink.stop();
    receiver.stop(true);
    await conduit.destroy();
}
process.exit((0, testing_1.report)(got, {
    'send.succeeds': { ok: true, idShape: true, basic: true, contentType: 'application/x-www-form-urlencoded', to: 'a@example.com, b@example.com', replyTo: 'support+t0k3n@shop.example', header: '42', tag: 'kind:receipt', variables: ['receipt', '42'] },
    'send.badAddressIsRefused': { kind: 'refused', message: "'to' parameter is not a valid address. please check documentation" },
    'send.unknownDomainIsGone': { kind: 'gone' },
    'send.attachmentRefusedBeforeSend': { refused: true, attempts: 4 },
    'lostResponse.notReplayed': { kind: 'timeout', retryable: false, emailsSent: 1, attempts: 1 },
    'lostResponse.resolvedByEvents': { landed: 1, variable: '77' },
    'rateLimited.handedToCaller': { kind: 'rate_limited', retryAfterMs: 1000 },
    'imail.sendsAndThrowsReadably': { sent: 'sent', thrownKind: 'refused' },
    'inbound.rawMimeDeliveredTwiceProcessedOnce': { deliveries: 2, answered: [200, 200], inbox: [{ subject: 'Ré: Help — ünïcode', from: '"Zoë, Customer" <zoe@example.org>', text: 'Merci — ça marche ✓\nligne deux', inReplyTo: '<sent-1@shop.example>',
                attachments: [{ filename: 'résumé.pdf', type: 'application/pdf', bytes: 3, cid: null }, { filename: 'logo.png', type: 'image/png', bytes: 2, cid: 'logo' }] }] },
    'verify.signature': { right: true, wrongKey: false, stale: false, unsigned: false, once: true, replayed: false },
    'dialect.conduitOrder': { first: 'applied', again: 'duplicate', wrong: 401, noMail: 'ignored', landed: [{ id: '<m2@example.org>', recipient: 'support+t0k3n@inbound.shop.example', from: 'Ada <ada@example.org>', to: ['Support <support+t0k3n@inbound.shop.example>'], inReplyTo: '<sent-2@shop.example>', text: 'thanks' }] },
    'dialect.noMessageIdKeysOnBytes': { first: 'applied', again: 'duplicate', otherRecipient: 'applied', idShape: true },
    'mime.whatIsNotAMail': { empty: null, noRecipient: null, noSenderAtAll: null, envelopeSender: 'bounce@example.org', toFallsBack: 'x@inbound.shop.example' },
}));
