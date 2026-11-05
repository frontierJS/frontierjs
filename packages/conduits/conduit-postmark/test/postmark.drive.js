
// test/postmark.drive.ts — the connector against the sink. No fixture.
// What only this drive asks: an INBOUND message arrives parsed and is
// authenticated by the credential the app put in the URL, which is all
// Postmark offers; a batch answers per message on a 200; `MessageID` is the
// id FJS-D684 wants; a 406 is a recipient already bounced, not a bad address.
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.hasOwn(s, p))
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
var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
Object.defineProperty(exports, "__esModule", { value: true });
var conduit_1 = require("@frontierjs/conduit");
var testing_1 = require("@frontierjs/conduit/testing");
var sink_ts_1 = require("../sink.ts");
var index_ts_1 = require("../src/index.ts");
var _l = (0, testing_1.results)(), got = _l.got, t = _l.t;
var CRED = 'hook-user:hook-pass-key';
var inbox = [];
var suppressed = [];
var seenIds = [];
var receiver = Bun.serve({
    port: 0,
    fetch: function (req) {
        return __awaiter(this, void 0, void 0, function () {
            var raw, v, id, s;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, req.text()];
                    case 1:
                        raw = _a.sent();
                        v = (0, index_ts_1.verifyPostmarkWebhook)({ rawBody: raw, authorization: req.headers.get('authorization'), credential: CRED, ip: '127.0.0.1', allowIps: ['127.0.0.1'] });
                        if (!v.ok)
                            return [2 /*return*/, Response.json({ error: v.reason }, { status: 401 })];
                        id = 'RecordType' in v.event ? "b-".concat(v.event.ID) : v.event.MessageID;
                        if (seenIds.includes(id))
                            return [2 /*return*/, Response.json({ ok: true, duplicate: true })];
                        seenIds.push(id);
                        if ('RecordType' in v.event) {
                            s = (0, index_ts_1.suppressionFor)(v.event);
                            if (s)
                                suppressed.push({ email: s.email, reason: s.reason });
                        }
                        else
                            inbox.push({ subject: v.event.Subject, from: v.event.From });
                        return [2 /*return*/, Response.json({ ok: true })];
                }
            });
        });
    },
});
var hookUrl = "http://".concat(encodeURIComponent('hook-user'), ":").concat(encodeURIComponent('hook-pass-key'), "@127.0.0.1:").concat(receiver.port, "/webhooks/postmark");
var sink = (0, sink_ts_1.startPostmarkSink)({ hookUrl: hookUrl }), ctl = (0, testing_1.control)(sink.url);
var conduit = (0, conduit_1.createConduit)(__assign({ credentials: (0, conduit_1.createStaticResolver)({ POSTMARK_SERVER_TOKEN: sink.token, POSTMARK_INBOUND: CRED }) }, testing_1.DRIVE_RESILIENCE));
await conduit.register((0, index_ts_1.postmarkTarget)({ address: sink.url }));
var send = (0, index_ts_1.bindSend)(conduit);
var seen = function () { return ctl.seen(); };
var settle = function () { return new Promise(function (r) { return setTimeout(r, 60); }); };
try {
    var payload = (0, index_ts_1.toPostmarkPayload)({ to: ['a@example.com', 'b@example.com'], subject: 'Hi', html: '<img src="cid:chart">', attachments: [{ filename: 'c.png', content: new Uint8Array([1, 2]), type: 'image/png', cid: 'chart' }], tags: { k: 'v', k2: 'v2' } }, { from: 'Shop <no-reply@example.com>', stream: 'outbound' });
    var one = await (0, index_ts_1.sendEmail)(send, payload);
    var wire = (await seen()).requests[0];
    t('send.succeeds', { ok: !one.error, guid: /^[0-9a-f-]{36}$/.test((_a = one.id) !== null && _a !== void 0 ? _a : ''), tokenHeader: wire.headers['x-postmark-server-token'] === sink.token, noAuthorization: !('authorization' in wire.headers), toJoined: JSON.parse(wire.body).To, tag: JSON.parse(wire.body).Tag, cid: JSON.parse(wire.body).Attachments[0].ContentID });
    t('send.inactiveRecipientIsSuppressed', { kind: (_b = (await (0, index_ts_1.sendEmail)(send, __assign(__assign({}, payload), { To: 'gone@inactive.example' }))).error) === null || _b === void 0 ? void 0 : _b.kind, code: (_c = (await (0, index_ts_1.sendEmail)(send, __assign(__assign({}, payload), { To: 'gone@inactive.example' }))).error) === null || _c === void 0 ? void 0 : _c.code });
    t('send.badAddressIsRefused', { kind: (_d = (await (0, index_ts_1.sendEmail)(send, __assign(__assign({}, payload), { To: 'not an address' }))).error) === null || _d === void 0 ? void 0 : _d.kind, code: (_e = (await (0, index_ts_1.sendEmail)(send, __assign(__assign({}, payload), { To: 'not an address' }))).error) === null || _e === void 0 ? void 0 : _e.code });
    var batch = await (0, index_ts_1.sendBatch)(send, [payload, __assign(__assign({}, payload), { To: 'gone@inactive.example' }), __assign(__assign({}, payload), { To: 'c@example.com' })]);
    t('batch.answersPerMessage', { kinds: (_f = batch.results) === null || _f === void 0 ? void 0 : _f.map(function (r) { return 'id' in r ? 'sent' : r.error.kind; }) });
    await ctl.reset();
    await ctl.arm({ lost: true });
    var lost = await (0, index_ts_1.sendEmail)(send, payload);
    var after = await seen();
    t('lostResponse.notReplayed', { kind: (_g = lost.error) === null || _g === void 0 ? void 0 : _g.kind, retryable: (_h = lost.error) === null || _h === void 0 ? void 0 : _h.retryable, emailsSent: after.sent.length, attempts: after.requests.length });
    await ctl.reset();
    await ctl.arm({ rateLimit: { retryAfter: 1 } });
    var rl = await (0, index_ts_1.sendEmail)(send, payload);
    t('rateLimited.handedToCaller', { kind: (_j = rl.error) === null || _j === void 0 ? void 0 : _j.kind, retryAfterMs: (_k = rl.error) === null || _k === void 0 ? void 0 : _k.retryAfterMs });
    var mailer = (0, index_ts_1.createPostmarkMailer)(send, { from: 'no-reply@example.com' });
    var r = await mailer.send({ to: 'd@example.com', subject: 's', text: 't' });
    var thrown = {};
    try {
        await mailer.send({ to: 'gone@inactive.example', subject: 's', text: 't' });
    }
    catch (e) {
        thrown = e;
    }
    t('imail.sendsAndThrowsReadably', { sent: r.message, thrownKind: thrown.kind });
    // Inbound, delivered twice, processed once; authenticated by the URL credential.
    await ctl.reset();
    await ctl.arm({ deliverTwice: true });
    await fetch("".concat(sink.url, "/_sink/inbound"), { method: 'POST', body: JSON.stringify({ from: 'customer@example.org', to: 'support+abc@inbound.example.com', subject: 'Help', text: 'hi', hash: 'abc' }) });
    await settle();
    var ev = (await seen()).events.filter(function (e) { return e.type === 'Inbound'; });
    t('inbound.parsedDeliveredTwiceProcessedOnce', { deliveries: ev.length, answered: ev.map(function (e) { return e.status; }), inbox: inbox });
    await (0, index_ts_1.sendEmail)(send, __assign(__assign({}, payload), { To: 'dead@bounce.example' }));
    await settle();
    t('bounce.writesSuppression', { suppressed: suppressed });
    var body = JSON.stringify({ MessageID: 'x', From: 'a', To: 'b', Subject: 's', Date: 'd' });
    var basic = function (c) { return "Basic ".concat(Buffer.from(c).toString('base64')); };
    t('verify.urlCredential', {
        right: (0, index_ts_1.verifyPostmarkWebhook)({ rawBody: body, authorization: basic(CRED), credential: CRED }).ok,
        wrong: (0, index_ts_1.verifyPostmarkWebhook)({ rawBody: body, authorization: basic('hook-user:nope'), credential: CRED }).ok,
        none: (0, index_ts_1.verifyPostmarkWebhook)({ rawBody: body, authorization: null, credential: CRED }).ok,
        badIp: (0, index_ts_1.verifyPostmarkWebhook)({ rawBody: body, authorization: basic(CRED), credential: CRED, ip: '203.0.113.9', allowIps: ['3.134.147.250'] }).ok,
    });
    // The dialect through conduit's own order (FJS-D899): a delivery applied once, its retry a duplicate,
    // the wrong URL credential one 401, a bounce at the same path ignored; the mail arrives as ReceivedMail.
    var landed_1 = [];
    conduit.receive({
        provider: 'postmark', path: '/mail/postmark', dialect: index_ts_1.postmarkMailDialect, credential: 'POSTMARK_INBOUND',
        apply: function (ev) { var _a; landed_1.push({ recipient: ev.payload.recipient, from: ev.payload.from, messageId: (_a = ev.payload.headers['Message-ID']) !== null && _a !== void 0 ? _a : null }); return 'applied'; },
    });
    var inbound_1 = JSON.stringify({ MessageID: 'pm-1', From: 'ada@example.org', FromFull: { Email: 'ada@example.org', Name: 'Ada, Customer' }, To: 'Support <support+t0k3n@inbound.example.com>', OriginalRecipient: 'support+t0k3n@inbound.example.com', Subject: 'Re: Help', Date: 'd', TextBody: 'thanks', Headers: [{ Name: 'Message-ID', Value: '<m1@example.org>' }] });
    var delivery = function (auth, raw) {
        if (raw === void 0) { raw = inbound_1; }
        return ({ method: 'POST', path: '/mail/postmark', query: '', route: {}, headers: (auth ? { authorization: auth } : {}), rawBody: raw, body: JSON.parse(raw) });
    };
    var nowS = Math.floor(Date.now() / 1000);
    var first = await conduit.accept('/mail/postmark', delivery(basic(CRED)), nowS);
    var again = await conduit.accept('/mail/postmark', delivery(basic(CRED)), nowS);
    var wrong = await conduit.accept('/mail/postmark', delivery(basic('hook-user:nope')), nowS);
    var bounce = await conduit.accept('/mail/postmark', delivery(basic(CRED), JSON.stringify({ RecordType: 'Bounce', ID: 1, MessageID: 'b1', Email: 'x@y.example', Inactive: true, Type: 'HardBounce', TypeCode: 1 })), nowS);
    t('dialect.conduitOrder', { first: first.result, again: again.result, wrong: wrong.status, bounce: bounce.result, landed: landed_1 });
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
    'send.succeeds': { ok: true, guid: true, tokenHeader: true, noAuthorization: true, toJoined: 'a@example.com, b@example.com', tag: 'k:v', cid: 'cid:chart' },
    'send.inactiveRecipientIsSuppressed': { kind: 'suppressed', code: 406 },
    'send.badAddressIsRefused': { kind: 'refused', code: 300 },
    'batch.answersPerMessage': { kinds: ['sent', 'suppressed', 'sent'] },
    'lostResponse.notReplayed': { kind: 'timeout', retryable: false, emailsSent: 1, attempts: 1 },
    'rateLimited.handedToCaller': { kind: 'rate_limited', retryAfterMs: 1000 },
    'imail.sendsAndThrowsReadably': { sent: 'sent', thrownKind: 'suppressed' },
    'inbound.parsedDeliveredTwiceProcessedOnce': { deliveries: 2, answered: [200, 200], inbox: [{ subject: 'Help', from: 'customer@example.org' }] },
    'bounce.writesSuppression': { suppressed: [{ email: 'dead@bounce.example', reason: 'bounce' }] },
    'verify.urlCredential': { right: true, wrong: false, none: false, badIp: false },
    'dialect.conduitOrder': { first: 'applied', again: 'duplicate', wrong: 401, bounce: 'ignored', landed: [{ recipient: 'support+t0k3n@inbound.example.com', from: '"Ada, Customer" <ada@example.org>', messageId: '<m1@example.org>' }] },
}));
